import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { SdlcRole } from '../config.js';
import type { SdlcToolRecord, SdlcToolSet } from './tools.js';

export type { SdlcRole };

/**
 * The minimal surface the harness runner needs from an agent. Real Mastra
 * `Agent` instances are wrapped (see `createSdlcAgents`) so `stream()` routes
 * to the right Mastra streaming path — `Agent#stream()` for AI SDK v5+ models,
 * `Agent#streamLegacy()` for v4 models (e.g. the local `ollama-ai-provider`
 * and `ollama-cloud/*` models that report as v4). Routing is deterministic via
 * `isV4Model` for v1 models, with a try/catch fallback to `streamLegacy()`
 * when a cloud model reports v4 only at call time. Tests can provide lightweight
 * stubs that implement only `stream()`.
 */
export interface AgentLike {
  readonly id: string;
  stream(messages: string, options?: unknown): Promise<AgentStreamLike>;
}

export interface AgentStreamLike {
  readonly textStream: AsyncIterable<string>;
  readonly text: Promise<string>;
}

export type SdlcAgents = Record<SdlcRole, AgentLike>;

/**
 * The subset of a Mastra `Agent` that `routeAgentStream` calls. Both methods
 * return an object structurally compatible with `AgentStreamLike`.
 */
export interface AgentStreamMethods {
  stream(messages: unknown, options?: unknown): Promise<AgentStreamLike>;
  streamLegacy(messages: unknown, options?: unknown): Promise<AgentStreamLike>;
}

/**
 * AI SDK v4 providers (e.g. `ollama-ai-provider`, `specificationVersion 'v1'`)
 * are incompatible with Mastra's `Agent#stream()` (the AI SDK v5 path) and must
 * go through `Agent#streamLegacy()`. v5 models (`specificationVersion 'v2'`)
 * and the cloud model-router config (a plain `{ id, apiKey }` with no
 * `specificationVersion`) use `stream()`.
 */
export function isV4Model(model: unknown): boolean {
  return (model as { specificationVersion?: string } | null | undefined)?.specificationVersion === 'v1';
}

/**
 * Build the `stream` function for an `AgentLike` that routes to the correct
 * Mastra entry point based on the model's AI SDK version. Extracted so the
 * routing is unit-testable without constructing a real `Agent`.
 */
export function routeAgentStream(agent: AgentStreamMethods, model: unknown): AgentLike['stream'] {
  const useLegacy = isV4Model(model);
  return async (messages, options) => {
    if (useLegacy) {
      return agent.streamLegacy(messages, options) as Promise<AgentStreamLike>;
    }
    // v5/cloud: try stream() first. Some ollama-cloud models report as AI SDK
    // v4 only at call time (the router config has no `specificationVersion`, so
    // `isV4Model` can't pre-detect them) and Mastra rejects them from stream()
    // with "AI SDK v4 model … not compatible with stream()". Fall back to
    // streamLegacy() then; an AbortError (Esc) propagates as-is.
    try {
      return await (agent.stream(messages, options) as Promise<AgentStreamLike>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not compatible with stream|AI SDK v4/i.test(msg)) throw err;
      try {
        return await (agent.streamLegacy(messages, options) as Promise<AgentStreamLike>);
      } catch (legacyErr) {
        const lmsg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        if (legacyErr instanceof Error && (legacyErr.name === 'AbortError' || /abort/i.test(lmsg))) {
          throw legacyErr;
        }
        throw new Error(`model is incompatible with both stream() and streamLegacy(): ${lmsg}`);
      }
    }
  };
}

/** Tools each role is permitted to call. Empty = planning-only. */
export const ROLE_TOOLS: Record<SdlcRole, (keyof SdlcToolRecord)[]> = {
  orchestrator: [],
  product: [],
  architect: ['read_file', 'glob', 'grep'],
  coder: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'git_diff'],
  reviewer: ['read_file', 'grep', 'git_diff'],
  tester: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell'],
};

/** Shared preamble every agent sees so the whole team stays repo-grounded.
 *  It deliberately does NOT mention the shell tool; only coder/tester are allowed
 *  shell, and their instructions extend this with shell guidance. */
const SHARED_PREAMBLE = `You are part of an automated software-development harness operating inside a git repository.
Hard rules:
- Work only inside the repo root. Never touch files outside it.
- Prefer edit_file over write_file for targeted changes. edit_file edits use the keys "oldText" and "newText" ("old"/"new" and "find"/"replace" are accepted as aliases).
- Do not run git commit, git push, sudo, or any destructive shell command — the harness handles git commits after human approval.
- Formatting: ALWAYS put shell commands, code, and file contents in fenced code blocks (e.g. \`\`\`bash) on their OWN lines, separated by a blank line from prose. Never run a command or code inline with a sentence.
- Stay within your role. Hand off to the next stage by producing your role's output contract, never by free-form chatting.
- Do not invent tool names. If a tool you need is not in your allowed list, stop and report what is missing instead of calling it.`;

/** Extra guidance only for roles that actually have the shell tool. */
const SHELL_GUIDANCE = `\n- When you must run a build/test, use the shell tool.`;

