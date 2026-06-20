import { debug } from './util/log.js';
import type { ToolDefinition, ToolRegistry } from './tools.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  modelOptions?: Record<string, unknown>;
  // Prepended as a `system` message to every chat turn when set.
  systemPrompt?: string;
  // Top-level Ollama `think` flag (qwen3 reasoning). undefined = omit (model default).
  think?: boolean;
}

export interface ChatOptions {
  tools?: ToolRegistry;
  maxToolSteps?: number;
  onToolStart?: (name: string, args: Record<string, unknown>) => void | Promise<void>;
  onToolEnd?: (name: string, result: string, error?: Error) => void | Promise<void>;
  // When provided, the assistant turn is streamed and this callback is fired
  // for every non-empty content chunk. `full` is the accumulated content for
  // the current turn so consumers can render incrementally without tracking
  // their own buffer. Streaming is applied to every turn — for tool-call
  // turns the content is typically empty and no deltas fire.
  onAssistantDelta?: (chunk: string, full: string) => void | Promise<void>;
  // Fired once a turn completes, after any deltas for that turn. Lets the
  // consumer flush a final edit and decide whether the next turn should
  // start a new message (e.g. when tool_calls follow).
  onAssistantTurnEnd?: (full: string, hasToolCalls: boolean) => void | Promise<void>;
  // When provided, aborts the in-flight request when the signal fires (e.g.
  // the user pressing Esc). The client rejects with `OllamaAbortError`.
  abortSignal?: AbortSignal;
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  error?: string;
}

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  error?: string;
}

const DEFAULT_MAX_TOOL_STEPS = 3;

/** Thrown when a chat request is aborted via `ChatOptions.abortSignal` (e.g.
 *  the user pressed Esc). Distinct from a timeout/network error so callers can
 *  surface a friendly "stopped" message instead of an error. */
export class OllamaAbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'OllamaAbortError';
  }
}

export class OllamaClient {
  private readonly baseUrlValue: string;
  private model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly modelOptions?: Record<string, unknown>;
  private readonly systemPrompt?: string;
  private readonly think?: boolean;

  constructor(opts: OllamaClientOptions) {
    this.baseUrlValue = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.modelOptions = opts.modelOptions;
    this.systemPrompt = opts.systemPrompt;
    this.think = opts.think;
  }

  get currentModel(): string {
    return this.model;
  }

