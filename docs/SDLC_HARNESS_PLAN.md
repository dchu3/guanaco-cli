# Plan: Turn guanaco-cli into a Mastra-coordinated SDLC Coding Harness

## Objective

Evolve `guanaco-cli` from a single-shot Ollama chat CLI into a **coding harness** that orchestrates a team of specialized agents — each owning a distinct role in the Software Development Life Cycle (SDLC) — to implement a feature end-to-end. Mastra is used as the coordination framework; models are served by Ollama (local or Ollama Cloud). The existing pi-tui interactive shell becomes the front-end where a developer describes a feature and watches the harness plan → research → implement → review → test.

All work for this initiative happens on the `feature/mastra-sdlc-harness` branch.

## Goals & Non-Goals

**Goals**
- Define SDLC-role agents (Product, Architect, Coder, Reviewer, Tester, Orchestrator) in Mastra.
- Wire each agent to Ollama models — local (`ollama-ai-provider`) or cloud (`ollama-cloud/*` router) — selectable per agent/role.
- Coordinate agents through a Mastra Workflow that takes a feature request and produces diff(s) + tests on a branch.
- Reuse the existing interactive pi-tui shell as the entry point, adding a `/feature` command that kicks off a harness run with streaming per-agent output and human-in-the-loop checkpoints.
- Reuse/repurpose the existing `tools.ts` registry as Mastra `createTool` tool implementations (file read/write, shell exec, grep/glob, branch ops).
- Preserve the existing single-chat mode as a fallback (`/chat`).

**Non-Goals (for this iteration)**
- Cloud provider routing beyond Ollama Cloud (OpenAI/Anthropic etc. can come later).
- Persistent Mastra server deployment / Studio UI integration (kept in-process for now).
- Eval harness and observability beyond `DEBUG` logging (phase 2).

## Background / Key Files & Context

- `src/index.ts` — bootstraps `OllamaClient` + `startCli`. Becomes the harness entry that builds the `Mastra` registry and injects it into the CLI.
- `src/cli.ts` — pi-tui interactive loop with `/help`, `/clear`, `/model`, `!shell`. Gets new `/feature`, `/chat`, `/agents`, `/harness-status` commands and streaming per-agent panels.
- `src/ollama.ts` — hand-rolled Ollama client with streaming + tool-loop. Largely superseded by Mastra's Agent engine + `ollama-ai-provider`, but kept as the thin model adapter for the legacy `/chat` mode and as a reference for tool-call parsing edge cases.
- `src/tools.ts` — empty tool registry scaffold. Becomes the home of Mastra `createTool` definitions (file ops, shell, git).
- `src/config.ts` — env/arg parser. Extended with per-agent model overrides + harness settings.
- `tests/ollama.test.ts` — existing tests; kept green, supplemented by harness unit tests.
- `conductor/` — gitignored working notes; this plan lives in tracked `docs/`.

## Target Architecture

```
┌──────────────────────────── pi-tui Shell (src/cli.ts) ─────────────────────────────┐
│  /feature <prompt>  →  HarnessRunner.run(prompt)  →  streamed per-agent panels      │
│  /chat              →  legacy single-agent mode (OllamaClient)                     │
│  /agents           →  list configured agents + their models                        │
│  !<cmd>            →  direct shell                                                 │
└────────────────────────────────────────┬──────────────────────────────────────────┘
                                         │
              ┌──────────────────────────▼──────────────────────────┐
              │             HarnessRunner (src/harness/runner.ts)      │
              │   resolves feature → drives Mastra Workflow → commits  │
              └──────────────────────────┬──────────────────────────┘
                                         │
        ┌────────────────────────────────▼────────────────────────────────────┐
        │                  Mastra registry (src/mastra/index.ts)               │
        │   agents: orchestrator, product, architect, coder, reviewer, tester  │
        │   workflows: featureImplementation                                  │
        │   tools: file ops, shell, grep, glob, git                            │
        └────────────────────────────────┬────────────────────────────────────┘
                                         │ model selection
        ┌────────────────────────────────▼────────────────────────────────────┐
        │   ModelProvider (src/mastra/models.ts)                               │
        │   • local:  createOllama({ baseURL: OLLAMA_BASE_URL + '/api' })       │
        │   • cloud:  "ollama-cloud/<model>" model router (OLLAMA_API_KEY)     │
        └─────────────────────────────────────────────────────────────────────┘
```

## SDLC Agents (src/mastra/agents/*.ts)

Each agent is a `new Agent({ id, name, instructions, model, tools })` with role-specific system instructions, scoped tools, and a configurable model. Default model mapping keeps coding-heavy roles on capable local models (e.g. `qwen2.5-coder:7b`) and lighter roles on smaller ones.

