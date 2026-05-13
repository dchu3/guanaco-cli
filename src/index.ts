import { loadConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { HistoryStore } from './history.js';
import { startCli } from './cli.js';
import { buildToolRegistry } from './tools.js';

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
  console.log(`guanaco-cli · model=${cfg.ollamaModel} · ollama=${cfg.ollamaBaseUrl}`);

  const shutdown = (signal: string) => () => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, stopping...`);
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
