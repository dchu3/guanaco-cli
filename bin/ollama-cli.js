#!/usr/bin/env node
/**
 * `ollama-cli` global entry point.
 *
 * Runs the compiled app (`dist/index.js`), loading `.env` from the current
 * working directory. Extra CLI args (`--version`, `--model`, etc.) are
 * forwarded to the app.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const args = process.argv.slice(2);

if (!existsSync(entry)) {
  // eslint-disable-next-line no-console
  console.error(
    `ollama-cli: compiled app not found at ${entry}\n` +
      `Run "npm run build" in the ollama-cli-template package.`,
  );
  process.exit(1);
}

// Load .env from the current working directory (ignored if absent). Node 20.12+
// supports --env-file-if-exists; fall back to no flag on older runtimes.
const envFlag = supportsEnvFileIfExists() ? ['--env-file-if-exists=.env'] : [];

forwardExit(
  spawn(process.execPath, [...envFlag, entry, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  }),
);

function supportsEnvFileIfExists(): boolean {
  const [major, minor] = process.versions.node.split('.').map((n) => Number(n));
  return major > 20 || (major === 20 && minor >= 12);
}

function forwardExit(child) {
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    } else {
      process.exit(code ?? 0);
    }
  });
}