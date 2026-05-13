export interface AppConfig {
  telegramEnabled: boolean;
  telegramBotToken?: string;
  allowedUserId?: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt?: string;
  maxHistoryMessages: number;
  requestTimeoutMs: number;
  streamEnabled: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    return undefined;
  }
  return v.trim();
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
  const telegramEnabled = boolEnv('TELEGRAM_ENABLED', true);

  let telegramBotToken: string | undefined;
  let allowedUserId: number | undefined;

  if (telegramEnabled) {
    telegramBotToken = required('TELEGRAM_BOT_TOKEN');
    const allowedUserIdRaw = required('TELEGRAM_ALLOWED_USER_ID');
    allowedUserId = Number(allowedUserIdRaw);
    if (!Number.isFinite(allowedUserId) || !Number.isInteger(allowedUserId)) {
      throw new Error(`TELEGRAM_ALLOWED_USER_ID must be a numeric Telegram user id, got: ${allowedUserIdRaw}`);
    }
  } else {
    telegramBotToken = optional('TELEGRAM_BOT_TOKEN');
    const allowedUserIdRaw = optional('TELEGRAM_ALLOWED_USER_ID');
    if (allowedUserIdRaw) {
      allowedUserId = Number(allowedUserIdRaw);
      if (!Number.isFinite(allowedUserId) || !Number.isInteger(allowedUserId)) {
        throw new Error(`TELEGRAM_ALLOWED_USER_ID must be a numeric Telegram user id, got: ${allowedUserIdRaw}`);
      }
    }
  }

  return {
    telegramEnabled,
    telegramBotToken,
    allowedUserId,
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL?.trim() || 'llama3.2',
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    maxHistoryMessages: intEnv('MAX_HISTORY_MESSAGES', 20, { min: 0 }),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    streamEnabled: boolEnv('STREAM_ENABLED', true),
  };
}