| Agent | Role in SDLC | Default local model | Scoped tools |
|-------|--------------|----------------------|--------------|
| `orchestrator` | Decomposes the feature into a plan, routes sub-tasks, decides when to loop back to Reviewer/Coder. | `llama3.2` (or `qwen2.5:7b`) | none (planning only) |
| `product` | Clarifies requirements, writes acceptance criteria from the raw prompt; asks the human if ambiguous (suspend/resume). | `llama3.2` | none |
| `architect` | Explores the repo, proposes file-level design + change set; emits a structured design doc (JSON). | `qwen2.5-coder:7b` | `read_file`, `glob`, `grep` |
| `coder` | Implements the change set: edits files, runs linters/builds, fixes compile errors iteratively. | `qwen2.5-coder:7b` | `read_file`, `write_file`, `edit_file`, `shell`, `glob`, `grep` |
| `reviewer` | Diff review against the design + acceptance criteria; returns `approve`/`changes_requested` with a checklist. | `qwen2.5-coder:7b` | `read_file`, `grep`, `git_diff` |
| `tester` | Writes/runs tests, asserts pass; reports failures back to coder. | `qwen2.5-coder:7b` | `read_file`, `write_file`, `shell`, `grep` |

### Agent instruction principles
- Each agent's `instructions` encode its role, output contract (structured JSON or markdown), and a hard rule: *stay within your scoped tools; hand off via the workflow, not free-form chat.*
- Agents are stateless across runs unless explicitly given conversation history by the workflow.
- All agents share a "repo-grounded" preamble: work only inside the repo root, never delete files outside the change set, prefer `edit_file` over full rewrites.

## Coordination: Mastra Workflow (src/mastra/workflows/feature-implementation.ts)

A graph workflow with suspend/resume human-in-the-loop gates. Steps:

1. **intake** (`orchestrator.generate`) — parse the user's feature prompt into a structured task object `{ summary, constraints }`. Suspend → human confirm/refine. Resume.
2. **requirements** (`product.generate`) — produce acceptance criteria + open questions. Suspend for human answers if needed. Resume.
3. **design** (`architect.generate` with file tools) — propose `changeSet: [{ path, action: 'create'|'modify', rationale }]` + a design note.
4. **implement** (`coder` agent loop) — apply the change set via tools, run `npm run build` + lint, iterate up to N steps until green. Emits `artifacts: string[]`.
5. **review** (`reviewer.generate`) — diff vs. design + acceptance criteria → `{ verdict: 'approve'|'changes_requested', notes }`. Branch:
   - `changes_requested` and attempts < MAX_REVIEW_CYCLES → back to **implement** with the reviewer notes.
   - else → **test**.
6. **test** (`tester` agent) — write/run `npm test`; if failures and attempts < MAX_TEST_CYCLES → back to **implement** with failing test summary.
7. **finalize** (`orchestrator.generate`) — summarize changes, create/checkout a `feature/<slug>` branch, `git add -A && git commit`. Suspend → human approves the commit. Resume completes.

Control flow uses Mastra's `.then()`, `.branch()`, and `.suspend()`/`.resume()` primitives. State (artifacts, attempt counters, reviewer notes) is passed through the workflow context and persisted via Mastra storage so a run can be paused and resumed across CLI sessions.

## Tools (src/mastra/tools/*.ts — repurpose src/tools.ts)

Convert the existing `ToolRegistry` shape into Mastra `createTool` definitions. Keep the JSON-schema parameter style already used in `tools.ts`. Implementations wrap Node primitives:

