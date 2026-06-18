# Plan: Fix "AI SDK v4 model … not compatible with stream()" harness error

## Symptom

Running `/feature <prompt>` aborts immediately with:

```
Harness error: Agent "Orchestrator" is using AI SDK v4 model
(ollama.chat:<model>) which is not compatible with stream().
Please use AI SDK v5+ models or call the streamLegacy() method instead.
See https://mastra.ai/en/docs/streaming/overview for more information.
```

The whole harness run dies on the first agent turn — none of the SDLC agents
ever run.

## Root cause (verified in code + installed packages)

- `src/harness/runner.ts` `callAgent()` drives every agent with
  `await this.agents[role].stream(prompt, { maxSteps, toolChoice })`.
- `src/mastra/agents.ts` `createSdlcAgents()` builds real Mastra `Agent`
  instances and returns them directly as `SdlcAgents`. Mastra's
  `Agent#stream()` is the **AI SDK v5** streaming path.
- `src/mastra/models.ts` wires local models through `ollama-ai-provider`
  (`createOllama(...).chat(modelId)`), which is an **AI SDK v4** provider
  (`ollama-ai-provider@1.2.0`). Mastra detects the v4 model on `stream()` and
  throws the error above.
- `@mastra/core@1.43.0` ships both paths: `Agent#stream()` (v5) and
  `Agent#streamLegacy()` (v4). `streamLegacy(messages, args?)` returns a
  `StreamTextResult` with the same `textStream` (async-iterable) and `text`
  (`Promise<string>`) the harness already consumes, and accepts the same
  `AgentStreamOptions` fields we pass (`maxSteps`, `toolChoice`). It is the
  supported path for v4 providers like the local Ollama one.

So the harness is calling the v5 entry point on a v4 model. The fix is to call
the v4 entry point instead.

## Goals & Non-Goals

**Goals**
- Make `/feature` work with the local `ollama-ai-provider` (AI SDK v4) models
  the user actually runs, by routing agent turns through `streamLegacy()`.
