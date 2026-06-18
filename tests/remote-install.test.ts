import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_INSTALL_SH = join(REPO_ROOT, 'scripts', 'remote-install.sh');

function gitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();

interface Fixture {
  root: string; // temp workspace (owns remote + home)
  remote: string; // bare git remote (the "upstream")
  home: string; // fake $HOME for install.env state
}

/**
 * Build a throwaway "upstream" git remote that looks like a guanaco-cli
 * checkout: a stub scripts/install.sh (no npm/build) + the real
 * remote-install.sh. Returns the bare remote path and a fake HOME.
 */
function buildRemote(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'guanaco-remote-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  execSync(`git init --bare -q "${remote}"`);
  execSync(`git init -q "${seed}"`);
  execSync('git config user.email s@s.s', { cwd: seed });
  execSync('git config user.name s', { cwd: seed });
  execSync('git branch -m main', { cwd: seed });

  mkdirSync(join(seed, 'scripts'), { recursive: true });
  writeFileSync(
    join(seed, 'scripts', 'install.sh'),
    [
      '#!/usr/bin/env bash',
      'set -e',
      `echo "stub-install ran" > "$(dirname "$0")/../install-ran.marker"`,
      `mkdir -p "$HOME/.config/guanaco"`,
      `printf 'GUANACO_BIN_DIR=%s/.local/bin\\nGUANACO_PKG_DIR=%s\\n' "$HOME" "$(dirname "$0")/.." > "$HOME/.config/guanaco/install.env"`,
      'exit 0',
    ].join('\n'),
  );
  copyFileSync(REMOTE_INSTALL_SH, join(seed, 'scripts', 'remote-install.sh'));
  execSync('git add -A', { cwd: seed });
  execSync('git commit -q -m "initial"', { cwd: seed });
  execSync(`git remote add origin "${remote}"`, { cwd: seed });
  execSync('git push -q origin main', { cwd: seed });

  const home = mkdtempSync(join(tmpdir(), 'guanaco-remote-home-'));
  return { root, remote, home };
}

function newInstallDir(): string {
  return mkdtempSync(join(tmpdir(), 'guanaco-remote-install-'));
}

function runRemoteInstall(opts: { repo: string; home: string; homeDir: string; ref?: string }) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.home,
    GUIANACO_REPO: opts.repo,
    GUIANACO_HOME: opts.homeDir,
  };
  if (opts.ref) env.GUANACO_REF = opts.ref;
  return spawnSync('bash', [REMOTE_INSTALL_SH], { cwd: opts.home, env, encoding: 'utf8' });
}

describe('scripts/remote-install.sh', { skip: !GIT }, () => {
  it('clones the repo and runs the installer into GUIANACO_HOME', () => {
    const fix = buildRemote();
    const hd = newInstallDir();
    try {
      const res = runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd });
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(existsSync(join(hd, 'scripts', 'install.sh'))).toBe(true);
      // The stub installer ran (marker) and recorded install.env pointing at the clone.
      expect(existsSync(join(hd, 'install-ran.marker'))).toBe(true);
      const env = readFileSync(join(fix.home, '.config', 'guanaco', 'install.env'), 'utf8');
      expect(env).toContain(`GUANACO_PKG_DIR=${hd}`);
    } finally {
      rmSync(fix.root, { recursive: true, force: true });
      rmSync(fix.home, { recursive: true, force: true });
      rmSync(hd, { recursive: true, force: true });
    }
  });

  it('is idempotent: re-run on the existing clone fast-forwards and re-installs', () => {
    const fix = buildRemote();
    const hd = newInstallDir();
    try {
      expect(runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd }).status).toBe(0);
      const res = runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd });
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('Refreshing existing clone');
      expect(existsSync(join(hd, 'install-ran.marker'))).toBe(true);
    } finally {
      rmSync(fix.root, { recursive: true, force: true });
      rmSync(fix.home, { recursive: true, force: true });
      rmSync(hd, { recursive: true, force: true });
    }
  });

  it('refuses to clobber an existing clone that has local changes', () => {
    const fix = buildRemote();
    const hd = newInstallDir();
    try {
      expect(runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd }).status).toBe(0);
      writeFileSync(join(hd, 'scripts', 'install.sh'), '#!/usr/bin/env bash\necho changed\n');
      execSync('git add -A', { cwd: hd });
      const res = runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('local changes');
    } finally {
      rmSync(fix.root, { recursive: true, force: true });
      rmSync(fix.home, { recursive: true, force: true });
      rmSync(hd, { recursive: true, force: true });
    }
  });

  it('errors clearly when the pinned ref does not exist', () => {
    const fix = buildRemote();
    const hd = newInstallDir();
    try {
      const res = runRemoteInstall({ repo: fix.remote, home: fix.home, homeDir: hd, ref: 'nope-branch' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("ref 'nope-branch' not found");
      expect(existsSync(join(hd, 'scripts', 'install.sh'))).toBe(false);
    } finally {
      rmSync(fix.root, { recursive: true, force: true });
      rmSync(fix.home, { recursive: true, force: true });
      rmSync(hd, { recursive: true, force: true });
    }
  });
});

beforeAll(() => {
  if (!GIT) {
    // eslint-disable-next-line no-console
    console.warn('[tests/remote-install.test.ts] git not available — skipping');
  }
});