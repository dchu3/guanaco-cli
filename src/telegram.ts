import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { OllamaClient } from './ollama.js';
import type { HistoryStore } from './history.js';
import type { ToolRegistry } from './tools.js';
import { debug, maskPii } from './util/log.js';

export interface TelegramBotDeps {
  token: string;
  allowedUserId: number;
  ollama: OllamaClient;
  history: HistoryStore;
  tools?: ToolRegistry;
  maxToolSteps?: number;
  streamEnabled?: boolean;
  onFatal?: (err: unknown) => void;
}

export interface RunningBot {
  stop: (reason?: string) => void;
}

const EDIT_NOT_MODIFIED_RE = /not modified/i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startTelegramBot(deps: TelegramBotDeps): Promise<RunningBot> {
  const bot = new Telegraf(deps.token);

  // Serialize message processing per user so concurrent Telegram updates
  // can't interleave history mutations and corrupt the user/assistant
  // alternation that the LLM relies on.
  const userLocks = new Map<number, Promise<void>>();
  const withUserLock = async (userId: number, fn: () => Promise<void>): Promise<void> => {
    const prev = userLocks.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    userLocks.set(
      userId,
      next.finally(() => {
        if (userLocks.get(userId) === next) userLocks.delete(userId);
      }),
    );
    await next;
  };

  bot.catch((err, ctx) => {
    const msg = err instanceof Error ? err.message : String(err);
    debug('telegram', `handler error in update ${maskPii(ctx.update?.update_id)}: ${msg}`);
    if (ctx.chat) {
      ctx.reply(`⚠️ Internal error: ${msg.slice(0, 200)}`).catch(() => undefined);
    }
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== deps.allowedUserId) {
      debug('telegram', `Unauthorized access from user id: ${maskPii(userId)}`);
      if (ctx.chat?.type === 'private') {
        await ctx.reply('Unauthorized. This bot is private.');
      }
      return;
    }
    return await next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      '🤖 Local LLM bot ready.\n\n' +
        `Model: ${deps.ollama.currentModel}\n\n` +
        'Send any message and I will pass it to the local LLM.\n\n' +
        'Commands:\n' +
        '/start — welcome\n' +
        '/help — show help\n' +
        '/clear — reset chat history\n' +
        '/model — show current model\n' +
        '/execute — execute a shell command (restricted)',
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Send any text to chat with the local LLM.\n\n' +
        'Commands:\n' +
        '/start — welcome\n' +
        '/help — this message\n' +
        '/clear — reset your chat history\n' +
        '/model — show current model\n' +
        '/execute — execute a shell command (restricted)',
    );
  });

  bot.command('clear', async (ctx) => {
    if (ctx.from) deps.history.clear(ctx.from.id);
    await ctx.reply('🧹 Chat history cleared.');
  });

  bot.command('model', async (ctx) => {
    await ctx.reply(`Current model: ${deps.ollama.currentModel}`);
  });

  const execAsync = promisify(exec);

  bot.command('execute', async (ctx) => {
    const command = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!command) {
      return await ctx.reply('Usage: /execute <command>');
    }

    try {
      const { stdout } = await execAsync(`./scripts/secure_execute.sh "${command.replace(/"/g, '\\"')}"`);
      let output = stdout.trim() || '(no output)';
      if (output.length > 3500) {
        output = output.slice(0, 3500) + '\n\n... (output truncated)';
      }
      await ctx.reply(`<pre>${escapeHtml(output)}</pre>`, { parse_mode: 'HTML' });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? ((err as { stdout?: string }).stdout || err.message) : String(err);
      let truncatedError = errorMsg.trim();
      if (truncatedError.length > 3500) {
        truncatedError = truncatedError.slice(0, 3500) + '\n\n... (error truncated)';
      }
      await ctx.reply(`❌ Error:\n<pre>${escapeHtml(truncatedError)}</pre>`, { parse_mode: 'HTML' });
    }
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    if (!ctx.from) return;

    const userId = ctx.from.id;

    await withUserLock(userId, async () => {
      deps.history.push(userId, { role: 'user', content: text });

      const sendTyping = () => {
        ctx.sendChatAction('typing').catch(() => undefined);
      };
      sendTyping();
      const typingTimer: NodeJS.Timeout = setInterval(sendTyping, 4000);

      // Streaming state. We send a placeholder message and progressively
      // edit it as deltas arrive, throttled to ~1 edit/sec to stay well
      // within Telegram's edit limits. When the model interrupts the
      // streamed turn with tool_calls (or any turn ends), we flush a final
      // edit so the user sees the partial text, then start a new placeholder
      // for the next streamed turn so tool status messages aren't overwritten.
      const streamEnabled = deps.streamEnabled !== false;
      const chatId = ctx.chat.id;
      const EDIT_INTERVAL_MS = 1000;
      const SOFT_MAX_LEN = 3900; // stay under Telegram's 4096 hard cap
      const PLACEHOLDER = '…';

      let currentMessageId: number | undefined;
      let currentBuffer = '';
      let lastSentText = '';
      let lastEditAt = 0;
      let pendingEdit: NodeJS.Timeout | undefined;
      let isSuspectedJson = false;
      // Serialize editMessageText calls so a delayed throttled edit can't
      // race with a final flush and clobber the latest text.
      let activeEdit: Promise<void> | undefined;
      let nextEdit: string | undefined;

      const doEdit = async (textToSend: string): Promise<void> => {
        if (currentMessageId === undefined) return;
        if (textToSend === lastSentText) return;
        const targetId = currentMessageId;
        try {
          await ctx.telegram.editMessageText(chatId, targetId, undefined, textToSend);
          if (currentMessageId === targetId) {
            lastSentText = textToSend;
            lastEditAt = Date.now();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!EDIT_NOT_MODIFIED_RE.test(msg)) {
            debug('telegram-stream', `editMessageText failed: ${msg}`);
          }
          lastEditAt = Date.now();
        }
      };

      const runEditLoop = async (): Promise<void> => {
        if (activeEdit) return;
        while (nextEdit !== undefined) {
          const text = nextEdit;
          nextEdit = undefined;
          activeEdit = doEdit(text);
          await activeEdit;
        }
        activeEdit = undefined;
      };

      const enqueueEdit = (textToSend: string): void => {
        nextEdit = textToSend;
        runEditLoop().catch(() => undefined);
      };

      const ensurePlaceholder = async (): Promise<void> => {
        if (currentMessageId !== undefined) return;
        const sent = await ctx.reply(PLACEHOLDER);
        currentMessageId = sent.message_id;
        lastSentText = PLACEHOLDER;
        lastEditAt = 0;
      };

      const scheduleEdit = (): void => {
        if (pendingEdit) return;
        const elapsed = Date.now() - lastEditAt;
        const wait = Math.max(0, EDIT_INTERVAL_MS - elapsed);
        pendingEdit = setTimeout(() => {
          pendingEdit = undefined;
          enqueueEdit(currentBuffer);
        }, wait);
      };

      const awaitEditCycle = async (): Promise<void> => {
        while (activeEdit || nextEdit !== undefined) {
          await (activeEdit || Promise.resolve());
        }
      };

      const flushEdit = async (): Promise<void> => {
        if (pendingEdit) {
          clearTimeout(pendingEdit);
          pendingEdit = undefined;
        }
        enqueueEdit(currentBuffer);
        await awaitEditCycle();
      };

      const rolloverIfNeeded = async (): Promise<void> => {
        while (currentBuffer.length >= SOFT_MAX_LEN) {
          const head = currentBuffer.slice(0, SOFT_MAX_LEN);
          const tail = currentBuffer.slice(SOFT_MAX_LEN);
          currentBuffer = head;
          await flushEdit();
          currentMessageId = undefined;
          currentBuffer = tail;
          lastSentText = '';
          await ensurePlaceholder();
        }
      };

      const handleDelta = async (chunk: string, _full: string): Promise<void> => {
        if (currentBuffer.length === 0 && !currentMessageId) {
          const trimmed = chunk.trimStart();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            isSuspectedJson = true;
          }
        }
        currentBuffer += chunk;
        if (isSuspectedJson) return;

        await ensurePlaceholder();
        await rolloverIfNeeded();
        scheduleEdit();
      };

      // Called when each assistant turn ends. If the turn produced
      // tool_calls (interim turn), flush what we have and reset so the
      // next turn streams into a new message — that way the user sees
      // the model's pre-tool reasoning, then the tool status message,
      // then the streamed final answer in a fresh message.
      const handleTurnEnd = async (full: string, hasToolCalls: boolean): Promise<void> => {
        if (hasToolCalls) {
          if (currentMessageId !== undefined) {
            await flushEdit();
            // Defensive cleanup: if the turn produced tool calls and the
            // content was mostly just the raw JSON, delete the streamed
            // message so it doesn't clutter the chat.
            if (isSuspectedJson) {
              try {
                await ctx.telegram.deleteMessage(chatId, currentMessageId);
              } catch (err) {
                debug('telegram-stream', 'failed to delete leaked json message:', err);
              }
            }
            currentMessageId = undefined;
            currentBuffer = '';
            lastSentText = '';
          }
          isSuspectedJson = false;
          return;
        }
        // Final turn: ensure the last fragment is rendered. If the model
        // produced content but never streamed a delta (extremely fast
        // server, no chunks before done:true) or we suppressed it because
        // it looked like JSON but wasn't a tool call, send it now.
        if (currentMessageId === undefined) {
          if (full.length > 0) {
            await ctx.reply(full);
          }
        } else {
          await flushEdit();
        }
        isSuspectedJson = false;
      };

      try {
        const messages = deps.history.get(userId);
        const reply = await deps.ollama.chat(messages, {
          tools: deps.tools,
          maxToolSteps: deps.maxToolSteps,
          onToolStart: async (name, _args) => {
            debug('telegram-tool', `starting tool: ${name}`);
            sendTyping();
          },
          onAssistantDelta: streamEnabled ? handleDelta : undefined,
          onAssistantTurnEnd: streamEnabled ? handleTurnEnd : undefined,
        });
        deps.history.push(userId, { role: 'assistant', content: reply });
        if (!streamEnabled) {
          await ctx.reply(reply);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug('telegram-text', err);
        if (pendingEdit) {
          clearTimeout(pendingEdit);
          pendingEdit = undefined;
        }
        await ctx.reply(`❌ ${msg}`);
      } finally {
        clearInterval(typingTimer);
      }
    });
  });

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Welcome message' },
    { command: 'help', description: 'Show help' },
    { command: 'clear', description: 'Reset chat history' },
    { command: 'model', description: 'Show current model' },
  ]);

  // bot.launch() resolves only after the bot stops; awaiting it would block
  // forever. Telegraf's polling loop re-throws fatal errors (e.g. 401 invalid
  // token, 409 polling conflict) after startup, so we must attach a handler
  // ourselves — otherwise those become unhandledRejection and crash the
  // process around our error-reporting path.
  bot.launch().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`Telegram bot launch failed: ${msg}`);
    if (deps.onFatal) deps.onFatal(err);
    else process.exit(1);
  });
  // eslint-disable-next-line no-console
  console.log('Telegram bot is running...');

  return {
    stop: (reason?: string) => bot.stop(reason),
  };
}
