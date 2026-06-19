import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { exec, spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { debug } from '../util/log.js';

const execAsync = promisify(exec);

export interface BuildSdlcToolsOptions {
  /** Repo root all file/shell operations are jailed to. */
  repoRoot: string;
  /** Per shell call timeout (ms). */
  toolTimeoutMs: number;
  /** Max bytes returned from read_file / shell stdout before truncation. */
  maxOutputBytes?: number;
  /** Optional injectable exec (for tests). */
  execImpl?: typeof execAsync;
}

/** Commands the shell tool refuses to run (defense-in-depth; agents are not trusted). */
const SHELL_DENYLIST = [
  /\brm\s+-rf\s+\/(\s|$)/, // rm -rf /
  /\bgit\s+push\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /\b:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
];

/** Directories we always skip when scanning the repo tree. */
const WALK_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'out',
  '.vscode',
  '.idea',
]);

function isWithinRepo(repoRoot: string, target: string): boolean {
  const rel = relative(repoRoot, target);
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'));
}

function jailPath(repoRoot: string, p: string): string {
  const abs = resolve(repoRoot, p);
  if (!isWithinRepo(repoRoot, abs)) {
    throw new Error(`Path is outside the repo root: ${p}`);
  }
  return abs;
}

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…[truncated ${buf.length - maxBytes} bytes]`;
}

/** A simple TTL file-tree cache so repeated glob/grep/read calls within an
 *  agent turn (or across a tight loop) don't re-walk the disk every time.
 *  The cache is scoped to one `buildSdlcTools` instance. */
class TreeCache {
  private entries = new Map<string, { files: string[]; until: number }>();
  constructor(private readonly ttlMs: number) {}

  get(dir: string): string[] | undefined {
    const cached = this.entries.get(dir);
    if (!cached) return undefined;
    if (Date.now() > cached.until) {
      this.entries.delete(dir);
      return undefined;
    }
    return cached.files;
  }

  set(dir: string, files: string[]): void {
    this.entries.set(dir, { files, until: Date.now() + this.ttlMs });
  }

  /** Invalidate the whole cache (e.g. after a write/edit). */
  clear(): void {
    this.entries.clear();
  }
}

async function walk(dir: string, acc: string[], cache?: TreeCache): Promise<void> {
  const cached = cache?.get(dir);
  if (cached) {
    acc.push(...cached);
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    cache?.set(dir, []);
    return;
  }

  const filesHere: string[] = [];
  for (const entry of entries) {
    if (WALK_IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(full, acc, cache);
    } else {
      filesHere.push(full);
    }
  }
  cache?.set(dir, filesHere);
  acc.push(...filesHere);
}

/** Execute a shell command with timeout and abort-signal support.
 *  Uses spawn under the hood so a cancellation actually kills the process,
 *  rather than waiting for exec's timeout. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBufferBytes = 4 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string; exitCode: number; killed: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'shell: aborted before start', exitCode: -1, killed: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Use bash -c so the agent can rely on shell syntax (pipes, redirects, etc.).
    const child = spawn('bash', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as SpawnOptionsWithoutStdio);

    const timers: NodeJS.Timeout[] = [];
    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
    };

    const kill = (reason: string): void => {
      if (killed || child.killed || child.exitCode !== null) return;
      killed = true;
      stderr = `${stderr}\n[${reason}]`.trim();
      try {
        child.kill('SIGTERM');
        // Force-kill after a grace period if still running.
        timers.push(
          setTimeout(() => {
            if (child.exitCode === null && !child.killed) {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }
          }, 2000),
        );
      } catch {
        // ignore
      }
    };

    if (timeoutMs > 0) {
      timers.push(
        setTimeout(() => {
          kill(`timed out after ${timeoutMs}ms`);
        }, timeoutMs),
      );
    }

    if (signal) {
      const onAbort = (): void => kill('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf8') < maxBufferBytes) {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout, 'utf8') > maxBufferBytes) {
          stdout = truncate(stdout, maxBufferBytes);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf8') < maxBufferBytes) {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr, 'utf8') > maxBufferBytes) {
          stderr = truncate(stderr, maxBufferBytes);
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      resolve({
        stdout,
        stderr: stderr || `shell: failed to run '${command}': ${err.message}`,
        exitCode: -1,
        killed,
      });
    });

    child.on('close', (code) => {
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (killed ? -1 : 0),
        killed,
      });
    });
  });
}

export function buildSdlcTools(opts: BuildSdlcToolsOptions) {
  const repoRoot = resolve(opts.repoRoot);
  const maxOut = opts.maxOutputBytes ?? 50_000;
  const execFn = opts.execImpl ?? execAsync;
  const treeCache = new TreeCache(5000);
  const globCache = new Map<string, ReturnType<typeof picomatch>>();

  function getGlobMatcher(pattern: string): ReturnType<typeof picomatch> {
    let matcher = globCache.get(pattern);
    if (!matcher) {
      matcher = picomatch(pattern, { dot: true });
      globCache.set(pattern, matcher);
    }
    return matcher;
  }

  // NOTE on schema shapes: every required argument is declared `.optional()` so
  // that a model tool call with empty/missing args (e.g. `grep {}`) still
  // PARSES — Mastra validates tool args against this schema at parse time and
  // would otherwise throw AI_InvalidToolArgumentsError and crash the stream.
  // Each `execute` then guards the missing field and returns an `error` result
  // (never throws) so the agent is told what's missing and can retry. The same
  // "return errors, don't throw" rule applies to jail/out-of-repo, not-found,
  // invalid-regex, and edit_file oldText-not-found: a thrown tool error
  // surfaces as a Mastra "Error executing tool" and disrupts the stream.

  const readFileTool = createTool({
    id: 'read_file',
    description:
      'Read the contents of a file relative to the repo root. Returns the text (truncated for very large files).',
    inputSchema: z.object({
      path: z.string().optional().describe('Repo-relative path to the file.'),
      offset: z.number().int().min(1).optional().describe('1-indexed line to start reading from.'),
      limit: z.number().int().min(1).optional().describe('Max number of lines to read.'),
    }),
    execute: async (input) => {
      const path = input.path;
      if (!path || !path.trim()) {
        return { path: path ?? '', content: '', error: 'read_file: "path" is required' };
      }
      let abs: string;
      try {
        abs = jailPath(repoRoot, path);
      } catch (err) {
        return { path, content: '', error: err instanceof Error ? err.message : String(err) };
      }
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch (err) {
        return { path, content: '', error: `read_file: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (input.offset || input.limit) {
        const lines = content.split('\n');
        const start = (input.offset ?? 1) - 1;
        const end = input.limit ? start + input.limit : lines.length;
        content = lines.slice(Math.max(0, start), end).join('\n');
      }
      return { path, content: truncate(content, maxOut) };
    },
  });

  const writeFileTool = createTool({
    id: 'write_file',
    description:
      'Create or overwrite a file relative to the repo root. Parent directories are created automatically.',
    inputSchema: z.object({
      path: z.string().optional().describe('Repo-relative path to the file.'),
      content: z.string().optional().describe('Full content to write.'),
    }),
    execute: async (input) => {
      const path = input.path;
      if (!path || !path.trim()) {
        return { path: path ?? '', bytes: 0, error: 'write_file: "path" is required' };
      }
      const content = input.content ?? '';
      try {
        const abs = jailPath(repoRoot, path);
        await mkdir(join(abs, '..'), { recursive: true });
        await writeFile(abs, content, 'utf8');
        treeCache.clear();
        debug('harness-tool', `write_file ${path} (${Buffer.byteLength(content)} bytes)`);
        return { path, bytes: Buffer.byteLength(content) };
      } catch (err) {
        return { path, bytes: 0, error: `write_file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  const editFileTool = createTool({
    id: 'edit_file',
    description:
      'Apply exact-text replacements to a file. Each edit must match a unique, non-overlapping region of the current file content. Prefer edit_file over write_file for targeted changes. Each edit needs the text to find and its replacement; the canonical keys are `oldText`/`newText`, but `old`/`new`, `old_str`/`new_str`, and `find`/`replace` are also accepted.',
    inputSchema: z.object({
      path: z.string().optional().describe('Repo-relative path to the file.'),
      edits: z
        .array(
          // Models sometimes emit `old`/`new`, `old_str`/`new_str`, or
          // `find`/`replace` instead of `oldText`/`newText`; normalize before
          // the schema validates so those calls parse.
          z.preprocess(
            (v) => {
              if (v && typeof v === 'object') {
                const o = v as Record<string, unknown>;
                return {
                  oldText: o.oldText ?? o.old ?? o.old_str ?? o.find,
                  newText: o.newText ?? o.new ?? o.new_str ?? o.replace,
                };
              }
              return v;
            },
            z.object({
              oldText: z.string().optional().describe('Exact text to find.'),
              newText: z.string().optional().describe('Replacement text.'),
            }),
          ),
        )
        .optional(),
    }),
    execute: async (input) => {
      const path = input.path;
      if (!path || !path.trim()) {
        return { path: path ?? '', appliedEdits: 0, error: 'edit_file: "path" is required' };
      }
      // input.edits is typed as unknown[] (preprocess input); normalize aliases
      // here too so direct callers work the same as model tool-calls.
      const rawEdits = (input.edits ?? []) as Array<Record<string, string | undefined>>;
      const edits = rawEdits.map((e) => ({
        oldText: e.oldText ?? e.old ?? e.old_str ?? e.find,
        newText: e.newText ?? e.new ?? e.new_str ?? e.replace,
      }));
      if (edits.length === 0) {
        return { path, appliedEdits: 0, error: 'edit_file: "edits" is required' };
      }
      try {
        const abs = jailPath(repoRoot, path);
        let content = await readFile(abs, 'utf8');
        for (const e of edits) {
          if (e.oldText === undefined || e.newText === undefined) {
            return {
              path,
              appliedEdits: 0,
              error:
                'edit_file: each edit needs "oldText" and "newText" (aliases "old"/"new", "old_str"/"new_str", or "find"/"replace" are accepted)',
            };
          }
          const idx = content.indexOf(e.oldText);
          if (idx === -1) {
            return { path, appliedEdits: 0, error: `edit_file: oldText not found in ${path}` };
          }
          const after = content.slice(idx + e.oldText.length);
          content = content.slice(0, idx) + e.newText + after;
        }
        await writeFile(abs, content, 'utf8');
        treeCache.clear();
        debug('harness-tool', `edit_file ${path} (${edits.length} edits)`);
        return { path, appliedEdits: edits.length };
      } catch (err) {
        return { path, appliedEdits: 0, error: `edit_file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  const globTool = createTool({
    id: 'glob',
    description:
      'List repo-relative file paths matching a glob pattern (supports **, *, ?). Ignores node_modules, .git, build/output directories.',
    inputSchema: z.object({
      pattern: z.string().optional().describe('Glob pattern, e.g. "src/**/*.ts".'),
    }),
    execute: async (input) => {
      const pattern = input.pattern;
      if (!pattern || !pattern.trim()) {
        return { matches: [], error: 'glob: "pattern" is required' };
      }
      const matcher = getGlobMatcher(pattern);
      const files: string[] = [];
      await walk(repoRoot, files, treeCache);
      const matches = files
        .map((f) => relative(repoRoot, f).split(sep).join('/'))
        .filter((f) => matcher(f))
        .sort();
      return { matches: matches.slice(0, 500) };
    },
  });

  const grepTool = createTool({
    id: 'grep',
    description:
      'Search file contents under the repo root for a pattern (JavaScript RegExp string). Returns matching lines with file:line.',
    inputSchema: z.object({
      pattern: z.string().optional().describe('RegExp source, e.g. "function\\\\s+foo".'),
      path: z.string().optional().describe('Optional repo-relative dir/file to scope.'),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (input) => {
      const pattern = input.pattern;
      if (!pattern || !pattern.trim()) {
        return { hits: [], error: 'grep: "pattern" is required' };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        return {
          hits: [],
          error: `grep: invalid pattern: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const cap = input.maxResults ?? 100;
      let root: string;
      if (input.path) {
        try {
          root = jailPath(repoRoot, input.path);
        } catch (err) {
          return { hits: [], error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        root = repoRoot;
      }
      const files: string[] = [];
      if (input.path) {
        const s = await stat(root).catch(() => null);
        if (s?.isFile()) files.push(root);
        else if (s?.isDirectory()) await walk(root, files, treeCache);
      } else {
        await walk(repoRoot, files, treeCache);
      }
      const hits: { path: string; line: number; text: string }[] = [];
      for (const f of files) {
        if (hits.length >= cap) break;
        const text = await readFile(f, 'utf8').catch(() => null);
        if (!text) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= cap) break;
          if (regex.test(lines[i])) {
            hits.push({ path: relative(repoRoot, f).split(sep).join('/'), line: i + 1, text: lines[i].slice(0, 500) });
          }
        }
      }
      return { hits };
    },
  });

  const shellTool = createTool({
    id: 'shell',
    description:
      'Run a shell command inside the repo root. Destructive/git-push/sudo commands are refused. Use for builds, linters, tests, and read-only git queries. Returns stdout, stderr, and exitCode; a non-zero exitCode is NOT an error — inspect it and the output to diagnose build/test failures.',
    inputSchema: z.object({
      command: z.string().optional().describe('Command line to execute.'),
    }),
    execute: async (input, options) => {
      const command = input.command;
      if (!command || !command.trim()) {
        return { stdout: '', stderr: 'shell: "command" is required', exitCode: -1 };
      }
      for (const deny of SHELL_DENYLIST) {
        if (deny.test(command)) {
          return { stdout: '', stderr: `shell: refused (matches denylist): ${command}`, exitCode: -1 };
        }
      }
      debug('harness-tool', `shell: ${command}`);
      // A non-zero exit (failing tests/build, missing script) is expected for a
      // coding agent — surface stdout/stderr/exitCode so it can diagnose and
      // fix, instead of aborting the turn. Timeouts and spawn errors are also
      // surfaced (with a note) rather than thrown.
      const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const res = await runShell(command, repoRoot, opts.toolTimeoutMs, signal);
      return {
        stdout: truncate(res.stdout, maxOut),
        stderr: truncate(res.stderr, maxOut),
        exitCode: res.exitCode,
      };
    },
  });

  const gitDiffTool = createTool({
    id: 'git_diff',
    description:
      'Return the current uncommitted diff inside the repo root, including new (untracked) files. Works in a repo with no commits yet (diffs against the empty tree).',
    inputSchema: z.object({ staged: z.boolean().optional() }),
    execute: async (input, options) => {
      const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const run = (cmd: string): Promise<string> =>
        execFn(cmd, { cwd: repoRoot, timeout: opts.toolTimeoutMs, maxBuffer: 1024 * 1024 * 8, signal })
          .then((r) => r.stdout)
          .catch(() => '');
      // Diff against HEAD when there are commits; otherwise against git's
      // well-known empty-tree object (a repo with no commits yet has no HEAD,
      // and `git diff HEAD` would fatal).
      const headOk = await execFn('git rev-parse --verify HEAD', {
        cwd: repoRoot,
        timeout: opts.toolTimeoutMs,
        signal,
      })
        .then(() => true)
        .catch(() => false);
      const base = headOk ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      if (input.staged) {
        const diff = await run(`git diff --cached ${base}`);
        return { diff: truncate(diff, maxOut * 4) };
      }
      // `git diff` ignores untracked files by default; mark them intent-to-add
      // so newly-created files show up. This only records intent in the index
      // (no content staged); the harness's final `git add -A` converts it to a
      // real add, and it's reversible with `git reset`.
      await run('git add -N .');
      const diff = await run(`git diff ${base}`);
      return { diff: truncate(diff, maxOut * 4) };
    },
  });

  const tools = {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob: globTool,
    grep: grepTool,
    shell: shellTool,
    git_diff: gitDiffTool,
  };

  type ToolRecord = typeof tools;

  /** Resolve the subset of tools an agent is allowed to use, by id. */
  function subset(ids: string[]): Partial<ToolRecord> {
    const out: Partial<ToolRecord> = {};
    for (const id of ids) {
      const t = tools[id as keyof ToolRecord];
      if (t) (out as Record<string, unknown>)[id] = t;
    }
    return out;
  }

  return { tools, subset };
}

export type SdlcToolSet = ReturnType<typeof buildSdlcTools>;
export type SdlcToolRecord = SdlcToolSet['tools'];