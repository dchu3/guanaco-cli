import { describe, it, expect } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createSdlcAgents } from '../../src/mastra/agents.js';
import { buildSdlcTools } from '../../src/mastra/tools.js';
import { HarnessRunner } from '../../src/harness/runner.js';
import { GitOps } from '../../src/harness/git.js';
import type { HarnessConfig, SdlcRole } from '../../src/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessHooks } from '../../src/harness/types.js';

function makeConfig(repoRoot: string, over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    provider: 'local',
    roleModels: {},
    maxReviewCycles: 0,
    maxTestCycles: 0,
    maxAgentSteps: 2,
    humanInLoopFinalize: false,
    humanInLoopIntake: false,
    toolTimeoutMs: 5000,
    repoRoot,
    autoCommit: false,
    ...over,
  };
}

/** A mock model that returns the given text and never calls tools. */
function mockModel(text: string) {
  return createMockModel({ mockText: text, version: 'v2' }) as never;
}

describe('createSdlcAgents (real Mastra Agent + mock model)', () => {
  it('streams the configured mock text for a single agent turn', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'sdlc-real-'));
    try {
      const toolSet = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });
      const agents = createSdlcAgents({
        getModel: () => mockModel('hello from coder'),
        toolSet,
      });
      const out = await agents.coder.stream('implement something');
      let full = '';
      for await (const delta of out.textStream) full += delta;
      expect((await out.text).trim()).toBe('hello from coder');
      expect(full.trim()).toBe('hello from coder');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('runs through the full harness with scripted mock models per role', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'sdlc-run-'));
    try {
      // Minimal fake git so the runner can "commit" without a real repo.
      const execImpl = async (cmd: string) => {
        const c = cmd.trim();
        if (c === 'git rev-parse --is-inside-work-tree') return { stdout: 'true', stderr: '' };
        if (c === 'git status --porcelain') return { stdout: '', stderr: '' };
        if (c.startsWith('git checkout -b')) return { stdout: '', stderr: '' };
        if (c === 'git add -A') return { stdout: '', stderr: '' };
        if (c.startsWith('git commit -m')) return { stdout: '', stderr: '' };
        if (c === 'git rev-parse HEAD') return { stdout: 'cafef00ddeadbeef', stderr: '' };
        throw new Error(`unexpected: ${c}`);
      };
      const git = new GitOps({ repoRoot: repo, execImpl });

      const scripts: Record<SdlcRole, string> = {
        orchestrator: '## Summary\nplanned it',
        product: '## Acceptance Criteria\n- it works',
        architect: '## Change Set\n- src/x.ts: modify',
        coder: '## Changes\nedited src/x.ts\n## Build\nbuild green',
        reviewer: '## Verdict\nAPPROVE',
        tester: '## Verdict\nTESTS_PASSED',
      };
      const toolSet = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });
      const agents = createSdlcAgents({
        getModel: (role) => mockModel(scripts[role]),
        toolSet,
      });

      const hooks: HarnessHooks = {};
      const runner = new HarnessRunner({
        agents,
        config: makeConfig(repo, { autoCommit: true }),
        git,
        hooks,
      });
      const res = await runner.run('add feature x');

      expect(res.ok).toBe(true);
      expect(res.endReason).toBe('completed');
      expect(res.commit).toBe('cafef00ddeadbeef');
      expect(res.log.map((l) => l.agent)).toEqual([
        'orchestrator',
        'product',
        'architect',
        'coder',
        'reviewer',
        'tester',
        'orchestrator',
      ]);
      // The reviewer/tester verdicts were parsed from the mock text.
      expect(runner.status().lastReviewerVerdict).toBe('APPROVE');
      expect(runner.status().lastTesterVerdict).toBe('TESTS_PASSED');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});