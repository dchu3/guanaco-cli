export type OllamaProviderMode = 'local' | 'cloud';

export type SdlcRole =
  | 'orchestrator'
  | 'product'
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'tester';

export interface HarnessConfig {
  /** 'local' uses ollama-ai-provider against OLLAMA_BASE_URL; 'cloud' uses the ollama-cloud/* model router. */
  provider: OllamaProviderMode;
  /** API key for Ollama Cloud (required when provider === 'cloud'). */
  ollamaApiKey?: string;
  /** Per-role model overrides (falls back to OLLAMA_MODEL / role defaults). */
  roleModels: Partial<Record<SdlcRole, string>>;
  /** Max times review can request changes before forcing a proceed. */
  maxReviewCycles: number;
  /** Max times test can fail before forcing a proceed. */
  maxTestCycles: number;
  /** Max product ⇄ architect refinement rounds during planning (0 = just
   *  product→architect, no back-and-forth). */
  maxPlanCycles: number;
  /** Max agentic tool-loop steps per agent turn. */
  maxAgentSteps: number;
  /** Max streamed bytes per agent turn before truncation/abort (safety cap). */
  maxTurnOutputBytes: number;
  /** Max total wall-clock time for a harness run (ms); 0 disables. */
  maxWallClockMs: number;
  /** When false, the finalize step auto-commits without asking the human. */
  humanInLoopFinalize: boolean;
  /** When true, the intake step pauses for the human to confirm/refine the feature. */
  humanInLoopIntake: boolean;
  /** Per shell-tool-call timeout (ms). */
  toolTimeoutMs: number;
  /** Per agent-turn *inactivity* timeout (ms); 0 disables. Aborts a turn
   *  only when no tokens have streamed for this long — i.e. a stalled LLM
   *  stream — rather than capping the turn's total wall-clock. A productive
   *  turn that keeps streaming (or is running tool calls up to
   *  `toolTimeoutMs`) is not penalised for being long. Must be greater than
   *  `toolTimeoutMs` so a legitimate tool call isn't mistaken for a stall. */
  agentTurnTimeoutMs?: number;
  /** Per agent-turn *hard* wall-clock cap (ms); 0 disables. Bounds a runaway
   *  turn that never stalls but never finishes. Distinct from
   *  `agentTurnTimeoutMs` (inactivity): this one is never reset.
   *  Defaults to 10 minutes so a technically-active but never-ending stream is
   *  always capped unless explicitly disabled. */
  agentTurnHardTimeoutMs?: number;
  /** Repo root the harness is allowed to operate inside. */
  repoRoot: string;
  /** When true, the harness may run `git commit` itself after human approval. */
  autoCommit: boolean;
  /** When true and autoCommit is on, a dirty working tree is auto-stashed
   *  before the run and restored afterwards instead of hard-blocking with
   *  'dirty-tree'. Set to 0 to restore the strict "commit/stash first" guard. */
  autoStash: boolean;
}

export interface AppConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt?: string;
  requestTimeoutMs: number;
  streamEnabled: boolean;
  temperature?: number;
  topP?: number;
  numCtx?: number;
  harness: HarnessConfig;
}

function intEnv(name: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`Env var ${name} must be >= ${opts.min}, got: ${n}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`Env var ${name} must be <= ${opts.max}, got: ${n}`);
  }
  return n;
}

function floatEnv(name: string, def?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} must be a number, got: ${raw}`);
  }
  return n;
}

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Env var ${name} must be a boolean (1/0/true/false), got: ${raw}`);
}

function parseBool(raw: string, label: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${label} must be a boolean (1/0/true/false), got: ${raw}`);
}

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) {
    const val = process.argv[index + 1].trim();
    if (val && !val.startsWith('-')) return val;
  }
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length).trim();
  return undefined;
}

