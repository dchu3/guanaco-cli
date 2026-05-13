import { loadConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { HistoryStore } from './history.js';
import { startTelegramBot } from './telegram.js';
import { startCli } from './cli.js';
import { buildToolRegistry } from './tools.js';
import { maskPii } from './util/log.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const ollama = new OllamaClient({
    baseUrl: cfg.ollamaBaseUrl,
    model: cfg.ollamaModel,
    timeoutMs: cfg.requestTimeoutMs,
  });

  const history = new HistoryStore({
    maxMessages: cfg.maxHistoryMessages,
    systemPrompt: cfg.systemPrompt,
  });

  const tools = buildToolRegistry({});

  // eslint-disable-next-line no-console
  console.log(
    `telegram-local-llm-bot · model=${cfg.ollamaModel} · ollama=${cfg.ollamaBaseUrl} · ` +
      `telegramEnabled=${cfg.telegramEnabled}` +
      (cfg.telegramEnabled ? ` · allowedUser=${maskPii(cfg.allowedUserId)}` : ''),
  );

  let stopBot: ((reason?: string) => void) | undefined;

  if (cfg.telegramEnabled && cfg.telegramBotToken && cfg.allowedUserId !== undefined) {
    const running = await startTelegramBot({
      token: cfg.telegramBotToken,
      allowedUserId: cfg.allowedUserId,
      ollama,
      history,
      tools,
      streamEnabled: cfg.streamEnabled,
    });
    stopBot = running.stop;
  }

  const shutdown = (signal: string) => () => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, stopping...`);
    if (stopBot) stopBot(signal);
    setTimeout(() => process.exit(0), 250);
  };

  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));

  await startCli({
    ollama,
    history,
    tools,
    streamEnabled: cfg.streamEnabled,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
