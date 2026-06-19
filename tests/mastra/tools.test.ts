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

  it('read_file refuses paths outside the repo root (returns an error result)', async () => {
    const t = tools().tools.read_file;
    const out = await t.execute({ path: '../../etc/passwd' }, {} as never);
    expect(out.content).toBe('');
    expect(out.error).toMatch(/outside the repo root/);
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

  it('edit_file returns an error result when oldText is missing', async () => {
    const t = tools().tools.edit_file;
    const out = await t.execute({ path: 'src/a.ts', edits: [{ oldText: 'nope', newText: 'x' }] }, {} as never);
    expect(out.appliedEdits).toBe(0);
    expect(out.error).toMatch(/oldText not found/);
  });

  it('edit_file accepts old/new and find/replace aliases for oldText/newText', async () => {
    // Some models emit {"new":...,"old":...} instead of newText/oldText.
    const ts = tools();
    const byOldNew = await ts.tools.edit_file.execute(
      { path: 'src/a.ts', edits: [{ old: 'foo = 1', new: 'foo = 7' }] },
      {} as never,
    );
    expect(byOldNew.appliedEdits).toBe(1);
    const afterOldNew = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(afterOldNew.content).toContain('foo = 7');

    const byFindReplace = await ts.tools.edit_file.execute(
      { path: 'src/a.ts', edits: [{ find: 'foo = 7', replace: 'foo = 9' }] },
      {} as never,
    );
    expect(byFindReplace.appliedEdits).toBe(1);
    const afterFR = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(afterFR.content).toContain('foo = 9');
  });

  it('edit_file returns a clear error when an edit is missing both old and new', async () => {
    const t = tools().tools.edit_file;
    const out = await t.execute({ path: 'src/a.ts', edits: [{ old: 'foo = 9' }] }, {} as never);
    expect(out.appliedEdits).toBe(0);
    expect(out.error).toMatch(/oldText.*newText|newText.*oldText/);
  });

  it('edit_file coerces a JSON-stringified edits array into a real array', async () => {
    const ts = tools();
    const editsJson = JSON.stringify([{ oldText: 'foo = 1', newText: 'foo = 123' }]);
    const out = await ts.tools.edit_file.execute({ path: 'src/a.ts', edits: editsJson }, {} as never);
    expect(out.appliedEdits).toBe(1);
    const r = await ts.tools.read_file.execute({ path: 'src/a.ts' }, {} as never);
    expect(r.content).toContain('foo = 123');
  });

  it('edit_file returns a clear error when edits is an empty/whitespace string', async () => {
    const t = tools().tools.edit_file;
    const out = await t.execute({ path: 'src/a.ts', edits: '   ' }, {} as never);
    expect(out.appliedEdits).toBe(0);
    expect(out.error).toMatch(/edits.*required/);
  });

  it('edit_file returns a clear error when edits is an invalid JSON string', async () => {
    const t = tools().tools.edit_file;
    const out = await t.execute({ path: 'src/a.ts', edits: 'not-json' }, {} as never);
    expect(out.appliedEdits).toBe(0);
    expect(out.error).toMatch(/edits.*required/);
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

  it('glob matches patterns and ignores node_modules/.git/build dirs', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await mkdir(join(repo, 'dist'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'skipped.ts'), 'x');
    await writeFile(join(repo, 'dist', 'skipped.js'), 'x');
    const out = await tools().tools.glob.execute({ pattern: '**/*.*' }, {} as never);
    expect(out.matches).toContain('src/a.ts');
    expect(out.matches).toContain('README.md');
    expect(out.matches).not.toContain('node_modules/skipped.ts');
    expect(out.matches).not.toContain('dist/skipped.js');
  });

  it('glob supports picomatch patterns like src/**/*.ts', async () => {
    const out = await tools().tools.glob.execute({ pattern: 'src/**/*.ts' }, {} as never);
    expect(out.matches).toEqual(['src/a.ts']);
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

  it('shell returns failure output instead of throwing on a non-zero exit', async () => {
    // A failing command (e.g. `npm test` with failing tests) must come back as
    // a tool result the agent can read and react to — not throw and disrupt the
    // stream with a Mastra "Error executing tool".
    const out = await tools().tools.shell.execute(
      { command: 'sh -c "echo boom 1>&2; exit 7"' },
      {} as never,
    );
    expect(out.exitCode).toBe(7);
    expect(out.stderr).toContain('boom');
  });

  it('shell refuses denylisted commands (returns an error result)', async () => {
    const t = tools().tools.shell;
    const a = await t.execute({ command: 'git push origin main' }, {} as never);
    expect(a.exitCode).not.toBe(0);
    expect(a.stderr).toMatch(/refused/);
    const b = await t.execute({ command: 'rm -rf /' }, {} as never);
    expect(b.exitCode).not.toBe(0);
    expect(b.stderr).toMatch(/refused/);
  });

  it('shell can be cancelled via an abort signal', async () => {
    const controller = new AbortController();
    const promise = tools().tools.shell.execute(
      { command: 'sleep 5' },
      { abortSignal: controller.signal } as never,
    );
    controller.abort();
    const out = await promise;
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toMatch(/aborted/);
  });

  it('tools return an error result (not throw) when called with empty args {}', async () => {
    // Regression: a model tool call with empty/missing args must parse and
    // return a clear error to the agent, instead of throwing
    // AI_InvalidToolArgumentsError and crashing the stream.
    const ts = tools();
    const grep = await ts.tools.grep.execute({} as never, {} as never);
    expect(grep.hits).toEqual([]);
    expect(grep.error).toMatch(/pattern/);

    const glob = await ts.tools.glob.execute({} as never, {} as never);
    expect(glob.matches).toEqual([]);
    expect(glob.error).toMatch(/pattern/);

    const shell = await ts.tools.shell.execute({} as never, {} as never);
    expect(shell.exitCode).not.toBe(0);
    expect(shell.stderr).toMatch(/command/);

    const read = await ts.tools.read_file.execute({} as never, {} as never);
    expect(read.content).toBe('');
    expect(read.error).toMatch(/path/);

    const write = await ts.tools.write_file.execute({} as never, {} as never);
    expect(write.bytes).toBe(0);
    expect(write.error).toMatch(/path/);

    const edit = await ts.tools.edit_file.execute({} as never, {} as never);
    expect(edit.appliedEdits).toBe(0);
    expect(edit.error).toMatch(/path|edits/);
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