import type { HarnessConfig, SdlcRole } from '../config.js';
import type { SdlcAgents } from '../mastra/agents.js';
import { ROLE_TOOLS } from '../mastra/agents.js';
import { GitOps, slugify } from './git.js';
import type {
  HarnessHooks,
  HarnessLogEntry,
  HarnessRunResult,
  HarnessRunState,
  HarnessStep,
} from './types.js';

const APPROVAL_YES = new Set(['y', 'yes', 'ok', 'okay', 'proceed', 'go', 'approve', 'approved', 'confirm', 'lgtm']);

function parseVerdict(text: string, positive: string[], negative: string[]): 'positive' | 'negative' | 'unknown' {
  const upper = text.toUpperCase();
  // Negative checked first so "CHANGES_REQUESTED" wins over a stray "APPROVE".
  for (const neg of negative) if (upper.includes(neg.toUpperCase())) return 'negative';
  for (const pos of positive) if (upper.includes(pos.toUpperCase())) return 'positive';
  return 'unknown';
}

export interface HarnessRunnerOptions {
  agents: SdlcAgents;
  config: HarnessConfig;
  git: GitOps;
  hooks: HarnessHooks;
}

export class HarnessRunner {
  private readonly agents: SdlcAgents;
  private readonly cfg: HarnessConfig;
  private readonly git: GitOps;
  private readonly hooks: HarnessHooks;
  private state: HarnessRunState;

  constructor(opts: HarnessRunnerOptions) {
    this.agents = opts.agents;
    this.cfg = opts.config;
    this.git = opts.git;
    this.hooks = opts.hooks;
    this.state = {
      step: 'intake',
      feature: '',
      reviewAttempts: 0,
      testAttempts: 0,
      log: [],
    };
  }

  status(): HarnessRunState {
    return { ...this.state, log: [...this.state.log] };
  }

  private async step(phase: 'start' | 'end'): Promise<void> {
    await this.hooks.onStep?.(this.state.step, phase);
  }

  private async info(text: string): Promise<void> {
    await this.hooks.onInfo?.(text);
  }

  /** Drive one agent turn: stream, render deltas, record the final text. */
  private async callAgent(
    role: SdlcRole,
    step: HarnessStep,
    prompt: string,
  ): Promise<string> {
    this.state.step = step;
    await this.step('start');
    const hasTools = (ROLE_TOOLS[role] as string[]).length > 0;
    const streamOptions = hasTools
      ? { maxSteps: this.cfg.maxAgentSteps, toolChoice: 'auto' as const }
      : { maxSteps: this.cfg.maxAgentSteps };
    const out = await this.agents[role].stream(prompt, streamOptions);
    let full = '';
    for await (const delta of out.textStream) {
      full += delta;
      await this.hooks.onAgentDelta?.(role, delta, full);
    }
    const text = (await out.text) || full;
    await this.hooks.onAgentMessage?.(role, text);
    const entry: HarnessLogEntry = { step, agent: role, text };
    this.state.log.push(entry);
    await this.step('end');
    return text;
  }

  private async suspend(reason: string, prompt: string): Promise<string> {
    if (!this.hooks.onSuspend) {
      // No human in the loop available → default to proceeding.
      await this.info(`(no human gate; auto-proceeding: ${reason})`);
      return 'ok';
    }
    return this.hooks.onSuspend(reason, prompt);
  }

