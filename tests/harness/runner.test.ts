import { describe, it, expect } from 'vitest';
import type { AgentLike, SdlcAgents } from '../../src/mastra/agents.js';
import type { SdlcRole } from '../../src/config.js';
import { HarnessRunner } from '../../src/harness/runner.js';
import type { HarnessConfig } from '../../src/config.js';
import { GitOps } from '../../src/harness/git.js';
import type { HarnessHooks } from '../../src/harness/types.js';

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (cmd: string, opts?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<ExecResult>;

/** Build a stub agent that returns scripted text per call (cycling the last entry). */
function stubAgent(role: SdlcRole, script: string[] | ((call: number) => string)): AgentLike {
  let calls = 0;
  return {
    id: role,
    stream: async () => {
      const text = typeof script === 'function' ? script(calls) : script[Math.min(calls, script.length - 1)];
      calls++;
      async function* gen(): AsyncGenerator<string> {
        yield text;
      }
      return { textStream: gen(), text: Promise.resolve(text) };
    },
  };
}

/** A stub agent that hangs mid-stream until its abortSignal fires, then throws
 * an AbortError — mirroring how a real stalled/slow LLM stream behaves. */
function hangUntilAbort(role: SdlcRole): AgentLike {
  return {
    id: role,
    stream: async (_prompt, options) => {
      const sig = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      if (sig?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      async function* gen(): AsyncGenerator<string> {
        if (!sig) {
          yield '';
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          sig.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        });
      }
      return { textStream: gen(), text: Promise.resolve('') };
    },
  };
}

/** Build a stub agent whose stream() throws a Mastra/AI SDK NoSuchToolError. */
function stubAgentThrowsNoSuchTool(role: SdlcRole, toolName: string): AgentLike {
  return {
    id: role,
    stream: async () => {
      const err = new Error(
        `NoSuchToolError [AI_NoSuchToolError]: Model tried to call unavailable tool '${toolName}'. Available tools: read_file, grep, git_diff.`,
      );
      err.name = 'AI_NoSuchToolError';
      throw err;
    },
  };
}

function makeAgents(overrides: Partial<Record<SdlcRole, string[] | ((c: number) => string)>> = {}): SdlcAgents {
  const defaults: Record<SdlcRole, string[]> = {
    orchestrator: ['PLAN'],
    product: ['CRITERIA'],
    architect: ['DESIGN'],
    coder: ['CHANGES'],
    reviewer: ['## Verdict\nAPPROVE'],
    tester: ['## Verdict\nTESTS_PASSED'],
  };
  return {
    orchestrator: stubAgent('orchestrator', overrides.orchestrator ?? defaults.orchestrator),
    product: stubAgent('product', overrides.product ?? defaults.product),
    architect: stubAgent('architect', overrides.architect ?? defaults.architect),
    coder: stubAgent('coder', overrides.coder ?? defaults.coder),
    reviewer: stubAgent('reviewer', overrides.reviewer ?? defaults.reviewer),
    tester: stubAgent('tester', overrides.tester ?? defaults.tester),
  };
}

function makeConfig(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    provider: 'local',
    roleModels: {},
    maxReviewCycles: 2,
    maxTestCycles: 2,
    maxPlanCycles: 0,
    maxAgentSteps: 4,
    maxTurnOutputBytes: 1_000_000,
    maxWallClockMs: 0,
    humanInLoopFinalize: true,
    humanInLoopIntake: false,
    toolTimeoutMs: 5000,
    repoRoot: '/tmp/repo',
    autoCommit: false,
    ...over,
  };
}

/** Fake git exec that tracks the commands it ran and can simulate clean/dirty tree + commit. */
function makeFakeGit(opts: { clean?: boolean; isRepo?: boolean } = {}): { git: GitOps; cmds: string[] } {
  const cmds: string[] = [];
  const clean = opts.clean ?? true;
  const isRepo = opts.isRepo ?? true;
  const execImpl: ExecFn = async (cmd) => {
    cmds.push(cmd);
    const c = cmd.trim();
    if (c === 'git rev-parse --is-inside-work-tree') {
      if (!isRepo) throw new Error('not a repo');
      return { stdout: 'true', stderr: '' };
    }
    if (c === 'git status --porcelain') return { stdout: clean ? '' : 'M  foo.txt', stderr: '' };
    if (c.startsWith('git checkout -b')) return { stdout: '', stderr: '' };
    if (c === 'git add -A') return { stdout: '', stderr: '' };
    if (c.startsWith('git commit -m')) return { stdout: '', stderr: '' };
    if (c === 'git rev-parse HEAD') return { stdout: 'deadbeefcafebabe1234', stderr: '' };
    throw new Error(`fake git: unexpected command: ${c}`);
  };
  return { git: new GitOps({ repoRoot: '/tmp/repo', execImpl }), cmds };
}

