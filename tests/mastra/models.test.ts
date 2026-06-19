import { describe, it, expect } from 'vitest';
import { getOllamaModel, DEFAULT_ROLE_MODELS } from '../../src/mastra/models.js';
import type { HarnessConfig } from '../../src/config.js';

function makeConfig(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    provider: 'local',
    roleModels: {},
    maxReviewCycles: 2,
    maxTestCycles: 2,
    maxAgentSteps: 4,
    maxTurnOutputBytes: 1_000_000,
    maxWallClockMs: 0,
    humanInLoopFinalize: true,
    humanInLoopIntake: true,
    toolTimeoutMs: 5000,
    repoRoot: '/tmp/repo',
    autoCommit: false,
    ...over,
  };
}

describe('getOllamaModel', () => {
  it('uses role overrides when provided, else DEFAULT_ROLE_MODELS', async () => {
    const cfg = makeConfig({
      roleModels: { coder: 'qwen2.5-coder:14b', reviewer: 'llama3.2' },
    });
    // Local mode returns a LanguageModelV1 object with a modelId property.
    const coder = getOllamaModel('coder', cfg, 'http://localhost:11434') as { modelId: string };
    const reviewer = getOllamaModel('reviewer', cfg, 'http://localhost:11434') as { modelId: string };
    const tester = getOllamaModel('tester', cfg, 'http://localhost:11434') as { modelId: string };
    expect(coder.modelId).toBe('qwen2.5-coder:14b');
    expect(reviewer.modelId).toBe('llama3.2');
    expect(tester.modelId).toBe(DEFAULT_ROLE_MODELS.tester);
  });

  it('returns a cloud model-router id string for cloud provider', () => {
    const cfg = makeConfig({
      provider: 'cloud',
      ollamaApiKey: 'key',
      roleModels: { orchestrator: 'cogito-2.1:671b' },
    });
    const model = getOllamaModel('orchestrator', cfg, 'http://x') as { id: string; apiKey?: string };
    expect(model.id).toBe('ollama-cloud/cogito-2.1:671b');
    expect(model.apiKey).toBe('key');
  });

  it('keeps an explicit ollama-cloud/ prefix if the user already provided it', () => {
    const cfg = makeConfig({
      provider: 'cloud',
      ollamaApiKey: 'key',
      roleModels: { coder: 'ollama-cloud/qwen3-coder-next' },
    });
    const model = getOllamaModel('coder', cfg, 'http://x') as { id: string };
    expect(model.id).toBe('ollama-cloud/qwen3-coder-next');
  });

  it('uses the /api path for local ollama-ai-provider', () => {
    const cfg = makeConfig();
    const model = getOllamaModel('coder', cfg, 'http://localhost:11434') as {
      modelId: string;
      baseURL?: string;
    };
    expect(model.modelId).toBe(DEFAULT_ROLE_MODELS.coder);
    // The provider appends /api internally; we just assert it doesn't double up.
    expect(model.baseURL).toBeUndefined();
  });
});

describe('DEFAULT_ROLE_MODELS', () => {
  it('covers every SDLC role', () => {
    const roles = ['orchestrator', 'product', 'architect', 'coder', 'reviewer', 'tester'];
    for (const r of roles) {
      expect(DEFAULT_ROLE_MODELS[r as keyof typeof DEFAULT_ROLE_MODELS]).toBeTruthy();
    }
  });
});