#!/usr/bin/env node
/**
 * `guanaco` global entry point.
 *
 * Loads `.env` from the CURRENT working directory (not the package dir) and
 * runs the compiled app, so the SDLC harness operates on whatever repo you
 * `cd` into (HARNESS_REPO_ROOT defaults to process.cwd()). This is the
 * recommended way to run the harness against another repo — it does not use
 * `tsx watch`, so there are no file-watch restarts.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

if (!existsSync(entry)) {
  // eslint-disable-next-line no-console
  console.error(
    `guanaco: compiled app not found at ${entry}\n` +
      `Run "npm run build" in the guanaco-cli package first.`,
  );
  process.exit(1);
}

// `--env-file-if-exists=.env` resolves relative to cwd, so a .env in the repo
// you're running from is picked up automatically.
const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

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