const noSuspendHooks: HarnessHooks = {
  onSuspend: async () => 'ok',
};

describe('HarnessRunner', () => {
  it('ends with reason "tool-error" when a model calls an unavailable tool', async () => {
    const agents = makeAgents();
    agents.reviewer = stubAgentThrowsNoSuchTool('reviewer', 'shell');
    const { git } = makeFakeGit();
    const infos: string[] = [];
    const hooks: HarnessHooks = {
      onSuspend: async () => 'no',
      onInfo: (t) => void infos.push(t),
    };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: false }),
      git,
      hooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('tool-error');
    expect(res.summary).toMatch(/unavailable tool/i);
    expect(infos.some((t) => /reviewer tried to call unavailable tool 'shell'/i.test(t))).toBe(true);
  });

  it('runs the happy path and commits when autoCommit is true', async () => {
    const agents = makeAgents();
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('add a hello command');

    expect(res.ok).toBe(true);
    expect(res.endReason).toBe('completed');
    expect(res.branch).toMatch(/^harness-/);
    expect(res.commit).toBe('deadbeefcafebabe1234');
    // Six agent turns in order: product+architect plan, then implement/review/test,
    // then the orchestrator summary at finalize (orchestrator no longer plans).
    expect(res.log.map((l) => `${l.step}:${l.agent}`)).toEqual([
      'requirements:product',
      'design:architect',
      'implement:coder',
      'review:reviewer',
      'test:tester',
      'finalize:orchestrator',
    ]);
  });

  it('loops reviewer -> coder when CHANGES_REQUESTED, then approves', async () => {
    const agents = makeAgents({
      reviewer: ['## Verdict\nCHANGES_REQUESTED\nfix types', '## Verdict\nAPPROVE'],
    });
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('fix the bug');

    expect(res.ok).toBe(true);
    const coderTurns = res.log.filter((l) => l.agent === 'coder').length;
    const reviewerTurns = res.log.filter((l) => l.agent === 'reviewer').length;
    expect(coderTurns).toBe(2);
    expect(reviewerTurns).toBe(2);
    expect(runner.status().reviewAttempts).toBe(1);
  });

  it('loops tester -> coder when TESTS_FAILED, then passes', async () => {
    const agents = makeAgents({
      tester: ['## Verdict\nTESTS_FAILED\nmissing case', '## Verdict\nTESTS_PASSED'],
    });
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('add tests');

    expect(res.ok).toBe(true);
    expect(res.log.filter((l) => l.agent === 'tester').length).toBe(2);
    expect(res.log.filter((l) => l.agent === 'coder').length).toBe(2);
    expect(runner.status().testAttempts).toBe(1);
  });

  it('respects maxTestCycles and proceeds with failing tests', async () => {
    const agents = makeAgents({ tester: ['## Verdict\nTESTS_FAILED'] });
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true, maxTestCycles: 1 }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('x');
    expect(res.ok).toBe(true);
    // 1 initial + 1 retry = 2 coder turns, 2 tester turns.
    expect(res.log.filter((l) => l.agent === 'coder').length).toBe(2);
    expect(res.log.filter((l) => l.agent === 'tester').length).toBe(2);
  });

  it('refuses to auto-commit on a dirty tree and runs no agents', async () => {
    const agents = makeAgents();
    const { git } = makeFakeGit({ clean: false });
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('dirty-tree');
    expect(res.log).toHaveLength(0);
  });

  it('refuses to run outside a git repo', async () => {
    const agents = makeAgents();
    const { git } = makeFakeGit({ isRepo: false });
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('not-a-git-repo');
  });

  it('pauses at intake and folds human refinements back into a product/architect re-plan', async () => {
    // product returns CRITERIA-v1 then CRITERIA-v2; architect returns DESIGN-v1 then DESIGN-v2.
    const agents = makeAgents({
      product: ['CRITERIA-v1', 'CRITERIA-v2'],
      architect: ['DESIGN-v1', 'DESIGN-v2'],
    });
    const { git } = makeFakeGit();
    let suspendCalls = 0;
    const hooks: HarnessHooks = {
      onSuspend: async () => {
        suspendCalls++;
        return suspendCalls === 1 ? 'please also add logging' : 'ok';
      },
    };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: true }),
      git,
      hooks,
    });
    const res = await runner.run('add hello command');
    // Initial plan (product+architect), then a re-plan after the human refines,
    // then the orchestrator summary at finalize.
    const productTurns = res.log.filter((l) => l.agent === 'product');
    const archTurns = res.log.filter((l) => l.agent === 'architect');
    expect(productTurns).toHaveLength(2);
    expect(archTurns).toHaveLength(2);
    expect(productTurns[0].text).toBe('CRITERIA-v1');
    expect(productTurns[1].text).toBe('CRITERIA-v2');
    expect(archTurns[0].text).toBe('DESIGN-v1');
    expect(archTurns[1].text).toBe('DESIGN-v2');
    expect(res.log.filter((l) => l.agent === 'orchestrator')).toHaveLength(1); // finalize only
    expect(res.ok).toBe(true);
    // Human approves at finalize → commits.
    expect(res.endReason).toBe('completed');
    expect(res.branch).toMatch(/^harness-/);
    expect(suspendCalls).toBe(2);
  });

  it('does not ask the human to review a plan when product/architect produced none', async () => {
    const agents = makeAgents({ product: [''], architect: [''] });
    const { git } = makeFakeGit();
    const asks: string[] = [];
    const hooks: HarnessHooks = {
      onSuspend: async (_reason, prompt) => {
        asks.push(prompt);
        return 'ok';
      },
    };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: true }),
      git,
      hooks,
    });
    const res = await runner.run('add a thing');
    expect(res.ok).toBe(true);
    expect(asks.length).toBeGreaterThan(0);
    expect(asks[0]).not.toContain('Review the plan above');
    expect(asks[0]).toContain('no plan');
  });

  it('asks the human to review the plan when product/architect produced one', async () => {
    const agents = makeAgents(); // product 'CRITERIA', architect 'DESIGN'
    const { git } = makeFakeGit();
    const asks: string[] = [];
    const hooks: HarnessHooks = {
      onSuspend: async (_reason, prompt) => {
        asks.push(prompt);
        return 'ok';
      },
    };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: true }),
      git,
      hooks,
    });
    await runner.run('add a thing');
    expect(asks.length).toBeGreaterThan(0);
    expect(asks[0]).toContain('Review the plan above');
  });

  it('runs product ⇄ architect refinement cycles when maxPlanCycles > 0', async () => {
    // product cycles CRIT-1 -> CRIT-2 -> CRIT-3; architect cycles DES-1 -> DES-2 -> DES-3.
    const agents = makeAgents({
      product: ['CRIT-1', 'CRIT-2', 'CRIT-3'],
      architect: ['DES-1', 'DES-2', 'DES-3'],
    });
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: true, humanInLoopIntake: false, maxPlanCycles: 2 }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('add a thing');
    // Initial plan (1 product + 1 architect) + 2 refinement rounds (2 each) = 3 each.
    const productTurns = res.log.filter((l) => l.agent === 'product');
    const archTurns = res.log.filter((l) => l.agent === 'architect');
    expect(productTurns).toHaveLength(3);
    expect(archTurns).toHaveLength(3);
    expect(productTurns.map((l) => l.text)).toEqual(['CRIT-1', 'CRIT-2', 'CRIT-3']);
    expect(archTurns.map((l) => l.text)).toEqual(['DES-1', 'DES-2', 'DES-3']);
  });

  it('commits only after human approval when autoCommit is false', async () => {
    const agents = makeAgents();
    const { git, cmds } = makeFakeGit();
    const hooks: HarnessHooks = { onSuspend: async () => 'yes' };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: false, humanInLoopFinalize: true }),
      git,
      hooks,
    });
    const res = await runner.run('ship it');
    expect(res.ok).toBe(true);
    expect(res.branch).toMatch(/^harness-/);
    expect(cmds.some((c) => c.startsWith('git commit -m'))).toBe(true);
  });

  it('skips the commit when the human declines', async () => {
    const agents = makeAgents();
    const { git, cmds } = makeFakeGit();
    const hooks: HarnessHooks = { onSuspend: async () => 'no thanks' };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: false }),
      git,
      hooks,
    });
    const res = await runner.run('ship it');
    expect(res.ok).toBe(true);
    expect(res.endReason).toBe('completed-no-commit');
    expect(res.branch).toBeUndefined();
    expect(cmds.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('ends with reason "aborted" when the run is aborted by the user (Esc)', async () => {
    const agents = makeAgents();
    agents.product = hangUntilAbort('product');
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: false }),
      git,
      hooks: noSuspendHooks,
    });
    const controller = new AbortController();
    controller.abort('user'); // abort before the turn starts
    const res = await runner.run('feature', controller.signal);
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('aborted');
    expect(res.log).toHaveLength(0); // no agent turn completed
  });

  it('ends with reason "timeout" when an agent turn stalls past the timeout', async () => {
    const agents = makeAgents();
    agents.product = hangUntilAbort('product');
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({ autoCommit: false, humanInLoopIntake: false, agentTurnTimeoutMs: 50 }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('timeout');
  });

  it('recovers from a work-loop turn timeout instead of killing the whole run', async () => {
    // Tester stalls on its one (maxTestCycles=0) turn. Because tester turns are
    // recoverable, the run should NOT end with 'timeout' — it recovers an empty
    // report, treats it as a failed attempt, and proceeds to finalize.
    const agents = makeAgents();
    agents.tester = hangUntilAbort('tester');
    const { git } = makeFakeGit();
    const infos: string[] = [];
    const hooks: HarnessHooks = { onSuspend: async () => 'no', onInfo: (t) => void infos.push(t) };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({
        autoCommit: false,
        humanInLoopIntake: false,
        agentTurnTimeoutMs: 50,
        maxTestCycles: 0,
        maxReviewCycles: 0,
      }),
      git,
      hooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(true);
    expect(res.endReason).toBe('completed-no-commit');
    expect(infos.some((t) => /tester turn stopped/.test(t))).toBe(true);
  });

  it('stops a streaming turn that exceeds maxTurnOutputBytes and recovers partial text', async () => {
    const agents = makeAgents();
    const bigToken = 'x'.repeat(2000);
    agents.coder = {
      id: 'coder',
      stream: async () => {
        async function* gen(): AsyncGenerator<string> {
          for (let i = 0; i < 1000; i++) {
            yield bigToken;
          }
        }
        return { textStream: gen(), text: Promise.resolve(bigToken.repeat(1000)) };
      },
    };
    const { git } = makeFakeGit();
    const infos: string[] = [];
    const hooks: HarnessHooks = {
      onSuspend: async () => 'no',
      onInfo: (t) => void infos.push(t),
    };
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({
        autoCommit: false,
        humanInLoopIntake: false,
        maxTurnOutputBytes: 5000,
        maxReviewCycles: 0,
        maxTestCycles: 0,
      }),
      git,
      hooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(true);
    expect(res.endReason).toBe('completed-no-commit');
    expect(infos.some((t) => /exceeded max output size/.test(t))).toBe(true);
    const coderEntry = res.log.find((l) => l.agent === 'coder');
    expect(coderEntry).toBeDefined();
    expect(Buffer.byteLength(coderEntry!.text, 'utf8')).toBeLessThanOrEqual(5100);
    expect(coderEntry!.text).toContain('…[truncated');
  });

  it('aborts the run when the wall-clock budget is exhausted', async () => {
    const agents = makeAgents();
    // Each agent turn sleeps long enough to blow the 50ms wall-clock budget.
    const slow: AgentLike = {
      id: 'product',
      stream: async () => {
        async function* gen(): AsyncGenerator<string> {
          await new Promise((r) => setTimeout(r, 80));
          yield 'criteria';
        }
        return { textStream: gen(), text: Promise.resolve('criteria') };
      },
    };
    agents.product = slow;
    const { git } = makeFakeGit();
    const runner = new HarnessRunner({
      agents,
      config: makeConfig({
        autoCommit: false,
        humanInLoopIntake: false,
        maxWallClockMs: 50,
      }),
      git,
      hooks: noSuspendHooks,
    });
    const res = await runner.run('feature');
    expect(res.ok).toBe(false);
    expect(res.endReason).toBe('timeout');
  });
});