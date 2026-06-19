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

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…[truncated ${buf.length - maxBytes} bytes]`;
}

/** Thrown when an agent turn is stopped — either by the user (Esc), by the
 * per-turn timeout, by an output cap, or by an unavailable-tool error from the
 * LLM. `run()` catches it and ends the run with a friendly `endReason` instead
 * of surfacing a raw exception. */
export class HarnessAbortError extends Error {
  readonly reason: 'user' | 'timeout' | 'output-cap' | 'tool-error';
  constructor(reason: 'user' | 'timeout' | 'output-cap' | 'tool-error') {
    super(
      reason === 'tool-error'
        ? 'Agent tried to call an unavailable tool'
        : reason === 'output-cap'
          ? 'Agent turn exceeded the output size limit'
          : reason === 'timeout'
            ? 'Agent turn timed out'
            : 'Harness stopped by user',
    );
    this.name = 'HarnessAbortError';
    this.reason = reason;
  }
}

function parseVerdict(text: string, positive: string[], negative: string[]): 'positive' | 'negative' | 'unknown' {
  const upper = text.toUpperCase();
  // Negative checked first so "CHANGES_REQUESTED" wins over a stray "APPROVE".
  for (const neg of negative) if (upper.includes(neg.toUpperCase())) return 'negative';
  for (const pos of positive) if (upper.includes(pos.toUpperCase())) return 'positive';
  return 'unknown';
}

/** Detect AI SDK / Mastra "Model tried to call unavailable tool" errors. */
function isNoSuchToolError(err: unknown): { toolName: string | undefined } | undefined {
  if (err === null || err === undefined) return undefined;
  const msg = err instanceof Error ? err.message : String(err);
  const isMatch =
    /NoSuchToolError|AI_NoSuchToolError|Model tried to call unavailable tool/i.test(msg) ||
    (err instanceof Error &&
      (err.name === 'NoSuchToolError' ||
        err.name === 'AI_NoSuchToolError' ||
        (err.cause instanceof Error && /NoSuchToolError|AI_NoSuchToolError/i.test(err.cause.name))));
  if (!isMatch) return undefined;
  let toolName: string | undefined;
  const match = msg.match(/unavailable tool ['"]([^'"]+)['"]/i);
  if (match) toolName = match[1];
  else {
    const generic = msg.match(/tool ['"]([^'"]+)['"]/i);
    if (generic) toolName = generic[1];
  }
  return { toolName };
}

/** Detect AI SDK / Mastra "Invalid arguments for tool" errors. */
function isInvalidToolArgumentsError(err: unknown): { toolName: string | undefined } | undefined {
  if (err === null || err === undefined) return undefined;
  const msg = err instanceof Error ? err.message : String(err);
  const isMatch =
    /InvalidToolArgumentsError|AI_InvalidToolArgumentsError|Invalid arguments for tool/i.test(msg) ||
    (err instanceof Error &&
      (err.name === 'InvalidToolArgumentsError' ||
        err.name === 'AI_InvalidToolArgumentsError' ||
        (err.cause instanceof Error && /InvalidToolArgumentsError|AI_InvalidToolArgumentsError/i.test(err.cause.name))));
  if (!isMatch) return undefined;
  let toolName: string | undefined;
  const match = msg.match(/Invalid arguments for tool (\w+)/i);
  if (match) toolName = match[1];
  else {
    const generic = msg.match(/tool (\w+):/i);
    if (generic) toolName = generic[1];
  }
  return { toolName };
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
  /** Abort signal for the in-flight run (set by `run`); propagated to each
   *  agent stream so Esc can stop the flow mid-turn. */
  private abortSignal?: AbortSignal;

  private runStartedAt = 0;

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

  /** Drive one agent turn: stream, render deltas, record the final text.
   *
   *  `this.abortSignal` (set by `run`) propagates to the agent stream so Esc
   *  can stop the flow mid-turn. A per-turn *inactivity* timeout
   *  (cfg.agentTurnTimeoutMs) aborts stalled LLM streams — the timer resets on
   *  every streamed token, so a slow-but-productive turn is not killed just
   *  for being long. An optional hard wall-clock cap
   *  (cfg.agentTurnHardTimeoutMs) bounds runaway turns and is never reset.
   *
   *  When `recoverOnTimeout` is true (the implement/review/test work loops),
   *  a timeout does NOT end the run: we keep whatever text streamed so far,
   *  warn via `onInfo`, and return it so the loop can treat the turn as a
   *  failed attempt and continue. Planning steps pass `false` (default) so a
   *  timed-out plan/design/summary still aborts the run. */
  private async callAgent(
    role: SdlcRole,
    step: HarnessStep,
    prompt: string,
    recoverOnTimeout = false,
  ): Promise<string> {
    if (this.cfg.maxWallClockMs && this.cfg.maxWallClockMs > 0) {
      const elapsed = Date.now() - this.runStartedAt;
      if (elapsed > this.cfg.maxWallClockMs) {
        throw new HarnessAbortError('timeout');
      }
    }
    this.state.step = step;
    await this.step('start');
    const hasTools = (ROLE_TOOLS[role] as string[]).length > 0;
    const streamOptions = hasTools
      ? { maxSteps: this.cfg.maxAgentSteps, toolChoice: 'auto' as const }
      : { maxSteps: this.cfg.maxAgentSteps };

    const abortSignal = this.abortSignal;
    const turnController = new AbortController();
    let abortReason: 'user' | 'timeout' | 'output-cap' | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortReason = 'user';
        turnController.abort();
      } else {
        abortSignal.addEventListener(
          'abort',
          () => {
            abortReason = 'user';
            turnController.abort();
          },
          { once: true },
        );
      }
    }
    const inactivityMs = this.cfg.agentTurnTimeoutMs ?? 0;
    const hardMs = this.cfg.agentTurnHardTimeoutMs ?? 0;
    const armInactivity = (): void => {
      if (inactivityMs > 0) {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          abortReason = 'timeout';
          turnController.abort();
        }, inactivityMs);
      }
    };
    // Hoisted out of `try` so the catch block can recover the partial text
    // on a (recoverable) timeout.
    const chunks: string[] = [];
    let byteLength = 0;
    let full = '';
    // Arm the inactivity timer before the stream starts so a model that never
    // emits a first token is still caught.
    armInactivity();
    if (hardMs > 0) {
      hardTimer = setTimeout(() => {
        abortReason = 'timeout';
        turnController.abort();
      }, hardMs);
    }

    try {
      const out = await this.agents[role].stream(prompt, { ...streamOptions, abortSignal: turnController.signal });
      for await (const delta of out.textStream) {
        chunks.push(delta);
        byteLength += Buffer.byteLength(delta, 'utf8');
        // A real token arrived → the stream isn't stalled; reset the
        // inactivity window. (Hard cap is intentionally NOT reset.)
        armInactivity();
        await this.hooks.onAgentDelta?.(role, delta, chunks.join(''));
        if (byteLength > this.cfg.maxTurnOutputBytes) {
          abortReason = 'output-cap';
          turnController.abort();
          await this.info(`${role} turn exceeded max output size (${this.cfg.maxTurnOutputBytes} bytes); stopping.`);
          break;
        }
      }
      full = chunks.join('');
      let text: string;
      if (abortReason === 'output-cap') {
        text = truncate(full, this.cfg.maxTurnOutputBytes);
      } else {
        try {
          text = (await out.text) || full;
        } catch {
          text = full;
        }
      }
      await this.hooks.onAgentMessage?.(role, text);
      const entry: HarnessLogEntry = { step, agent: role, text };
      this.state.log.push(entry);
      await this.step('end');
      return text;
    } catch (err) {
      const noTool = isNoSuchToolError(err);
      if (noTool) {
        const name = noTool.toolName ?? 'unknown';
        await this.info(`${role} tried to call unavailable tool '${name}'. Stopping turn.`);
        throw new HarnessAbortError('tool-error');
      }
      const invalidArgs = isInvalidToolArgumentsError(err);
      if (invalidArgs) {
        const name = invalidArgs.toolName ?? 'unknown';
        await this.info(`${role} sent invalid arguments to tool '${name}'. Stopping turn.`);
        throw new HarnessAbortError('tool-error');
      }
      if ((abortReason === 'timeout' || abortReason === 'output-cap') && recoverOnTimeout) {
        // Keep whatever streamed before the stall and let the caller's loop
        // decide what to do (typically: treat as a failed attempt, retry the
        // next cycle, or proceed to finalize with the work done so far).
        return this.recoverFromTimeout(role, step, full);
      }
      if (abortReason !== undefined) {
        throw new HarnessAbortError(abortReason);
      }
      throw err;
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (hardTimer) clearTimeout(hardTimer);
    }
  }

  /** Called when a recoverable agent turn is stopped (timeout or output cap):
   *  surface a warning, log the partial text (if any) so it isn't lost, and
   *  return it for the caller to feed downstream. The underlying stream error
   *  is swallowed. */
  private async recoverFromTimeout(role: SdlcRole, step: HarnessStep, partial: string): Promise<string> {
    await this.info(`${role} turn stopped before completion; recovering partial output and continuing.`);
    if (partial.length > 0) {
      const entry: HarnessLogEntry = { step, agent: role, text: partial };
      this.state.log.push(entry);
    }
    await this.step('end');
    return partial;
  }

  private async suspend(reason: string, prompt: string): Promise<string> {
    if (!this.hooks.onSuspend) {
      // No human in the loop available → default to proceeding.
      await this.info(`(no human gate; auto-proceeding: ${reason})`);
      return 'ok';
    }
    return this.hooks.onSuspend(reason, prompt);
  }

  async run(featurePrompt: string, abortSignal?: AbortSignal): Promise<HarnessRunResult> {
    this.abortSignal = abortSignal;
    try {
      return await this.runBody(featurePrompt);
    } catch (err) {
      if (err instanceof HarnessAbortError) {
        return this.end(
          false,
          err.reason === 'timeout' || err.reason === 'output-cap'
            ? 'timeout'
            : err.reason === 'tool-error'
              ? 'tool-error'
              : 'aborted',
          err.message,
        );
      }
      throw err;
    }
  }

  private async runBody(featurePrompt: string): Promise<HarnessRunResult> {
    this.runStartedAt = Date.now();
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

    // --- Planning (product ⇄ architect) ---
    // The plan is built collaboratively from the feature prompt: product turns
    // the request into acceptance criteria, architect turns those (plus the
    // feature) into a change set. The orchestrator no longer plans at intake;
    // it only writes the final summary. Optional refinement rounds let product
    // and architect react to each other's output (HARNESS_MAX_PLAN_CYCLES).
    let { criteria, design } = await this.plan(featurePrompt);
    for (let i = 0; i < this.cfg.maxPlanCycles; i++) {
      ({ criteria, design } = await this.refinePlan(featurePrompt, criteria, design));
    }

    let confirmed = featurePrompt;
    if (this.cfg.humanInLoopIntake) {
      // The human reviews the combined product+architect plan. Don't claim a
      // plan is "above" when both came back empty — phrase it honestly.
      const planText = `${criteria}\n\n${design}`;
      const hasPlan = planText.trim().length > 0;
      const ask = hasPlan
        ? 'Review the plan above (product criteria + architect change set). Reply "ok" to proceed, or describe refinements.'
        : 'Product/architect produced no plan (empty output). Reply "ok" to proceed with just the feature request, or describe what you want built.';
      const answer = await this.suspend('intake', ask);
      const trimmed = answer.trim();
      if (trimmed && !APPROVAL_YES.has(trimmed.toLowerCase())) {
        confirmed = `${featurePrompt}\n\nHuman refinement: ${trimmed}`;
        // Re-plan once with the refinement folded in.
        ({ criteria, design } = await this.plan(confirmed));
      }
    }
    this.state.confirmedFeature = confirmed;
    await this.info(`Plan confirmed. Proceeding to implementation.`);

    // --- Implement (coder) — first pass ---
    let coderText = await this.callAgent(
      'coder',
      'implement',
      `Feature:\n${confirmed}\n\nDesign / change set:\n${design}\n\nImplement the change set. Run the build via the shell tool and fix errors.`,
      true,
    );

    // --- Review loop (reviewer ⇄ coder) ---
    for (let i = 0; i <= this.cfg.maxReviewCycles; i++) {
      const review = await this.callAgent(
        'reviewer',
        'review',
        `Feature:\n${confirmed}\n\nDesign:\n${design}\n\nAcceptance criteria:\n${criteria}\n\nCoder report:\n${coderText}\n\nReview the current diff (use git_diff) and produce your verdict.`,
        true,
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
        true,
      );
    }

    // --- Test loop (tester ⇄ coder) ---
    for (let i = 0; i <= this.cfg.maxTestCycles; i++) {
      const testReport = await this.callAgent(
        'tester',
        'test',
        `Feature:\n${confirmed}\n\nAcceptance criteria:\n${criteria}\n\nCoder report:\n${coderText}\n\nWrite/run tests (npm test) and produce your verdict.`,
        true,
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
        true,
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

  /** One planning pass: product produces acceptance criteria from the feature,
   *  architect produces a change set from the feature + criteria. Both derive
   *  directly from the feature prompt (no orchestrator plan in between). */
  private async plan(feature: string): Promise<{ criteria: string; design: string }> {
    const criteria = await this.callAgent(
      'product',
      'requirements',
      `Feature:\n${feature}\n\nProduce the acceptance criteria per your output contract.`,
    );
    const design = await this.callAgent(
      'architect',
      'design',
      `Feature:\n${feature}\n\nAcceptance criteria:\n${criteria}\n\nExplore the repo, then produce the change set per your output contract.`,
    );
    return { criteria, design };
  }

  /** A product ⇄ architect refinement round: product refines the criteria in
   *  light of the architect's design, then architect refines the change set in
   *  light of the refined criteria. */
  private async refinePlan(
    feature: string,
    criteria: string,
    design: string,
  ): Promise<{ criteria: string; design: string }> {
    const refinedCriteria = await this.callAgent(
      'product',
      'requirements',
      `Feature:\n${feature}\n\nCurrent acceptance criteria:\n${criteria}\n\nProposed design:\n${design}\n\nRefine the acceptance criteria in light of the design. Output the updated criteria per your output contract.`,
    );
    const refinedDesign = await this.callAgent(
      'architect',
      'design',
      `Feature:\n${feature}\n\nAcceptance criteria:\n${refinedCriteria}\n\nCurrent design:\n${design}\n\nRefine the change set in light of the refined criteria. Explore the repo, then output the updated change set per your output contract.`,
    );
    return { criteria: refinedCriteria, design: refinedDesign };
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