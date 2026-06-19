import { describe, it, expect, vi } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createSdlcAgents, isV4Model, routeAgentStream, type AgentStreamMethods } from '../../src/mastra/agents.js';
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
    maxPlanCycles: 0,
    maxAgentSteps: 2,
    maxTurnOutputBytes: 1_000_000,
    maxWallClockMs: 0,
    humanInLoopFinalize: false,
    humanInLoopIntake: false,
    toolTimeoutMs: 5000,
    repoRoot,
    autoCommit: false,
    ...over,
  };
}

/** A mock model that returns the given text and never calls tools. */
function mockModel(text: string, version: 'v1' | 'v2' = 'v2') {
  return createMockModel({ mockText: text, version }) as never;
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

  it('falls back to streamLegacy() for an AI SDK v4 model (the ollama case)', async () => {
    // A v1 mock model is AI SDK v4: Mastra's Agent#stream() rejects it with
    // "AI SDK v4 model … not compatible with stream()". The wrapper should
    // catch that and route through streamLegacy() so /feature works for both
    // the local ollama-ai-provider and the ollama-cloud router.
    const repo = await mkdtemp(join(tmpdir(), 'sdlc-v4-'));
    try {
      const toolSet = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });
      const agents = createSdlcAgents({
        getModel: () => mockModel('v4 orchestrator plan', 'v1'),
        toolSet,
      });
      const out = await agents.orchestrator.stream('plan a feature');
      let full = '';
      for await (const delta of out.textStream) full += delta;
      expect((await out.text).trim()).toBe('v4 orchestrator plan');
      expect(full.trim()).toBe('v4 orchestrator plan');
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

describe('isV4Model', () => {
  it('returns true for specificationVersion "v1" (AI SDK v4)', () => {
    expect(isV4Model({ specificationVersion: 'v1' })).toBe(true);
  });

  it('returns false for specificationVersion "v2" (AI SDK v5)', () => {
    expect(isV4Model({ specificationVersion: 'v2' })).toBe(false);
  });

  it('returns false for the cloud model-router config (no specificationVersion)', () => {
    expect(isV4Model({ id: 'ollama-cloud/foo', apiKey: 'k' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isV4Model(null)).toBe(false);
    expect(isV4Model(undefined)).toBe(false);
  });
});

describe('routeAgentStream', () => {
  const fakeStream = { textStream: (async function* () {})(), text: Promise.resolve('') };

  function fakeAgent(): AgentStreamMethods & { stream: ReturnType<typeof vi.fn>; streamLegacy: ReturnType<typeof vi.fn> } {
    return {
      stream: vi.fn().mockResolvedValue(fakeStream),
      streamLegacy: vi.fn().mockResolvedValue(fakeStream),
    };
  }

  it('routes to streamLegacy for a v4 (specificationVersion v1) model', async () => {
    const agent = fakeAgent();
    const stream = routeAgentStream(agent, { specificationVersion: 'v1' });
    await stream('hi', { maxSteps: 2, toolChoice: 'auto' });
    expect(agent.streamLegacy).toHaveBeenCalledWith('hi', { maxSteps: 2, toolChoice: 'auto' });
    expect(agent.stream).not.toHaveBeenCalled();
  });

  it('routes to stream for a v5 (specificationVersion v2) model', async () => {
    const agent = fakeAgent();
    const stream = routeAgentStream(agent, { specificationVersion: 'v2' });
    await stream('hi', { maxSteps: 2 });
    expect(agent.stream).toHaveBeenCalledWith('hi', { maxSteps: 2 });
    expect(agent.streamLegacy).not.toHaveBeenCalled();
  });

  it('routes to stream for the cloud router config (no specificationVersion)', async () => {
    const agent = fakeAgent();
    const stream = routeAgentStream(agent, { id: 'ollama-cloud/foo', apiKey: 'k' });
    await stream('hi');
    expect(agent.stream).toHaveBeenCalledWith('hi', undefined);
    expect(agent.streamLegacy).not.toHaveBeenCalled();
  });
});

describe('createSdlcAgents routing (real Agent + mock model)', () => {
  it('streams via the v4 path for a v1 mock model without throwing', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'sdlc-v4-'));
    try {
      const toolSet = buildSdlcTools({ repoRoot: repo, toolTimeoutMs: 5000 });
      const agents = createSdlcAgents({
        // version: 'v1' -> AI SDK v4 mock, which would throw on stream().
        getModel: () => createMockModel({ mockText: 'v4 ok', version: 'v1' }) as never,
        toolSet,
      });
      const out = await agents.orchestrator.stream('plan something');
      let full = '';
      for await (const delta of out.textStream) full += delta;
      expect((await out.text).trim()).toBe('v4 ok');
      expect(full.trim()).toBe('v4 ok');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});