  async run(featurePrompt: string): Promise<HarnessRunResult> {
    this.state.feature = featurePrompt;

    // --- Preflight: only commit into a clean git tree so we never bundle the
    // user's pre-existing work into the harness commit. ---
    const isRepo = await this.git.isGitRepo();
    if (!isRepo) {
      return this.end(false, 'not-a-git-repo', `Not a git repo: ${this.cfg.repoRoot}`);
    }
    if (this.cfg.autoCommit) {
      const clean = await this.git.isCleanTree();
      if (!clean) {
        return this.end(
          false,
          'dirty-tree',
          'Working tree is not clean. Commit or stash your changes before running the harness with --auto-commit.',
        );
      }
    }

    // --- Intake (orchestrator) ---
    let plan = await this.callAgent(
      'orchestrator',
      'intake',
      `Feature request:\n${featurePrompt}\n\nProduce the plan per your output contract.`,
    );

    let confirmed = featurePrompt;
    if (this.cfg.humanInLoopIntake) {
      const answer = await this.suspend(
        'intake',
        'Review the orchestrator plan above. Reply "ok" to proceed, or describe refinements.',
      );
      const trimmed = answer.trim();
      if (trimmed && !APPROVAL_YES.has(trimmed.toLowerCase())) {
        confirmed = `${featurePrompt}\n\nHuman refinement: ${trimmed}`;
        // Re-plan once with the refinement folded in.
        plan = await this.callAgent(
          'orchestrator',
          'intake',
          `Feature request:\n${confirmed}\n\nProduce the plan per your output contract.`,
        );
      }
    }
    this.state.confirmedFeature = confirmed;
    await this.info(`Plan confirmed. Proceeding to requirements.`);

    // --- Requirements (product) ---
    const criteria = await this.callAgent(
      'product',
      'requirements',
      `Feature:\n${confirmed}\n\nOrchestrator plan:\n${plan}\n\nProduce the acceptance criteria per your output contract.`,
    );

    // --- Design (architect) ---
    const design = await this.callAgent(
      'architect',
      'design',
      `Feature:\n${confirmed}\n\nAcceptance criteria:\n${criteria}\n\nExplore the repo, then produce the change set per your output contract.`,
    );

    // --- Implement (coder) — first pass ---
    let coderText = await this.callAgent(
      'coder',
      'implement',
      `Feature:\n${confirmed}\n\nDesign / change set:\n${design}\n\nImplement the change set. Run the build via the shell tool and fix errors.`,
    );

    // --- Review loop (reviewer ⇄ coder) ---
    for (let i = 0; i <= this.cfg.maxReviewCycles; i++) {
      const review = await this.callAgent(
        'reviewer',
        'review',
        `Feature:\n${confirmed}\n\nDesign:\n${design}\n\nAcceptance criteria:\n${criteria}\n\nCoder report:\n${coderText}\n\nReview the current diff (use git_diff) and produce your verdict.`,
      );
      const verdict = parseVerdict(review, ['APPROVE'], ['CHANGES_REQUESTED']);
      if (verdict === 'positive') {
        this.state.lastReviewerVerdict = 'APPROVE';
        await this.info('Reviewer approved. Proceeding to tests.');
        break;
      }
      this.state.lastReviewerVerdict = 'CHANGES_REQUESTED';
      if (i === this.cfg.maxReviewCycles) {
        await this.info('Max review cycles reached; proceeding to tests with outstanding notes.');
        break;
      }
      this.state.reviewAttempts += 1;
      await this.info(`Reviewer requested changes (attempt ${this.state.reviewAttempts}). Re-implementing.`);
      coderText = await this.callAgent(
        'coder',
        'implement',
        `Feature:\n${confirmed}\n\nDesign:\n${design}\n\nReviewer notes:\n${review}\n\nAddress the review notes and re-run the build.`,
      );
    }

    // --- Test loop (tester ⇄ coder) ---
    for (let i = 0; i <= this.cfg.maxTestCycles; i++) {
      const testReport = await this.callAgent(
        'tester',
        'test',
        `Feature:\n${confirmed}\n\nAcceptance criteria:\n${criteria}\n\nCoder report:\n${coderText}\n\nWrite/run tests (npm test) and produce your verdict.`,
      );
      const verdict = parseVerdict(testReport, ['TESTS_PASSED'], ['TESTS_FAILED']);
      if (verdict === 'positive') {
        this.state.lastTesterVerdict = 'TESTS_PASSED';
        await this.info('Tests passed.');
        break;
      }
      this.state.lastTesterVerdict = 'TESTS_FAILED';
      if (i === this.cfg.maxTestCycles) {
        await this.info('Max test cycles reached; proceeding to finalize with failing tests.');
        break;
      }
      this.state.testAttempts += 1;
      await this.info(`Tests failed (attempt ${this.state.testAttempts}). Re-implementing against test failures.`);
      coderText = await this.callAgent(
        'coder',
        'implement',
        `Feature:\n${confirmed}\n\nTest failures:\n${testReport}\n\nFix the failing tests and re-run them.`,
      );
    }

    // --- Finalize (orchestrator summary + optional commit) ---
    this.state.step = 'finalize';
    const summary = await this.callAgent(
      'orchestrator',
      'finalize',
      `Feature:\n${confirmed}\n\nProduce a concise markdown summary of what was implemented, for the human to review. Reference reviewer verdict (${this.state.lastReviewerVerdict ?? 'unknown'}) and tester verdict (${this.state.lastTesterVerdict ?? 'unknown'}).`,
    );

    let branch: string | undefined;
    let commit: string | undefined;
    let endReason = 'completed';

    if (this.cfg.autoCommit) {
      const result = await this.commit(summary);
      branch = result?.branch;
      commit = result?.commit;
    } else {
      const approval = await this.suspend(
        'finalize',
        'Review the summary above. Reply "ok" to commit the work on a new feature branch, or anything else to skip the commit.',
      );
      if (APPROVAL_YES.has(approval.trim().toLowerCase())) {
        const result = await this.commit(summary);
        branch = result?.branch;
        commit = result?.commit;
      } else {
        endReason = 'completed-no-commit';
        await this.info('Skipping commit as requested.');
      }
    }

    return this.end(true, endReason, summary, { branch, commit });
  }

  private async commit(_summary: string): Promise<{ branch: string; commit: string } | undefined> {
    try {
      const slug = slugify(this.state.feature);
      const message = `harness: ${this.state.feature.slice(0, 72).replace(/\n/g, ' ')}`;
      const result = await this.git.createBranchAndCommit(slug, message);
      await this.info(`Committed on branch ${result.branch} (${result.commit.slice(0, 9)}).`);
      return result;
    } catch (err) {
      await this.info(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private end(
    ok: boolean,
    endReason: string,
    summary: string,
    extra?: { branch?: string; commit?: string },
  ): HarnessRunResult {
    return {
      ok,
      endReason,
      summary,
      log: this.state.log,
      ...extra,
    };
  }
}