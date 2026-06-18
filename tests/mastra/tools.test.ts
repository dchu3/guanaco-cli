import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSdlcTools } from '../../src/mastra/tools.js';

let repo: string;

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guanaco-tools-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const foo = 1;\n');
  await writeFile(join(dir, 'README.md'), '# demo\n');
  return dir;
}

describe('buildSdlcTools', () => {
  beforeEach(async () => {
    repo = await freshRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function tools() {
    return buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });
  }

  it('read_file returns file content (repo-relative)', async () => {
    const t = tools().tools.read_file;
    const out = await t.execute({ path: 'src/a.ts' }, {} as never);
    expect(out.content).toContain('export const foo = 1');
  });

  it('read_file refuses paths outside the repo root', async () => {
    const t = tools().tools.read_file;
    await expect(t.execute({ path: '../../etc/passwd' }, {} as never)).rejects.toThrow(
      /outside the repo root/,
    );
  });

  it('write_file creates parent dirs and overwrites', async () => {
    const t = tools().tools.write_file;
    const out = await t.execute({ path: 'src/nested/b.ts', content: 'export const bar = 2;\n' }, {} as never);
    // read_file returns its own input shape
    const reader = tools().tools.read_file;
    const r = await reader.execute({ path: 'src/nested/b.ts' }, {} as never);
    expect(r.content).toContain('export const bar = 2');
    expect(out.bytes).toBeGreaterThan(0);
  });

  it('edit_file applies exact replacements', async () => {
    const ts = tools();
    await ts.tools.edit_file.execute(
      { path: 'src/a.ts', edits: [{ oldText: 'foo = 1', newText: 'foo = 42' }] },
      {} as never,
    );
    const r = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(r.content).toContain('foo = 42');
  });

  it('edit_file throws when oldText is missing', async () => {
    const t = tools().tools.edit_file;
    await expect(
      t.execute({ path: 'src/a.ts', edits: [{ oldText: 'nope', newText: 'x' }] }, {} as never),
    ).rejects.toThrow(/oldText not found/);
  });

  it('edit_file accepts old/new (and old_str/new_str) aliases for oldText/newText', async () => {
    const ts = tools();
    await ts.tools.edit_file.execute(
      { path: 'src/a.ts', edits: [{ old: 'foo = 1', new: 'foo = 7' }] },
      {} as never,
    );
    let r = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(r.content).toContain('foo = 7');

    await ts.tools.edit_file.execute(
      { path: 'src/a.ts', edits: [{ old_str: 'foo = 7', new_str: 'foo = 99' }] },
      {} as never,
    );
    r = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(r.content).toContain('foo = 99');
  });

  it('glob matches patterns and ignores node_modules/.git', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'skipped.ts'), 'x');
    const out = await tools().tools.glob.execute({ pattern: '**/*.ts' }, {} as never);
    expect(out.matches).toContain('src/a.ts');
    expect(out.matches).not.toContain('node_modules/skipped.ts');
  });

  it('grep finds matching lines with file:line', async () => {
    const out = await tools().tools.grep.execute({ pattern: 'foo' }, {} as never);
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].path).toBe('src/a.ts');
    expect(out.hits[0].line).toBe(1);
  });

  it('shell runs commands in the repo root', async () => {
    const out = await tools().tools.shell.execute({ command: 'pwd' }, {} as never);
    expect(out.stdout.trim()).toBe(repo);
    expect(out.exitCode).toBe(0);
  });

  it('shell returns exitCode + output instead of throwing on non-zero exit', async () => {
    const out = await tools().tools.shell.execute(
      { command: "node -e 'console.log(\"out\"); console.error(\"err\"); process.exit(3)'" },
      {} as never,
    );
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain('out');
    expect(out.stderr).toContain('err');
  });

  it('shell surfaces a missing script (npm test) as a non-zero result, not a throw', async () => {
    // The fresh test repo has no package.json, so 'npm test' exits non-zero.
    const out = await tools().tools.shell.execute({ command: 'npm test' }, {} as never);
    expect(out.exitCode).not.toBe(0);
    // Some clue is surfaced (npm prints usage/errors to stderr).
    expect(out.stderr.length + out.stdout.length).toBeGreaterThan(0);
  });

  it('shell refuses denylisted commands', async () => {
    const t = tools().tools.shell;
    await expect(t.execute({ command: 'git push origin main' }, {} as never)).rejects.toThrow(
      /refused/,
    );
    await expect(t.execute({ command: 'rm -rf /' }, {} as never)).rejects.toThrow(/refused/);
  });

  it('subset returns only the requested tool ids', () => {
    const ts = tools();
    const sub = ts.subset(['read_file', 'grep']);
    expect(Object.keys(sub).sort()).toEqual(['grep', 'read_file']);
  });
});

describe('git_diff tool', () => {
  let repo: string;

  async function gitRepo(opts: { commit?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'guanaco-gitdiff-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t.t', { cwd: dir });
    execSync('git config user.name t', { cwd: dir });
    if (opts.commit) {
      await writeFile(join(dir, 'existing.txt'), 'old\n');
      execSync('git add -A', { cwd: dir });
      execSync('git commit -q -m init', { cwd: dir });
    }
    return dir;
  }

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('returns a diff in a repo with NO commits (no HEAD) without throwing', async () => {
    repo = await gitRepo();
    await writeFile(join(repo, 'index.js'), 'console.log("hi")\n');
    const t = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 }).tools.git_diff;
    const out = await t.execute({}, {} as never);
    expect(out.diff).toContain('diff --git a/index.js b/index.js');
    expect(out.diff).toContain('+console.log("hi")');
  });

  it('includes new (untracked) files even when HEAD exists', async () => {
    repo = await gitRepo({ commit: true });
    await writeFile(join(repo, 'new.txt'), 'new file\n');
    const t = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 }).tools.git_diff;
    const out = await t.execute({}, {} as never);
    expect(out.diff).toContain('diff --git a/new.txt b/new.txt');
    expect(out.diff).toContain('+new file');
  });

  it('shows staged changes with staged=true', async () => {
    repo = await gitRepo({ commit: true });
    await writeFile(join(repo, 'staged.txt'), 'staged content\n');
    execSync('git add staged.txt', { cwd: repo });
    const t = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 }).tools.git_diff;
    const out = await t.execute({ staged: true }, {} as never);
    expect(out.diff).toContain('diff --git a/staged.txt b/staged.txt');
    expect(out.diff).toContain('+staged content');
  });
});