- `read_file` — bounded read (reuse `read` semantics, cap bytes).
- `write_file` — create/overwrite (auto-mkdir).
- `edit_file` — exact-text replacement (mirror the harness's `edit` contract).
- `glob` / `grep` — repo search.
- `shell` — `execAsync` with allowlist + timeout (currently open in `cli.ts`; tighten with a denylist for destructive commands).
- `git_diff`, `git_branch`, `git_commit` — thin wrappers over `shell` scoped to git.

A single `BuildToolRegistryOptions` (already in `tools.ts`) grows to register the SDLC subset; legacy dispatch stays for `/chat` mode.

## Configuration (src/config.ts + .env)

Extend `AppConfig` and `.env.example`:

| Variable | Default | Notes |
|----------|---------|-------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | local endpoint (existing) |
| `OLLAMA_MODEL` | `llama3.2` | default for `/chat` (existing) |
| `OLLAMA_PROVIDER` | `local` | `local` or `cloud` |
| `OLLAMA_API_KEY` | — | required when `cloud` |
| `HARNESS_MODEL_ORCHESTRATOR` | `llama3.2` | per-role overrides |
| `HARNESS_MODEL_ARCHITECT` | `qwen2.5-coder:7b` | |
| `HARNESS_MODEL_CODER` | `qwen2.5-coder:7b` | |
| `HARNESS_MODEL_REVIEWER` | `qwen2.5-coder:7b` | |
| `HARNESS_MODEL_TESTER` | `qwen2.5-coder:7b` | |
| `HARNESS_MAX_REVIEW_CYCLES` | `2` | |
| `HARNESS_MAX_TEST_CYCLES` | `2` | |
| `HARNESS_AUTO_COMMIT` | `0` | if `0`, finalize suspends for human approval |
| `HARNESS_TOOL_TIMEOUT_MS` | `120000` | per `shell` call |

CLI flags mirror these (`--provider`, `--coder-model`, `--auto-commit`, etc.).

## CLI Surface (src/cli.ts)

New commands inside the existing pi-tui loop (keep all current commands working):

- `/feature <prompt>` — start a harness run. Renders one `Markdown` panel per active agent; status line shows current workflow step; spinner while an agent streams. Hooks into Mastra `agent.stream()` for deltas.
- `/resume` — after a suspend checkpoint, send the human's typed answer back into the suspended workflow run.
- `/harness-status` — print current run step, attempt counters, and pending suspend reason.
- `/agents` — list agents + their resolved model + provider.
- `/chat` — explicit entry into legacy single-agent mode (current behavior becomes the default when no harness run is active).
- `!shell` — unchanged.

A small `HarnessView` component (built from existing `Container`/`Markdown`/`Text`) shows each agent's last message and a workflow step indicator. Streaming wires `agent.stream()` chunks into the existing `onAssistantDelta`-style incremental render path already proven in `cli.ts`.

## Implementation Phases

### Phase 0 — Scaffolding (no behavior change)
1. Confirm branch `feature/mastra-sdlc-harness` (done).
2. Add deps: `@mastra/core`, `ollama-ai-provider`, `zod` (tool schemas). Keep `@earendil-works/pi-tui`.
3. Create folder layout: `src/mastra/{index.ts,models.ts,agents/,workflows/,tools/}`.
4. Add `src/harness/runner.ts` stub + `HarnessView` stub (no-op).

### Phase 1 — Model provider + single agent
5. `src/mastra/models.ts`: `getOllamaModel(role)` returning either `ollama.chat(modelId)` (local, baseURL with `/api`) or a model-router string for `ollama-cloud/*`.
6. `src/mastra/agents/coder.ts`: one Agent wired to the coder model + file/shell tools.
7. Convert `tools.ts` handlers to `createTool` for `read_file`, `write_file`, `edit_file`, `shell`, `glob`, `grep`.
8. Wire `/feature` to run **only** the coder agent as a smoke test (no workflow yet); stream output into the TUI. Verify end-to-end on a trivial edit.

### Phase 2 — Full agent team + workflow
9. Add remaining agents (`orchestrator`, `product`, `architect`, `reviewer`, `tester`) with role instructions + scoped tools.
10. Build `featureImplementation` workflow with `.then()/.branch()` and `suspend`/`resume` gates at intake, requirements, and finalize.
11. `HarnessRunner` invokes the workflow, stores the run id, and exposes `resume(input)` / `status()`.
12. Wire `/feature`, `/resume`, `/harness-status` in `cli.ts` with per-agent panels.

### Phase 3 — Safety, tests, docs
13. Tighten `shell` tool: denylist destructive commands, enforce repo-root cwd, cap output bytes.
14. Branch hygiene: harness only ever commits on a `feature/<slug>` branch it creates; never touches `main`/current checked-out branch.
15. Tests: unit tests for `models.ts` provider selection, tool dispatch, and a fake-model integration test for the workflow loop using a stubbed Agent.
16. Update `README.md` + `.env.example` with the harness section, agent table, and env vars.

## Verification & Testing

- `npm run lint` clean; `npm run build` clean.
- `npm test` — existing `tests/ollama.test.ts` stays green; new tests under `tests/mastra/*.test.ts` for model resolution, tool schemas, and workflow step transitions (using a fake model provider).
- Manual smoke: `ollama pull qwen2.5-coder:7b llama3.2`, then `npm run dev` → `/feature "Add a /hello command that prints a greeting"` → confirm intake suspend → `/resume yes` → watch architect/coder/reviewer/tester panels → confirm a new branch with a commit.
- Cloud path: set `OLLAMA_PROVIDER=cloud` + `OLLAMA_API_KEY`, re-run the same smoke.
- Verify `/chat`, `!`, `/model`, `/clear`, `/help` still behave unchanged.

## Rollout / Branch Strategy

- All implementation lands on `feature/mastra-sdlc-harness`.
- Each phase is a separate commit (or PR) so review is tractable:
  - `phase-0: scaffolding`
  - `phase-1: model provider + coder agent`
  - `phase-2: agent team + workflow`
  - `phase-3: safety, tests, docs`
- Merge to `main` only after the cloud + local smoke tests pass and the existing test suite is green.
- The harness itself, when finalized, must create its work on a `feature/<slug>` branch — it must never commit directly to `main` or to the developer's currently checked-out branch.

## Risks & Mitigations

- **Local model quality**: small local models may produce malformed tool calls or JSON. Mitigation: keep the defensive `extractInlineToolCalls` logic from `ollama.ts` as a fallback layer; constrain agent output schemas with `zod` + Mastra structured output; cap review/test cycles.
- **Tool-call loop runaway**: reuse the `maxToolSteps` final-step "drop tools" trick from `ollama.ts` and enforce per-workflow attempt counters.
- **Destructive shell use**: denylist + repo-root cwd + timeout; never `git push` automatically.
- **Mastra API drift**: pin Mastra + `ollama-ai-provider` versions; re-verify against docs before each phase.
- **TUI complexity**: keep `HarnessView` a thin composition of existing pi-tui primitives; avoid new terminal-rendering code.