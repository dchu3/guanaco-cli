import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface GitOpsOptions {
  repoRoot: string;
  /** Optional injectable exec (for tests). */
  execImpl?: typeof execAsync;
}

export class GitOps {
  private readonly run: typeof execAsync;

  constructor(private readonly opts: GitOpsOptions) {
    this.run = opts.execImpl ?? execAsync;
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await this.run('git rev-parse --abbrev-ref HEAD', { cwd: this.opts.repoRoot });
    return stdout.trim();
  }

  /** True when there are no staged or unstaged tracked changes. */
  async isCleanTree(): Promise<boolean> {
    const { stdout } = await this.run('git status --porcelain', { cwd: this.opts.repoRoot });
    return stdout.trim().length === 0;
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.run('git rev-parse --is-inside-work-tree', { cwd: this.opts.repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  /** Stash all working-tree changes (including untracked files) under `message`.
   *  Caller is responsible for confirming the tree is dirty first. */
  async stashPush(message: string): Promise<void> {
    await this.run(`git stash push -u -m ${shellQuote(message)}`, { cwd: this.opts.repoRoot });
  }

  /** Pop the top of the stash stack back into the working tree (best-effort).
   *  On a pop conflict git keeps the stash entry; the caller surfaces a note. */
  async stashPop(): Promise<void> {
    await this.run('git stash pop', { cwd: this.opts.repoRoot });
  }

  /** Switch to an existing branch. Used to restore the original branch after
   *  a harness run committed on a feature branch. */
  async checkoutBranch(branch: string): Promise<void> {
    await this.run(`git checkout ${shellQuote(branch)}`, { cwd: this.opts.repoRoot });
  }

  async createBranchAndCommit(branch: string, message: string): Promise<{ branch: string; commit: string }> {
    await this.run(`git checkout -b ${shellQuote(branch)}`, { cwd: this.opts.repoRoot });
    await this.run('git add -A', { cwd: this.opts.repoRoot });
    await this.run(`git commit -m ${shellQuote(message)}`, { cwd: this.opts.repoRoot });
    const { stdout } = await this.run('git rev-parse HEAD', { cwd: this.opts.repoRoot });
    return { branch, commit: stdout.trim() };
  }
}

/** Minimal POSIX-ish single-quoting for git branch/commit messages. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Slugify a feature prompt into a branch-safe suffix. */
export function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const base = slug || 'feature';
  return `harness-${base}`;
}