- Keep the harness's live per-agent streaming UI (`onAgentDelta`) working.
- Keep tool-using agents (Architect/Coder/Reviewer/Tester) working through the
  v4 agentic loop (`maxSteps` + `toolChoice` + the agent's scoped tools).
- Preserve the `AgentLike` abstraction so `HarnessRunner` and its unit tests
  are unchanged (tests stub `AgentLike.stream`).

**Non-Goals (for this iteration)**
- No migration to an AI SDK v5+ Ollama provider — there isn't a v5 local
  Ollama provider available; `ollama-ai-provider` is v4. (Noted as a future
  option if one ships.)
- No changes to the legacy `/chat` path (`src/ollama.ts`), which uses raw
  `fetch` against `/api/chat` and is unaffected.
- No structured-output / object streaming changes — the harness only consumes
  the text stream.

## Target Design

### Route `.stream()` on the abstraction to `Agent#streamLegacy()` (in `agents.ts`)

Keep `AgentLike` and the runner unchanged. In `createSdlcAgents()`, wrap each
Mastra `Agent` so the wrapper's `stream(messages, options)` delegates to
`agent.streamLegacy(messages, options)`. This isolates the v4/v5 quirk in one
file and leaves `HarnessRunner` + `tests/harness/runner.test.ts` untouched
(they already stub `AgentLike.stream`).

```ts
// src/mastra/agents.ts
function makeAgent(role: SdlcRole, name: string): AgentLike {
  const tools = toolSet.subset(ROLE_TOOLS[role] as string[]);
  const hasTools = Object.keys(tools).length > 0;
  const agent = new Agent({
    id: role,
    name,
    instructions: instructionsOverride?.[role] ?? AGENT_INSTRUCTIONS[role],
    model: getModel(role),
    maxRetries: 1,
    ...(hasTools ? { tools: tools as never } : {}),
  });
  // ollama-ai-provider is AI SDK v4, so route through Mastra's v4 streaming
  // path. The result has the same { textStream, text } the runner consumes.
  return {
    id: role,
    stream: (messages, options) =>
      agent.streamLegacy(messages, options as Record<string, unknown> | undefined) as Promise<AgentStreamLike>,
  };
}
```

Notes:
- `streamLegacy`'s declared return is `Promise<StreamTextResult<any, …>>`,
  which structurally has `textStream: AsyncIterable<string>` and
  `text: Promise<string>` — matching `AgentStreamLike`. A cast keeps the
  abstraction tidy without leaking AI SDK types into `AgentLike`.
- `streamLegacy(messages, args?)` accepts `MessageListInput` (a bare string is
  accepted — the current `.stream(prompt)` already relies on this) and
  `AgentStreamOptions` with `maxSteps` + `toolChoice`, so the runner's
  `streamOptions` pass through unchanged.
- Update the `AgentLike` doc comment: real Mastra agents are now **wrapped** to
  expose `stream()` (backed by `streamLegacy`), not returned directly.

### Defensive error message

If `streamLegacy` is ever missing or throws a v4/v5 incompatibility error,
surface a clear, actionable message from `callAgent` (e.g. "agent model is
incompatible with streaming; check OLLAMA_PROVIDER/model config") instead of
the raw Mastra text. Small `try/catch` around the `streamLegacy` call in
`agents.ts` wrapper, rethrowing a wrapped `Error`.

## Key Files & Context

- `src/mastra/agents.ts` — `createSdlcAgents`: wrap agents so `.stream()`
  delegates to `streamLegacy()`; refresh the `AgentLike` comment; add the
  defensive wrap error.
- `src/harness/runner.ts` — **no change** (still calls `agents[role].stream(…)`).
- `src/mastra/models.ts` — **no change** (still returns the v4
  `ollama-ai-provider` model for local; cloud returns the model-router id).
- `tests/harness/runner.test.ts` — **no change** (stubs `AgentLike.stream`).
- `tests/mastra/agents.test.ts` — add a test that `createSdlcAgents` returns
  wrappers whose `stream()` calls `streamLegacy` (not `stream`) on a fake
  `Agent`, and forwards `messages` + `options`.

## Implementation Steps

1. `git checkout -b fix/agent-stream-legacy` *(done — this branch).*
2. Edit `src/mastra/agents.ts`:
   - wrap each `Agent` so `stream()` → `agent.streamLegacy(...)`;
   - refresh the `AgentLike` doc comment;
   - wrap the call so an incompatibility throws a clear message.
3. Add a unit test in `tests/mastra/agents.test.ts`: construct a fake `Agent`
   class with `stream` and `streamLegacy` spies, run `createSdlcAgents`, call
   the wrapper's `stream()`, and assert `streamLegacy` was called with the
   given messages + options while `stream` was not.
4. `npm run lint`, `npm run build`, `npm test` (expect all green, incl. the
   existing `tests/harness/runner.test.ts` which is unchanged).
5. Manual smoke test with a local Ollama model:
   - `guanaco` → `/feature create a simple nodejs hello world app on a new
     branch` → confirm the Orchestrator streams and the run proceeds past
     intake into requirements/design (no "not compatible with stream()" error).
6. Commit + push the branch; open a PR.

## Risks & Notes

- **Tool agents under `streamLegacy`**: the v4 `streamText` supports tools +
  `maxSteps` (the agentic loop), and `AgentStreamOptions` exposes both, so
  Architect/Coder/Reviewer/Tester should behave as before. The manual smoke
  test (step 5) must confirm a tool-using agent actually calls tools; if a
  tool agent misbehaves, the fallback is `generateLegacy` (non-streaming) for
  tool turns while keeping `streamLegacy` for planning-only turns — but try
  `streamLegacy` uniformly first.
- **Type cast**: the `as Promise<AgentStreamLike>` cast relies on the v4
  `StreamTextResult` having `textStream` + `text` (it does). If a future
  `@mastra/core` bumps the legacy result shape, the cast hides the mismatch —
  mitigated by the unit test asserting the wrapper delegates and by the
  manual smoke test asserting real streaming output.
- **Cloud path**: `OLLAMA_PROVIDER=cloud` returns the `ollama-cloud/*`
  model-router id. If that router is v5-compatible, `streamLegacy` still works
  (legacy is a superset path) but is slightly less optimal; acceptable, and
  keeps one code path for both providers. If a v5 cloud model ever rejects
  `streamLegacy`, we'd branch on `cfg.provider` then — not needed now.
- **Alternative rejected**: switching to `generate()`/`generateLegacy()` would
  lose the live `onAgentDelta` streaming panels the UI relies on, so streaming
  is preserved via `streamLegacy`.