  /** Public read-only access to the configured base URL (for display). */
  get baseUrl(): string {
    return this.baseUrlValue;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const tools = options.tools;
    const maxSteps = Math.max(0, options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS);
    // Work on a local copy so we don't append tool_calls / tool messages to
    // the caller's history unless they choose to integrate them.
    const working: Message[] = this.systemPrompt
      ? [{ role: 'system', content: this.systemPrompt }, ...messages]
      : [...messages];

    for (let step = 0; step <= maxSteps; step++) {
      // On the final permitted step, suppress tool definitions so a
      // tool-preferring model degrades gracefully to a text answer instead
      // of looping forever and producing a hard error.
      const onFinalStep = step === maxSteps;
      const definitionsForStep = onFinalStep ? undefined : tools?.definitions;
      const reply = options.onAssistantDelta
        ? await this.chatOnceStreaming(working, definitionsForStep, options)
        : await this.chatOnce(working, definitionsForStep, options.abortSignal);
      const toolCalls =
        !onFinalStep && tools
          ? (reply.tool_calls ?? extractInlineToolCalls(reply.content))
          : undefined;

      if (options.onAssistantTurnEnd) {
        try {
          await options.onAssistantTurnEnd(
            reply.content ?? '',
            !!(toolCalls && toolCalls.length > 0),
          );
        } catch (hookErr) {
          debug('ollama-stream', 'onAssistantTurnEnd hook failed:', hookErr);
        }
      }

      if (!toolCalls || toolCalls.length === 0 || !tools) {
        if (typeof reply.content === 'string' && reply.content.length > 0) {
          return reply.content;
        }
        throw new Error('Ollama returned empty response');
      }

      working.push({
        role: 'assistant',
        content: reply.content ?? '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const name = call.function?.name ?? '';
        const args = parseToolArgs(call.function?.arguments);
        debug('ollama-tool', `dispatching ${name}`, args);
        if (options.onToolStart) {
          try {
            await options.onToolStart(name, args);
          } catch (hookErr) {
            debug('ollama-tool', 'onToolStart hook failed:', hookErr);
          }
        }
        let result: string;
        let dispatchErr: Error | undefined;
        try {
          result = await tools.dispatch(name, args);
        } catch (err) {
          dispatchErr = err instanceof Error ? err : new Error(String(err));
          result = JSON.stringify({ error: dispatchErr.message });
        }
        debug('ollama-tool', `${name} -> ${Buffer.byteLength(result, 'utf8')} bytes`);
        if (options.onToolEnd) {
          try {
            await options.onToolEnd(name, result, dispatchErr);
          } catch (hookErr) {
            debug('ollama-tool', 'onToolEnd hook failed:', hookErr);
          }
        }
        working.push({
          role: 'tool',
          content: result,
          tool_call_id: call.id,
          name,
        });
      }
    }

    throw new Error('Tool-call loop terminated unexpectedly');
  }

  private async chatOnce(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    abortSignal?: AbortSignal,
  ): Promise<{ content: string; tool_calls?: ToolCall[] }> {
    const url = `${this.baseUrlValue}/api/chat`;
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) payload.tools = tools;
    if (this.modelOptions) payload.options = this.modelOptions;
    if (this.think !== undefined) payload.think = this.think;
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as OllamaChatResponse;
      if (json.error) {
        throw new Error(`Ollama error: ${json.error}`);
      }
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const toolCalls = json.message?.tool_calls;
      if (
        (!toolCalls || toolCalls.length === 0) &&
        content.length === 0
      ) {
        throw new Error('Ollama returned empty response');
      }
      return { content, tool_calls: toolCalls };
    } catch (err) {
      if (abortSignal?.aborted) throw new OllamaAbortError('aborted');
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
      }
      debug('ollama', err);
      throw err;
    } finally {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    }
  }

  // NDJSON streaming variant of chatOnce. Fires `options.onAssistantDelta`
  // for each content chunk and aggregates the final message + any tool_calls.
  // Uses an idle-timeout (resets on each chunk) rather than an absolute
  // deadline so long-but-active streams don't get aborted mid-response.
  private async chatOnceStreaming(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    options: ChatOptions,
  ): Promise<{ content: string; tool_calls?: ToolCall[] }> {
    const url = `${this.baseUrlValue}/api/chat`;
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) payload.tools = tools;
    if (this.modelOptions) payload.options = this.modelOptions;
    if (this.think !== undefined) payload.think = this.think;
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    resetIdleTimer();
    // Link the caller-supplied abort signal (e.g. Esc) to the fetch controller.
    const abortSignal = options.abortSignal;
    const onAbort = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (!res.body) {
        throw new Error('Ollama streaming response had no body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let content = '';
      let toolCalls: ToolCall[] | undefined;

      // Read until the stream ends. NDJSON: one JSON object per line.
      // Chunks can split mid-line, so we accumulate in `buf` and only
      // parse complete lines.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush any incomplete multi-byte UTF-8 sequence still held in
          // the decoder's internal buffer.
          buf += decoder.decode();
          break;
        }
        resetIdleTimer();
        buf += decoder.decode(value, { stream: true });

        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf('\n', start)) !== -1) {
          const line = buf.slice(start, nl).trim();
          start = nl + 1;
          if (!line) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line) as OllamaStreamChunk;
          } catch (parseErr) {
            debug('ollama-stream', 'failed to parse NDJSON line', parseErr, line.slice(0, 200));
            continue;
          }
          if (chunk.error) {
            throw new Error(`Ollama error: ${chunk.error}`);
          }
          const piece = chunk.message?.content;
          if (typeof piece === 'string' && piece.length > 0) {
            content += piece;
            if (options.onAssistantDelta) {
              try {
                await options.onAssistantDelta(piece, content);
              } catch (hookErr) {
                debug('ollama-stream', 'onAssistantDelta hook failed:', hookErr);
              }
            }
          }
          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            toolCalls = (toolCalls ?? []).concat(chunk.message.tool_calls);
          }
        }
        buf = buf.slice(start);
      }
      // Flush trailing buffered content (some servers may omit a final
      // newline). Only swallow JSON parse failures; let real errors
      // (Ollama-reported errors, hook failures) propagate.
      const tail = buf.trim();
      if (tail) {
        let chunk: OllamaStreamChunk | undefined;
        try {
          chunk = JSON.parse(tail) as OllamaStreamChunk;
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) throw parseErr;
          // ignore non-JSON trailing bytes
        }
        if (chunk) {
          if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
          const piece = chunk.message?.content;
          if (typeof piece === 'string' && piece.length > 0) {
            content += piece;
            if (options.onAssistantDelta) {
              try {
                await options.onAssistantDelta(piece, content);
              } catch (hookErr) {
                debug('ollama-stream', 'onAssistantDelta hook failed:', hookErr);
              }
            }
          }
          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            toolCalls = (toolCalls ?? []).concat(chunk.message.tool_calls);
          }
        }
      }

      if ((!toolCalls || toolCalls.length === 0) && content.length === 0) {
        throw new Error('Ollama returned empty response');
      }
      return { content, tool_calls: toolCalls };
    } catch (err) {
      if (abortSignal?.aborted) throw new OllamaAbortError('aborted');
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
      }
      debug('ollama-stream', err);
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Defensive fallback: some models emit tool calls as a JSON object inside
// `content` rather than via `message.tool_calls`. Detect a few common shapes
// without false-matching arbitrary JSON objects that happen to have a `name`
// key (e.g. a JSON answer like `{"name":"Alice"}`).
function extractInlineToolCalls(content: string | undefined): ToolCall[] | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  // Unwrap { tool_calls: [...] } wrapper before treating items as candidates.
  let candidatesRaw: unknown[];
  if (Array.isArray(parsed)) {
    candidatesRaw = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { tool_calls?: unknown }).tool_calls)
  ) {
    candidatesRaw = (parsed as { tool_calls: unknown[] }).tool_calls;
  } else {
    candidatesRaw = [parsed];
  }

  const calls: ToolCall[] = [];
  for (const c of candidatesRaw) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    // shape: { function: { name, arguments }, id? } — strongest signal
    const fn = obj.function as { name?: string; arguments?: unknown } | undefined;
    if (fn && typeof fn.name === 'string') {
      calls.push({
        id: typeof obj.id === 'string' ? obj.id : undefined,
        function: {
          name: fn.name,
          arguments: (fn.arguments as Record<string, unknown> | string | undefined) ?? {},
        },
      });
      continue;
    }
    // shape: { name, arguments } — only accept when `arguments` is also
    // present so we don't misidentify arbitrary objects as tool calls.
    if (typeof obj.name === 'string' && Object.prototype.hasOwnProperty.call(obj, 'arguments')) {
      calls.push({
        function: {
          name: obj.name,
          arguments: (obj.arguments as Record<string, unknown> | string | undefined) ?? {},
        },
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}
