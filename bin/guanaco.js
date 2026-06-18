#!/usr/bin/env node
/**
 * `guanaco` global entry point.
 *
 * Loads `.env` from the CURRENT working directory (not the package dir) and
 * runs the compiled app, so the SDLC harness operates on whatever repo you
 * `cd` into (HARNESS_REPO_ROOT defaults to process.cwd()). This is the
 * recommended way to run the harness against another repo — it does not use
 * `tsx watch`, so there are no file-watch restarts.
 *
 * Subcommands handled here (before launching the TUI):
 *   - `guanaco update` — git pull + rebuild + refresh the shim
 *     (delegates to scripts/update.sh, which reads ~/.config/guanaco/install.env).
 * Everything else is forwarded to the compiled app (so `--version`, `--model`,
 * `--provider`, `/feature`, etc. reach src/index.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const args = process.argv.slice(2);

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

// Resolve the package dir for `guanaco update`: prefer the installer's record,
// fall back to this bin's own package dir (one level up from bin/).
function resolvePkgDir() {
  const stateFile = join(homedir(), '.config', 'guanaco', 'install.env');
  if (existsSync(stateFile)) {
    for (const line of readFileSync(stateFile, 'utf8').split('\n')) {
      const m = line.match(/^GUANACO_PKG_DIR=(.*)$/);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return join(here, '..');
}

// `guanaco update` — delegate to scripts/update.sh (no build required to run
// the update, which is important since the point of an update may be that the
// build is stale).
if (args[0] === 'update') {
  const pkgDir = resolvePkgDir();
  const updateScript = join(pkgDir, 'scripts', 'update.sh');
  if (!existsSync(updateScript)) {
    // eslint-disable-next-line no-console
    console.error(
      `guanaco update: update script not found at ${updateScript}\n` +
        `Run "bash scripts/install.sh" first, or update manually with ` +
        `"git pull && npm run build" from the guanaco-cli repo.`,
    );
    process.exit(1);
  }
  forwardExit(spawn('bash', [updateScript, ...args.slice(1)], { stdio: 'inherit' }));
} else {
  if (!existsSync(entry)) {
    // eslint-disable-next-line no-console
    console.error(
      `guanaco: compiled app not found at ${entry}\n` +
        `Run "guanaco update", or "npm run build" in the guanaco-cli package.`,
    );
    process.exit(1);
  }

  // `--env-file-if-exists=.env` resolves relative to cwd, so a .env in the repo
  // you're running from is picked up automatically. Forward any extra CLI args
  // (e.g. `--version`, `--model`, `--provider`) to the app.
  forwardExit(
    spawn(
      process.execPath,
      ['--env-file-if-exists=.env', entry, ...args],
      {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      },
    ),
  );
}