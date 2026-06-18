import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_SH = join(REPO_ROOT, 'scripts', 'update.sh');

function gitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();

/** Build a throwaway "package" git repo with a stub install.sh, plus a bare remote. */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'guanaco-update-'));
  const remote = join(root, 'remote.git');
  const pkg = join(root, 'pkg');
  const home = mkdtempSync(join(tmpdir(), 'guanaco-home-'));
  const bin = mkdtempSync(join(tmpdir(), 'guanaco-bin-'));

  // Bare remote (the "upstream").
  execSync(`git init --bare -q "${remote}"`);
  // Clone that becomes the installed package dir.
  execSync(`git clone -q "${remote}" "${pkg}"`);
  execSync('git config user.email t@t.t', { cwd: pkg });
  execSync('git config user.name t', { cwd: pkg });
  execSync('git branch --set-upstream-to=origin/HEAD 2>/dev/null || true', { cwd: pkg });

  // Minimal package layout: a stub install.sh that records it ran, and the real
  // update.sh so the committed tree looks like a guanaco-cli checkout.
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  writeFileSync(
    join(pkg, 'scripts', 'install.sh'),
    [
      '#!/usr/bin/env bash',
      '# stub: stand in for the real installer so tests avoid npm/build.',
      `echo "stub-install ran in $(pwd)" > "${join(pkg, 'updated.marker')}"`,
      'exit 0',
    ].join('\n'),
  );
  copyFileSync(UPDATE_SH, join(pkg, 'scripts', 'update.sh'));
  execSync('git add -A', { cwd: pkg });
  execSync('git commit -q -m "initial"', { cwd: pkg });
  execSync('git push -q origin HEAD', { cwd: pkg });

  // Simulate an installer state file pointing at the package.
  mkdirSync(join(home, '.config', 'guanaco'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'guanaco', 'install.env'),
    `# Written by guanaco-cli installer.\nGUANACO_BIN_DIR=${bin}\nGUANACO_PKG_DIR=${pkg}\n`,
  );

  return { root, remote, pkg, home, bin };
}

describe('scripts/update.sh', { skip: !GIT }, () => {
  it('pulls the latest and rebuilds when the tree is clean', () => {
    const { root, remote, pkg, home } = buildFixture();
    try {
      // Make a new commit on the remote (simulating upstream moving ahead).
      const upstreamClone = mkdtempSync(join(tmpdir(), 'guanaco-up-'));
      execSync(`git clone -q "${remote}" "${upstreamClone}"`);
      execSync('git config user.email u@u.u', { cwd: upstreamClone });
      execSync('git config user.name u', { cwd: upstreamClone });
      writeFileSync(join(upstreamClone, 'NEW'), 'new content\n');
      execSync('git add -A', { cwd: upstreamClone });
      execSync('git commit -q -m "upstream change"', { cwd: upstreamClone });
      execSync('git push -q origin HEAD', { cwd: upstreamClone });

      // Before update, the pkg does not have NEW and has no marker.
      expect(existsSync(join(pkg, 'NEW'))).toBe(false);
      expect(existsSync(join(pkg, 'updated.marker'))).toBe(false);

      const res = spawnSync('bash', [UPDATE_SH], {
        cwd: root,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Pulling latest');
      expect(res.stdout).toContain('Rebuilding');

      // Pulled the new commit and ran the (stub) installer.
      expect(existsSync(join(pkg, 'NEW'))).toBe(true);
      expect(existsSync(join(pkg, 'updated.marker'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to pull over uncommitted local changes', () => {
    const { root, pkg, home } = buildFixture();
    try {
      // Dirty the tracked tree.
      writeFileSync(join(pkg, 'scripts', 'install.sh'), '#!/usr/bin/env bash\necho changed\n');
      execSync('git add -A', { cwd: pkg }); // staged change -> diff --cached not quiet

      const res = spawnSync('bash', [UPDATE_SH], {
        cwd: root,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('local changes');
      // Confirm it did NOT run the stub installer.
      expect(existsSync(join(pkg, 'updated.marker'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('errors clearly when there is no install record', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'guanaco-nostate-'));
    try {
      const res = spawnSync('bash', [UPDATE_SH], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: emptyHome },
        encoding: 'utf8',
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('no install record');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

beforeAll(() => {
  if (!GIT) {
    // eslint-disable-next-line no-console
    console.warn('[tests/update.test.ts] git not available — skipping update.sh tests');
  }
});