export function loadConfig(): AppConfig {
  let ollamaModel = process.env.OLLAMA_MODEL?.trim() || 'qwen3.5:0.8b';

  const modelArg = getArgValue('--model');
  if (modelArg) {
    ollamaModel = modelArg;
  } else {
    // Fallback: use the first positional argument as the model if it's not a flag
    const positionalModel = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
    if (positionalModel) {
      ollamaModel = positionalModel.trim();
    }
  }

  const temperatureRaw = getArgValue('--temperature');
  const temperature =
    temperatureRaw !== undefined
      ? Number(temperatureRaw)
      : floatEnv('OLLAMA_TEMPERATURE');
  if (temperature !== undefined && !Number.isFinite(temperature)) {
    throw new Error(`Invalid temperature value: ${temperatureRaw}`);
  }

  const topPRaw = getArgValue('--top-p');
  const topP = topPRaw !== undefined ? Number(topPRaw) : floatEnv('OLLAMA_TOP_P');
  if (topP !== undefined && !Number.isFinite(topP)) {
    throw new Error(`Invalid top-p value: ${topPRaw}`);
  }

  const numCtxRaw = getArgValue('--num-ctx');
  const numCtx = numCtxRaw !== undefined ? Number(numCtxRaw) : floatEnv('OLLAMA_NUM_CTX');
  if (numCtx !== undefined && (!Number.isFinite(numCtx) || !Number.isInteger(numCtx))) {
    throw new Error(`Invalid num-ctx value: ${numCtxRaw}`);
  }

  const providerRaw = (getArgValue('--provider') ?? process.env.OLLAMA_PROVIDER ?? 'local')
    .trim()
    .toLowerCase();
  if (providerRaw !== 'local' && providerRaw !== 'cloud') {
    throw new Error(`OLLAMA_PROVIDER must be 'local' or 'cloud', got: ${providerRaw}`);
  }
  const provider = providerRaw as OllamaProviderMode;
  const ollamaApiKey = process.env.OLLAMA_API_KEY?.trim() || undefined;
  if (provider === 'cloud' && !ollamaApiKey) {
    throw new Error('OLLAMA_API_KEY is required when OLLAMA_PROVIDER=cloud');
  }

  const roleModels: Partial<Record<SdlcRole, string>> = {};
  const roleEnv: Record<SdlcRole, string> = {
    orchestrator: 'HARNESS_MODEL_ORCHESTRATOR',
    product: 'HARNESS_MODEL_PRODUCT',
    architect: 'HARNESS_MODEL_ARCHITECT',
    coder: 'HARNESS_MODEL_CODER',
    reviewer: 'HARNESS_MODEL_REVIEWER',
    tester: 'HARNESS_MODEL_TESTER',
  };
  for (const role of Object.keys(roleEnv) as SdlcRole[]) {
    const v = getArgValue(`--${role}-model`) ?? process.env[roleEnv[role]];
    if (v) roleModels[role] = v.trim();
  }

  const autoCommitArg = getArgValue('--auto-commit');
  const autoCommit =
    autoCommitArg !== undefined
      ? parseBool(autoCommitArg, '--auto-commit')
      : boolEnv('HARNESS_AUTO_COMMIT', true);

  const autoStashArg = getArgValue('--auto-stash');
  const autoStash =
    autoStashArg !== undefined
      ? parseBool(autoStashArg, '--auto-stash')
      : boolEnv('HARNESS_AUTO_STASH', true);

  const harness: HarnessConfig = {
    provider,
    ollamaApiKey,
    roleModels,
    maxReviewCycles: intEnv('HARNESS_MAX_REVIEW_CYCLES', 4, { min: 0, max: 10 }),
    maxTestCycles: intEnv('HARNESS_MAX_TEST_CYCLES', 4, { min: 0, max: 10 }),
    maxPlanCycles: intEnv('HARNESS_MAX_PLAN_CYCLES', 0, { min: 0, max: 5 }),
    maxAgentSteps: intEnv('HARNESS_MAX_AGENT_STEPS', 12, { min: 1, max: 50 }),
    maxTurnOutputBytes: intEnv('HARNESS_MAX_TURN_OUTPUT_BYTES', 1_000_000, { min: 1_000 }),
    maxWallClockMs: intEnv('HARNESS_MAX_WALL_CLOCK_MS', 0, { min: 0 }),
    humanInLoopFinalize: !autoCommit,
    humanInLoopIntake: boolEnv('HARNESS_HUMAN_IN_LOOP_INTAKE', false),
    toolTimeoutMs: intEnv('HARNESS_TOOL_TIMEOUT_MS', 300_000, { min: 1000 }),
    agentTurnTimeoutMs: intEnv('HARNESS_AGENT_TIMEOUT_MS', 300_000, { min: 0 }),
    agentTurnHardTimeoutMs: intEnv('HARNESS_AGENT_HARD_TIMEOUT_MS', 600_000, { min: 0 }),
    repoRoot: process.env.HARNESS_REPO_ROOT?.trim() || process.cwd(),
    autoCommit,
    autoStash,
  };

  return {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel,
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    streamEnabled: boolEnv('STREAM_ENABLED', true),
    temperature,
    topP,
    numCtx,
    harness,
  };
}
