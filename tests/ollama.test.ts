import { describe, it, expect, vi } from 'vitest';
import { OllamaClient, OllamaAbortError } from '../src/ollama.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('OllamaClient', () => {
  it('posts to /api/chat with model + messages and returns content', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:11434/api/chat');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      return jsonResponse({ message: { role: 'assistant', content: 'hello back' } });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434/',
      model: 'test-model',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    const out = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hello back');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on non-OK HTTP responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/Ollama HTTP 500/);
  });

  it('throws on empty content', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { role: 'assistant', content: '' } }),
    ) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/empty response/);
  });

  it('surfaces ollama-reported error field', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'model not found' }),
    ) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/model not found/);
  });

  it('times out and reports clearly', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 25,
      fetchImpl: fetchMock,
    });

    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/timed out after 25ms/);
  });

  it('executes a tool call and feeds the result back to the model', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) {
        // first call: model asks for a tool
        expect(body.tools).toBeDefined();
        return jsonResponse({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'echo', arguments: { msg: 'hi' } },
              },
            ],
          },
        });
      }
      // second call: model produces final answer
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages.some((m) => m.role === 'tool' && m.content.includes('echoed:hi'))).toBe(true);
      return jsonResponse({
        message: { role: 'assistant', content: 'final answer' },
      });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = {
      definitions: [
        {
          type: 'function' as const,
          function: {
            name: 'echo',
            description: 'echo',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
        dispatched.push({ name, args });
        return `echoed:${args.msg}`;
      },
    };

    const out = await client.chat([{ role: 'user', content: 'go' }], { tools });
    expect(out).toBe('final answer');
    expect(dispatched).toEqual([{ name: 'echo', args: { msg: 'hi' } }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses tool_calls supplied as JSON-encoded string arguments', async () => {
    let step = 0;
    const fetchMock = vi.fn(async () => {
      step++;
      if (step === 1) {
        return jsonResponse({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                function: { name: 'noop', arguments: '{"x": 1}' },
              },
            ],
          },
        });
      }
      return jsonResponse({ message: { role: 'assistant', content: 'done' } });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    let receivedArgs: Record<string, unknown> = {};
    const tools = {
      definitions: [
        {
          type: 'function' as const,
          function: { name: 'noop', description: 'n', parameters: { type: 'object' } },
        },
      ],
      async dispatch(_name: string, args: Record<string, unknown>): Promise<string> {
        receivedArgs = args;
        return 'ok';
      },
    };

    await client.chat([{ role: 'user', content: 'go' }], { tools });
    expect(receivedArgs).toEqual({ x: 1 });
  });

  it('drops tools on the final step and returns the model\'s text answer (graceful degrade)', async () => {
    let step = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      step++;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (step === 1) {
        // First step: tools must be present, model asks for one.
        expect(body.tools).toBeDefined();
        return jsonResponse({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c', function: { name: 'noop', arguments: {} } }],
          },
        });
      }
      // Second (final) step: tools should be omitted, forcing a text answer.
      expect(body.tools).toBeUndefined();
      return jsonResponse({ message: { role: 'assistant', content: 'graceful answer' } });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    const tools = {
      definitions: [
        {
          type: 'function' as const,
          function: { name: 'noop', description: 'n', parameters: { type: 'object' } },
        },
      ],
      async dispatch(): Promise<string> {
        return 'tool-result';
      },
    };

    const out = await client.chat([{ role: 'user', content: 'go' }], { tools, maxToolSteps: 1 });
    expect(out).toBe('graceful answer');
  });

  it('does not misidentify a plain JSON object reply as a tool call', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        message: {
          role: 'assistant',
          content: '{"name":"Alice","email":"a@example.com"}',
        },
      }),
    ) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    const dispatched: string[] = [];
    const tools = {
      definitions: [
        {
          type: 'function' as const,
          function: { name: 'mock_tool', description: 's', parameters: { type: 'object' } },
        },
      ],
      async dispatch(name: string): Promise<string> {
        dispatched.push(name);
        return 'never';
      },
    };

    const out = await client.chat([{ role: 'user', content: 'who?' }], { tools });
    expect(out).toBe('{"name":"Alice","email":"a@example.com"}');
    expect(dispatched).toEqual([]);
  });

  it('detects inline tool calls wrapped as { tool_calls: [...] }', async () => {
    let step = 0;
    const fetchMock = vi.fn(async () => {
      step++;
      if (step === 1) {
        return jsonResponse({
          message: {
            role: 'assistant',
            content:
              '{"tool_calls":[{"function":{"name":"echo","arguments":{"msg":"x"}}}]}',
          },
        });
      }
      return jsonResponse({ message: { role: 'assistant', content: 'final' } });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = {
      definitions: [
        {
          type: 'function' as const,
          function: { name: 'echo', description: 'e', parameters: { type: 'object' } },
        },
      ],
      async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
        dispatched.push({ name, args });
        return 'ok';
      },
    };

    const out = await client.chat([{ role: 'user', content: 'go' }], { tools });
    expect(out).toBe('final');
    expect(dispatched).toEqual([{ name: 'echo', args: { msg: 'x' } }]);
  });

  it('omits tools field from the request when no registry is supplied', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
      return jsonResponse({ message: { role: 'assistant', content: 'plain' } });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: fetchMock,
    });

    expect(await client.chat([{ role: 'user', content: 'hi' }])).toBe('plain');
  });

  describe('streaming', () => {
    function streamResponse(chunks: string[]): Response {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }

    it('sends stream:true and emits deltas in order, returning aggregated content', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body.stream).toBe(true);
        return streamResponse([
          '{"message":{"role":"assistant","content":"Hel"},"done":false}\n',
          '{"message":{"role":"assistant","content":"lo, "},"done":false}\n',
          '{"message":{"role":"assistant","content":"world"},"done":false}\n',
          '{"message":{"role":"assistant","content":"!"},"done":true}\n',
        ]);
      }) as unknown as typeof fetch;

      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });

      const deltas: Array<[string, string]> = [];
      const turnEnds: Array<[string, boolean]> = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onAssistantDelta: (chunk, full) => {
          deltas.push([chunk, full]);
        },
        onAssistantTurnEnd: (full, hasToolCalls) => {
          turnEnds.push([full, hasToolCalls]);
        },
      });
      expect(out).toBe('Hello, world!');
      expect(deltas.map((d) => d[0])).toEqual(['Hel', 'lo, ', 'world', '!']);
      expect(deltas[deltas.length - 1][1]).toBe('Hello, world!');
      expect(turnEnds).toEqual([['Hello, world!', false]]);
    });

    it('buffers chunks split mid-line', async () => {
      const fetchMock = vi.fn(async () =>
        streamResponse([
          '{"message":{"role":"assistant","content":"foo"},',
          '"done":false}\n{"message":{"role":"assistant","content":"bar"},"done":true}\n',
        ]),
      ) as unknown as typeof fetch;

      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });

      const deltas: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'x' }], {
        onAssistantDelta: (chunk) => {
          deltas.push(chunk);
        },
      });
      expect(out).toBe('foobar');
      expect(deltas).toEqual(['foo', 'bar']);
    });

    it('streams tool-call turn (no deltas), runs tool, then streams final answer', async () => {
      let step = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        step++;
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body.stream).toBe(true);
        if (step === 1) {
          return streamResponse([
            '{"message":{"role":"assistant","content":"","tool_calls":[' +
              '{"id":"c1","function":{"name":"echo","arguments":{"msg":"hi"}}}]},"done":true}\n',
          ]);
        }
        return streamResponse([
          '{"message":{"role":"assistant","content":"final "},"done":false}\n',
          '{"message":{"role":"assistant","content":"answer"},"done":true}\n',
        ]);
      }) as unknown as typeof fetch;

      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });

      const tools = {
        definitions: [
          {
            type: 'function' as const,
            function: { name: 'echo', description: 'e', parameters: { type: 'object' } },
          },
        ],
        async dispatch(_n: string, args: Record<string, unknown>): Promise<string> {
          return `echoed:${args.msg}`;
        },
      };

      const deltas: string[] = [];
      const turnEnds: Array<[string, boolean]> = [];
      const out = await client.chat([{ role: 'user', content: 'go' }], {
        tools,
        onAssistantDelta: (chunk) => {
          deltas.push(chunk);
        },
        onAssistantTurnEnd: (full, hasToolCalls) => {
          turnEnds.push([full, hasToolCalls]);
        },
      });
      expect(out).toBe('final answer');
      expect(deltas).toEqual(['final ', 'answer']);
      expect(turnEnds).toEqual([
        ['', true],
        ['final answer', false],
      ]);
    });

    it('rejects with OllamaAbortError when the abort signal fires mid-stream', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode('{"message":{"role":"assistant","content":"par"},"done":false}\n'),
            );
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }) as unknown as typeof fetch;

      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });

      const controller = new AbortController();
      const deltas: string[] = [];
      const promise = client.chat([{ role: 'user', content: 'x' }], {
        abortSignal: controller.signal,
        onAssistantDelta: (chunk) => {
          deltas.push(chunk);
        },
      });
      // Let the first delta land, then abort.
      await new Promise((r) => setTimeout(r, 20));
      controller.abort('user');
      await expect(promise).rejects.toBeInstanceOf(OllamaAbortError);
      expect(deltas).toEqual(['par']); // partial content was delivered before the abort
    });

    it('throws on non-OK streaming response', async () => {
      const fetchMock = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });
      await expect(
        client.chat([{ role: 'user', content: 'x' }], { onAssistantDelta: () => {} }),
      ).rejects.toThrow(/Ollama HTTP 500/);
    });

    it('throws on empty streamed response with no tool calls', async () => {
      const fetchMock = vi.fn(async () =>
        streamResponse(['{"message":{"role":"assistant","content":""},"done":true}\n']),
      ) as unknown as typeof fetch;
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });
      await expect(
        client.chat([{ role: 'user', content: 'x' }], { onAssistantDelta: () => {} }),
      ).rejects.toThrow(/empty response/);
    });

    it('propagates Ollama error reported in an unterminated trailing chunk', async () => {
      // Last NDJSON object has no trailing newline — exercises the tail
      // buffer path. The error must surface, not be swallowed.
      const fetchMock = vi.fn(async () =>
        streamResponse([
          '{"message":{"role":"assistant","content":"hi "},"done":false}\n',
          '{"error":"boom in tail"}',
        ]),
      ) as unknown as typeof fetch;
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: fetchMock,
      });
      await expect(
        client.chat([{ role: 'user', content: 'x' }], { onAssistantDelta: () => {} }),
      ).rejects.toThrow(/boom in tail/);
    });
  });
});
