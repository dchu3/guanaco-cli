export interface AppConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt?: string;
  requestTimeoutMs: number;
  streamEnabled: boolean;
  temperature?: number;
  topP?: number;
  numCtx?: number;
  // When true, ask Ollama to emit the model's reasoning (qwen3 `imd…` blocks).
  // Defaults to false so chat output stays clean. Requires Ollama >= 0.9.
  think: boolean;
  // Optional cap on generated tokens per reply.
  numPredict?: number;
  // App title shown in the top-right of the TUI header.
  appTitle: string;
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

/** Optional integer env var: returns undefined when unset/empty. */
function intEnvOptional(name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
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
  let ollamaModel = process.env.OLLAMA_MODEL?.trim() || 'qwen2.5:0.5b';

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
    temperatureRaw !== undefined ? Number(temperatureRaw) : floatEnv('OLLAMA_TEMPERATURE');
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

  // Thinking toggle: --think / --no-think flags override OLLAMA_THINK (default off).
  let think: boolean;
  if (process.argv.includes('--think')) think = true;
  else if (process.argv.includes('--no-think')) think = false;
  else think = boolEnv('OLLAMA_THINK', false);

  const numPredictRaw = getArgValue('--num-predict');
  const numPredict =
    numPredictRaw !== undefined
      ? Number(numPredictRaw)
      : intEnvOptional('OLLAMA_NUM_PREDICT', { min: 1 });
  if (numPredict !== undefined && (!Number.isFinite(numPredict) || !Number.isInteger(numPredict))) {
    throw new Error(`Invalid num-predict value: ${numPredictRaw}`);
  }

  return {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel,
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    streamEnabled: boolEnv('STREAM_ENABLED', true),
    temperature,
    topP,
    numCtx,
    think,
    numPredict,
    appTitle: process.env.APP_TITLE?.trim() || 'Guanaco CLI',
  };
}