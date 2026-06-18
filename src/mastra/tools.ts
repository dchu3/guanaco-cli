import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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
  /** Optional injectable fetch for read (unused; kept for symmetry). */
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

/** Minimal glob → RegExp supporting `**`, `*`, `?` and a leading `/`. */
function globToRegex(pattern: string): RegExp {
  let src = pattern;
  // anchboth? we treat patterns as repo-relative; match against forward-slash paths.
  src = src.replace(/[-/\\^$+?.()|[\]{}]/g, (m) => (m === '/' ? '/' : `\\${m}`));
  // restore the / we just escaped for separator handling
  src = pattern
    .split('')
    .map((ch, i) => {
      if (ch === '*') {
        const next = pattern[i + 1];
        if (next === '*') return '<<GLOBSTAR>>';
        return '[^/]*';
      }
      if (ch === '?') return '[^/]';
      if (/[.+^${}()|[\]\\]/.test(ch)) return `\\${ch}`;
      return ch;
    })
    .join('');
  src = src.replace(/<<GLOBSTAR>>\/?/g, '.*');
  return new RegExp(`^${src}$`);
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(full, acc);
    } else {
      acc.push(full);
    }
  }
}

export function buildSdlcTools(opts: BuildSdlcToolsOptions) {
  const repoRoot = resolve(opts.repoRoot);
  const maxOut = opts.maxOutputBytes ?? 50_000;
  const execFn = opts.execImpl ?? execAsync;

  const readFileTool = createTool({
    id: 'read_file',
    description:
      'Read the contents of a file relative to the repo root. Returns the text (truncated for very large files).',
    inputSchema: z.object({
      path: z.string().describe('Repo-relative path to the file.'),
      offset: z.number().int().min(1).optional().describe('1-indexed line to start reading from.'),
      limit: z.number().int().min(1).optional().describe('Max number of lines to read.'),
    }),
    execute: async (input) => {
      const abs = jailPath(repoRoot, input.path);
      let content = await readFile(abs, 'utf8');
      if (input.offset || input.limit) {
        const lines = content.split('\n');
        const start = (input.offset ?? 1) - 1;
        const end = input.limit ? start + input.limit : lines.length;
        content = lines.slice(Math.max(0, start), end).join('\n');
      }
      return { path: input.path, content: truncate(content, maxOut) };
    },
  });

  const writeFileTool = createTool({
    id: 'write_file',
    description:
      'Create or overwrite a file relative to the repo root. Parent directories are created automatically.',
    inputSchema: z.object({
      path: z.string().describe('Repo-relative path to the file.'),
      content: z.string().describe('Full content to write.'),
    }),
    execute: async (input) => {
      const abs = jailPath(repoRoot, input.path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, input.content, 'utf8');
      debug('harness-tool', `write_file ${input.path} (${Buffer.byteLength(input.content)} bytes)`);
      return { path: input.path, bytes: Buffer.byteLength(input.content) };
    },
  });

  const editFileTool = createTool({
    id: 'edit_file',
    description:
      'Apply exact-text replacements to a file. Each edit must match a unique, non-overlapping region of the current file content. Prefer this over write_file for targeted changes.',
    inputSchema: z.object({
      path: z.string().describe('Repo-relative path to the file.'),
      edits: z
        .array(
          z.object({
            oldText: z.string().describe('Exact text to find.'),
            newText: z.string().describe('Replacement text.'),
          }),
        )
        .min(1),
    }),
    execute: async (input) => {
      const abs = jailPath(repoRoot, input.path);
      let content = await readFile(abs, 'utf8');
      for (const e of input.edits) {
        const idx = content.indexOf(e.oldText);
        if (idx === -1) {
          throw new Error(`edit_file: oldText not found in ${input.path}`);
        }
        const after = content.slice(idx + e.oldText.length);
        content = content.slice(0, idx) + e.newText + after;
      }
      await writeFile(abs, content, 'utf8');
      debug('harness-tool', `edit_file ${input.path} (${input.edits.length} edits)`);
      return { path: input.path, appliedEdits: input.edits.length };
    },
  });

  const globTool = createTool({
    id: 'glob',
    description:
      'List repo-relative file paths matching a glob pattern (supports **, *, ?). Ignores node_modules and .git.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
    }),
    execute: async (input) => {
      const regex = globToRegex(input.pattern);
      const files: string[] = [];
      await walk(repoRoot, files);
      const matches = files
        .map((f) => relative(repoRoot, f).split(sep).join('/'))
        .filter((f) => regex.test(f))
        .sort();
      return { matches: matches.slice(0, 500) };
    },
  });

  const grepTool = createTool({
    id: 'grep',
    description:
      'Search file contents under the repo root for a pattern (JavaScript RegExp string). Returns matching lines with file:line.',
    inputSchema: z.object({
      pattern: z.string().describe('RegExp source, e.g. "function\\\\s+foo".'),
      path: z.string().optional().describe('Optional repo-relative dir/file to scope.'),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (input) => {
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (err) {
        throw new Error(`grep: invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
      }
      const cap = input.maxResults ?? 100;
      const root = input.path ? jailPath(repoRoot, input.path) : repoRoot;
      const files: string[] = [];
      if (input.path) {
        const s = await stat(root).catch(() => null);
        if (s?.isFile()) files.push(root);
        else if (s?.isDirectory()) await walk(root, files);
      } else {
        await walk(repoRoot, files);
      }
      const hits: { path: string; line: number; text: string }[] = [];
      for (const f of files) {
        if (hits.length >= cap) break;
        const text = await readFile(f, 'utf8').catch(() => null);
        if (!text) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            hits.push({ path: relative(repoRoot, f).split(sep).join('/'), line: i + 1, text: lines[i].slice(0, 500) });
            if (hits.length >= cap) break;
          }
        }
      }
      return { hits };
    },
  });

  const shellTool = createTool({
    id: 'shell',
    description:
      'Run a shell command inside the repo root. Destructive/git-push/sudo commands are refused. Use for builds, linters, tests, and read-only git queries.',
    inputSchema: z.object({
      command: z.string().describe('Command line to execute.'),
    }),
    execute: async (input) => {
      for (const deny of SHELL_DENYLIST) {
        if (deny.test(input.command)) {
          throw new Error(`shell: refused (matches denylist): ${input.command}`);
        }
      }
      debug('harness-tool', `shell: ${input.command}`);
      const { stdout, stderr } = await execFn(input.command, {
        cwd: repoRoot,
        timeout: opts.toolTimeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
      return {
        stdout: truncate(stdout, maxOut),
        stderr: truncate(stderr, maxOut),
      };
    },
  });

  const gitDiffTool = createTool({
    id: 'git_diff',
    description: 'Return the current uncommitted diff (git diff HEAD) inside the repo root.',
    inputSchema: z.object({ staged: z.boolean().optional() }),
    execute: async (input) => {
      const cmd = input.staged ? 'git diff --cached' : 'git diff HEAD';
      const { stdout } = await execFn(cmd, { cwd: repoRoot, timeout: opts.toolTimeoutMs, maxBuffer: 1024 * 1024 * 8 });
      return { diff: truncate(stdout, maxOut * 4) };
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