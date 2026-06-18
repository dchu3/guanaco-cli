import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { SdlcRole } from '../config.js';
import type { SdlcToolRecord, SdlcToolSet } from './tools.js';

export type { SdlcRole };

/**
 * The minimal surface the harness runner needs from an agent. Real Mastra
 * `Agent` instances are wrapped (see `createSdlcAgents`) so the wrapper's
 * `stream()` routes to the right Mastra streaming path — `Agent#stream()` for
 * AI SDK v5+ models, falling back to `Agent#streamLegacy()` for v4 models
 * (e.g. the local `ollama-ai-provider` and the `ollama-cloud/*` router, which
 * Mastra rejects from `stream()` with "AI SDK v4 model … not compatible with
 * stream()"). Tests can provide lightweight stubs that implement only
 * `stream()`.
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

/** Tools each role is permitted to call. Empty = planning-only. */
export const ROLE_TOOLS: Record<SdlcRole, (keyof SdlcToolRecord)[]> = {
  orchestrator: [],
  product: [],
  architect: ['read_file', 'glob', 'grep'],
  coder: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'git_diff'],
  reviewer: ['read_file', 'grep', 'git_diff'],
  tester: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell'],
};

/** Shared preamble every agent sees so the whole team stays repo-grounded. */
const SHARED_PREAMBLE = `You are part of an automated software-development harness operating inside a git repository.
Hard rules:
- Work only inside the repo root. Never touch files outside it.
- Prefer edit_file over write_file for targeted changes.
- Do not run git commit, git push, sudo, or any destructive shell command — the harness handles git commits after human approval.
- When you must run a build/test, use the shell tool.
- Stay within your role. Hand off to the next stage by producing your role's output contract, never by free-form chatting.`;

export const AGENT_INSTRUCTIONS: Record<SdlcRole, string> = {
  orchestrator: `${SHARED_PREAMBLE}

You are the ORCHESTRATOR. Given a raw feature request, decompose it into a concrete plan.
Output contract (markdown):
- "## Summary" — one-paragraph restatement of the feature.
- "## Plan" — a numbered list of the implementation steps the coder should follow.
- "## Risks" — bullet list of risks/unknowns.
Be concise and concrete. Do not write code.`,
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
  coder: `${SHARED_PREAMBLE}

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
  tester: `${SHARED_PREAMBLE}

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

/**
 * Build the six SDLC agents as real Mastra `Agent` instances. Each agent is
 * wired to its role-specific model and scoped tool subset.
 */
export function createSdlcAgents(opts: CreateSdlcAgentsOptions): SdlcAgents {
  const { getModel, toolSet, instructionsOverride } = opts;

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
    // Mastra's `Agent#stream()` is the AI SDK v5 path. v4 models (the local
    // `ollama-ai-provider` and the `ollama-cloud/*` model router) are rejected
    // from `stream()` with "AI SDK v4 model … not compatible with stream()";
    // `Agent#streamLegacy()` is the v4 path and returns the same
    // `{ textStream, text }` the harness consumes, accepting the same options
    // (`maxSteps`, `toolChoice`). Try v5 first (optimal for v5 models, including
    // the test mock), then fall back to v4 on the incompatibility error so both
    // providers work without branching on config.
    return {
      id: role,
      stream: async (messages, options) => {
        try {
          return await (agent.stream(messages, options as never) as Promise<AgentStreamLike>);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not compatible with stream|AI SDK v4/i.test(msg)) {
            try {
              return await (agent.streamLegacy(messages, options as never) as Promise<AgentStreamLike>);
            } catch (legacyErr) {
              throw new Error(
                `Agent "${name}" model is incompatible with both stream() and streamLegacy(): ${
                  legacyErr instanceof Error ? legacyErr.message : String(legacyErr)
                }`,
              );
            }
          }
          throw err;
        }
      },
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