import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSdlcTools } from '../src/mastra/tools.js';

/** Simple bench harness: run `fn` and report mean + p95 over `runs` iterations. */
async function bench(name: string, fn: () => Promise<void> | void, runs = 5): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`${name}: mean ${mean.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms`);
}

async function buildTree(root: string, fileCount: number, depth = 3): Promise<void> {
  const dirs: string[] = [root];
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const d of dirs) {
      for (let j = 0; j < 3; j++) {
        const child = join(d, `dir${j}`);
        await mkdir(child, { recursive: true });
        next.push(child);
      }
    }
    dirs.push(...next);
  }
  // Create files across the tree.
  const allDirs = [root, ...dirs];
  for (let i = 0; i < fileCount; i++) {
    const dir = allDirs[i % allDirs.length];
    await writeFile(join(dir, `file${i}.ts`), `export const x${i} = ${i};\n`);
  }
}

async function main(): Promise<void> {
  const scales = [100, 1000, 5000];
  for (const scale of scales) {
    const repo = await mkdtemp(join(tmpdir(), `guanaco-bench-${scale}-`));
    try {
      await buildTree(repo, scale);
      // Add build/output dirs that should be skipped.
      await mkdir(join(repo, 'node_modules'), { recursive: true });
      await mkdir(join(repo, 'dist'), { recursive: true });
      await writeFile(join(repo, 'node_modules', 'big.js'), 'x'.repeat(1_000_000));
      await writeFile(join(repo, 'dist', 'bundle.js'), 'x'.repeat(1_000_000));

      const ts = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });

      await bench(`walk ${scale} files`, async () => {
        const files: string[] = [];
        // Access the internal walk via glob with an all-excluding pattern.
        // The glob tool calls walk internally; we just want the scan cost.
        await ts.tools.glob.execute({ pattern: '**/no-such-file-*.xyz' }, {} as never);
      });

      await bench(`glob **/*.ts (${scale} files)`, async () => {
        await ts.tools.glob.execute({ pattern: '**/*.ts' }, {} as never);
      });

      await bench(`grep 'export const' (${scale} files)`, async () => {
        await ts.tools.grep.execute({ pattern: 'export const' }, {} as never);
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});