export interface AppConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt?: string;
  maxHistoryMessages: number;
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
  return {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL?.trim() || 'llama3.2',
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    maxHistoryMessages: intEnv('MAX_HISTORY_MESSAGES', 20, { min: 0 }),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    streamEnabled: boolEnv('STREAM_ENABLED', true),
  };
}
