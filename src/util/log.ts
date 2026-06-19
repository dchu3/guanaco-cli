import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * File-backed debug logging for a TUI app.
 *
 * The TUI (pi-tui) owns stdout via synchronized differential rendering, so
 * anything written to stdout/stderr mid-session — including errors from
 * Node, Mastra, or pi-tui itself — flashes briefly and is then overwritten by
 * the next render, making them impossible to copy. To fix that, every log
 * line is appended to a persistent file (default `~/.guanaco/logs/debug.log`,
 * or `GUANACO_LOG_FILE`), and `captureStderr()` tees `process.stderr` into the
 * same file so console errors are recovered later via `/log` or by opening the
 * file directly.
 */

const DEBUG_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const debugEnabled = DEBUG_TRUTHY.has((process.env.DEBUG ?? '').trim().toLowerCase());

/** Resolve the log file path from GUANACO_LOG_FILE or the default location. */
function resolveLogFile(): string | undefined {
  const fromEnv = process.env.GUANACO_LOG_FILE;
  if (fromEnv && fromEnv.trim()) {
    const p = fromEnv.trim();
    return isAbsolute(p) ? p : resolve(p);
  }
  const home = homedir();
  if (!home) return undefined;
  return join(home, '.guanaco', 'logs', 'debug.log');
}

const dirsEnsured = new Set<string>();

/** Lazily create the log directory; idempotent. Returns the path or undefined. */
export function getLogFile(): string | undefined {
  const file = resolveLogFile();
  if (!file) return undefined;
  const dir = dirname(file);
  if (!dirsEnsured.has(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      dirsEnsured.add(dir);
    } catch {
      return undefined;
    }
  }
  return file;
}

function stamp(): string {
  return new Date().toISOString();
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(' ');
}

function writeLine(line: string): void {
  const file = getLogFile();
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never throw.
  }
}

/** Verbose tracing; gated by DEBUG=1 (same env as before) so it stays opt-in. */
export function debug(scope: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  writeLine(`${stamp()} [${scope}] ${formatArgs(args)}`);
}

/** Always-on informational log (independent of DEBUG). */
export function logInfo(scope: string, ...args: unknown[]): void {
  writeLine(`${stamp()} [INFO][${scope}] ${formatArgs(args)}`);
}

/** Always-on error log (independent of DEBUG). Use in catch blocks. */
export function logError(scope: string, ...args: unknown[]): void {
  writeLine(`${stamp()} [ERROR][${scope}] ${formatArgs(args)}`);
}

/**
 * Tee `process.stderr` into the log file so messages printed by Node/Mastra/
 * pi-tui are persisted instead of flashing and being overwritten by the TUI.
 * The original stderr still receives the bytes (so they still appear briefly
 * on screen), but they're now recoverable from the log.
 */
export function captureStderr(): void {
  const file = getLogFile();
  if (!file) return;
  const original = process.stderr.write.bind(process.stderr) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    try {
      const str =
        typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : '';
      if (str.trim()) {
        const body = str.endsWith('\n') ? str.slice(0, -1) : str;
        appendFileSync(file, `${stamp()} [stderr] ${body}\n`);
      }
    } catch {
      // ignore
    }
    return original(chunk, ...rest);
  }) as typeof process.stderr.write;
}

/**
 * Read the last `lines` lines of the log file (for the `/log` command).
 * Returns an empty array if the file is missing or unreadable.
 */
export function tailLog(lines = 40): string[] {
  const file = getLogFile();
  if (!file) return [];
  try {
    const content = readFileSync(file, 'utf8');
    const all = content.split('\n').filter((l) => l.length > 0);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** Approximate log file size in bytes (for the `/log` header). */
export function logSizeBytes(): number {
  const file = getLogFile();
  if (!file) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** True when the resolved log file lives inside `dir` (default: cwd). Used to
 * warn the user that logs may get committed if they pointed GUANACO_LOG_FILE at
 * a path inside the repo. The default home-relative path is never inside cwd. */
export function logPathIsInside(dir: string = process.cwd()): boolean {
  const file = resolveLogFile();
  if (!file) return false;
  const rel = relative(resolve(dir), file);
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'));
}

/**
 * Masks sensitive information (like user IDs or tokens) for logging.
 */
export function maskPii(value: string | number | undefined): string {
  if (value === undefined) return 'undefined';
  const str = String(value);
  if (str.length <= 4) return '****';
  return str.slice(0, 2) + '*'.repeat(str.length - 4) + str.slice(-2);
}