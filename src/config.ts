export interface AppConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt?: string;
  requestTimeoutMs: number;
  streamEnabled: boolean;
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

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Env var ${name} must be a boolean (1/0/true/false), got: ${raw}`);
}

export function loadConfig(): AppConfig {
  let ollamaModel = process.env.OLLAMA_MODEL?.trim() || 'llama3.2';

  // Check for --model override in process.argv
  const modelArgIndex = process.argv.indexOf('--model');
  if (modelArgIndex !== -1 && modelArgIndex + 1 < process.argv.length) {
    const val = process.argv[modelArgIndex + 1].trim();
    if (val) ollamaModel = val;
  } else {
    // Handle --model=value format
    const modelFlag = process.argv.find((arg) => arg.startsWith('--model='));
    if (modelFlag) {
      const val = modelFlag.split('=')[1].trim();
      if (val) ollamaModel = val;
    } else {
      // Fallback: use the first positional argument as the model if it's not a flag
      const positionalModel = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
      if (positionalModel) {
        ollamaModel = positionalModel.trim();
      }
    }
  }

  return {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel,
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    streamEnabled: boolEnv('STREAM_ENABLED', true),
  };
}
