import { describe, it, expect, vi } from 'vitest';
import { OllamaClient } from '../src/ollama.js';

describe('OllamaClient options (system prompt, think, num_predict)', () => {
  function captureBody(): { fetchMock: typeof fetch; body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchMock, body: () => captured };
  }

  it('prepends the system prompt as a system message when set', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
      systemPrompt: 'You are a concise assistant.',
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    const messages = body().messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a concise assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('does not add a system message when no system prompt is set', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    const messages = body().messages as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('sends top-level think:false when think is disabled', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
      think: false,
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(body().think).toBe(false);
  });

  it('sends top-level think:true when think is enabled', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
      think: true,
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(body().think).toBe(true);
  });

  it('omits the think field when not configured', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(body()).not.toHaveProperty('think');
  });

  it('forwards num_predict inside options when set via modelOptions', async () => {
    const { fetchMock, body } = captureBody();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
      modelOptions: { num_predict: 42 },
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect((body().options as Record<string, unknown>).num_predict).toBe(42);
  });
});

describe('loadConfig (think + num_predict parsing)', () => {
  // loadConfig reads process.env / process.argv at call time, so set them per test.
  function withEnv(env: Record<string, string | undefined>, argv: string[], fn: () => Promise<void> | void): Promise<void> {
    return Promise.resolve().then(async () => {
      const savedEnv: Record<string, string | undefined> = {};
      for (const k of Object.keys(env)) {
        savedEnv[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const savedArgv = process.argv;
      process.argv = ['node', 'guanaco-cli', ...argv];
      try {
        await fn();
      } finally {
        for (const k of Object.keys(env)) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
        process.argv = savedArgv;
      }
    });
  }

  it('defaults think to false and leaves numPredict unset', async () => {
    await withEnv({ OLLAMA_THINK: undefined, OLLAMA_NUM_PREDICT: undefined }, [], async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();
      expect(cfg.think).toBe(false);
      expect(cfg.numPredict).toBeUndefined();
    });
  });

  it('parses OLLAMA_THINK=1', async () => {
    await withEnv({ OLLAMA_THINK: '1' }, [], async () => {
      const { loadConfig } = await import('../src/config.js');
      expect((await loadConfig()).think).toBe(true);
    });
  });

  it('--think flag overrides OLLAMA_THINK=0', async () => {
    await withEnv({ OLLAMA_THINK: '0' }, ['--think'], async () => {
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().think).toBe(true);
    });
  });

  it('--no-think flag overrides OLLAMA_THINK=1', async () => {
    await withEnv({ OLLAMA_THINK: '1' }, ['--no-think'], async () => {
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().think).toBe(false);
    });
  });

  it('parses OLLAMA_NUM_PREDICT', async () => {
    await withEnv({ OLLAMA_NUM_PREDICT: '256' }, [], async () => {
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().numPredict).toBe(256);
    });
  });

  it('parses --num-predict flag', async () => {
    await withEnv({ OLLAMA_NUM_PREDICT: undefined }, ['--num-predict', '128'], async () => {
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().numPredict).toBe(128);
    });
  });
});