export const AGENT_INSTRUCTIONS: Record<SdlcRole, string> = {
  orchestrator: `${SHARED_PREAMBLE}

You are the ORCHESTRATOR. You do not plan the work — product and architect do that. Your job is to write the final summary of a completed harness run for the human to review.
Output contract (markdown):
- "## Summary" — one-paragraph restatement of what was implemented.
- "## Outcomes" — reviewer and tester verdicts, and anything outstanding.
Be concise. Do not write code.`,
  product: `${SHARED_PREAMBLE}

You are the PRODUCT analyst. Turn the feature request into acceptance criteria.
Output contract (markdown):
- "## Acceptance Criteria" — a checklist of testable criteria.
- "## Open Questions" — bullet list; if none, write "None".
Do not design or write code.`,
  architect: `${SHARED_PREAMBLE}

You are the ARCHITECT. Explore the repo with read_file/glob/grep, then propose a change set.
Output contract (markdown):
- "## Design" — short rationale.
- "## Change Set" — a bullet list of \`<path>: <create|modify> — <why>\`.
Do not edit files.`,
  coder: `${SHARED_PREAMBLE}${SHELL_GUIDANCE}

You are the CODER. Implement the change set using your tools. After editing, run the build/lint via the shell tool and fix any errors you introduced. Iterate until the build is green (or you are stuck).
Output contract (markdown):
- "## Changes" — bullet list of files you modified and what you did.
- "## Build" — the final build/lint status line.
If you are revisiting work after review/test feedback, address the notes at the top, then re-run the build.`,
  reviewer: `${SHARED_PREAMBLE}

You are the REVIEWER. Compare the current diff (use git_diff/read_file) against the design and acceptance criteria.
Output contract (markdown):
- "## Findings" — bullet list of issues (or "None").
- "## Verdict" — exactly one line, one of: "APPROVE" or "CHANGES_REQUESTED".
Use "CHANGES_REQUESTED" only when there are concrete blocking issues; otherwise "APPROVE".`,
  tester: `${SHARED_PREAMBLE}${SHELL_GUIDANCE}

You are the TESTER. Write or update tests for the change and run them via the shell tool (e.g. \`npm test\`).
Output contract (markdown):
- "## Tests" — what you added/changed.
- "## Results" — the test run summary.
- "## Verdict" — exactly one line, one of: "TESTS_PASSED" or "TESTS_FAILED".
"TESTS_FAILED" only when there are real failures you could not fix; otherwise "TESTS_PASSED".`,
};

export interface CreateSdlcAgentsOptions {
  /** Resolve a Mastra model for each role. */
  getModel: (role: SdlcRole) => MastraModelConfig;
  /** Full tool set; each agent gets the subset from ROLE_TOOLS. */
  toolSet: SdlcToolSet;
  /** Optional override of the instructions per role (for tests). */
  instructionsOverride?: Partial<Record<SdlcRole, string>>;
}

/** Build a concise, role-specific reminder of which tools are (not) available.
 *  This is appended to every agent's instructions so models cannot plausibly
 *  claim they "forgot" they lacked a tool such as shell. */
export function buildToolRestriction(role: SdlcRole): string {
  const allowed = ROLE_TOOLS[role];
  if (!allowed || allowed.length === 0) {
    return '\nTool restriction: You have NO tools available. Do not call any tools; work only from the provided context.';
  }
  return `\nTool restriction: You may ONLY call these tools: ${allowed.join(', ')}. Do not call any other tool name.`;
}

/**
 * Build the six SDLC agents as real Mastra `Agent` instances. Each agent is
 * wired to its role-specific model and scoped tool subset.
 */
export function createSdlcAgents(opts: CreateSdlcAgentsOptions): SdlcAgents {
  const { getModel, toolSet, instructionsOverride } = opts;

  function makeAgent(role: SdlcRole, name: string): AgentLike {
    const tools = toolSet.subset(ROLE_TOOLS[role] as string[]);
    const hasTools = Object.keys(tools).length > 0;
    const model = getModel(role);
    const baseInstructions = instructionsOverride?.[role] ?? AGENT_INSTRUCTIONS[role];
    const instructions = `${baseInstructions}${buildToolRestriction(role)}`;
    const agent = new Agent({
      id: role,
      name,
      instructions,
      model,
      maxRetries: 1,
      ...(hasTools ? { tools: tools as never } : {}),
    });
    // Route to streamLegacy() for AI SDK v4 models (ollama-ai-provider) and
    // stream() for v5/cloud — see isV4Model/routeAgentStream.
    return {
      id: role,
      stream: routeAgentStream(agent as unknown as AgentStreamMethods, model),
    };
  }

  return {
    orchestrator: makeAgent('orchestrator', 'Orchestrator'),
    product: makeAgent('product', 'Product'),
    architect: makeAgent('architect', 'Architect'),
    coder: makeAgent('coder', 'Coder'),
    reviewer: makeAgent('reviewer', 'Reviewer'),
    tester: makeAgent('tester', 'Tester'),
  };
}