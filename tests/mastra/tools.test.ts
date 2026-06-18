import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  it('shell returns failure output instead of throwing on a non-zero exit', async () => {
    // A failing command (e.g. `npm test` with failing tests) must come back as
    // a tool result the agent can read and react to — not throw and disrupt the
    // stream with a Mastra "Error executing tool".
    const out = await tools().tools.shell.execute(
      { command: 'sh -c "echo boom 1>&2; exit 7"' },
      {} as never,
    );
    expect(out.ok).toBe(false);
    expect(out.exitCode).toBe(7);
    expect(out.stderr).toContain('boom');
  });

  it('shell refuses denylisted commands (returns an error result)', async () => {
    const t = tools().tools.shell;
    const a = await t.execute({ command: 'git push origin main' }, {} as never);
    expect(a.ok).toBe(false);
    expect(a.stderr).toMatch(/refused/);
    const b = await t.execute({ command: 'rm -rf /' }, {} as never);
    expect(b.ok).toBe(false);
    expect(b.stderr).toMatch(/refused/);
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
    expect(shell.ok).toBe(false);
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