import { loadConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { startCli } from './cli.js';
import { buildToolRegistry } from './tools.js';
import { buildSdlcAgentsFromConfig } from './mastra/index.js';
import { GitOps } from './harness/git.js';
import { getVersion, wantsVersion } from './version.js';
import { captureStderr, getLogFile, logError, logInfo } from './util/log.js';

/** Persist any error that escapes the normal control flow so it isn't lost to
 * the TUI's synchronized rendering (which overwrites console output). */
function installGlobalErrorCapture(): void {
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    // eslint-disable-next-line no-console
    console.error('uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason);
    // eslint-disable-next-line no-console
    console.error('unhandledRejection:', reason);
  });
}

async function main(): Promise<void> {
  // Capture stderr + global errors FIRST, before anything can throw, so the
  // "errors that flash and get cleared" are persisted to the debug log file.
  captureStderr();
  installGlobalErrorCapture();

  const argv = process.argv.slice(2);
  // Fast-path: print version and exit before constructing Ollama/Mastra so
  // `guanaco --version` works from any folder without a running Ollama.
  if (wantsVersion(argv)) {
    // eslint-disable-next-line no-console
    console.log(getVersion());
    process.exit(0);
  }

  const cfg = loadConfig();

  const ollama = new OllamaClient({
    baseUrl: cfg.ollamaBaseUrl,
    model: cfg.ollamaModel,
    timeoutMs: cfg.requestTimeoutMs,
    modelOptions: {
      temperature: cfg.temperature,
      top_p: cfg.topP,
      num_ctx: cfg.numCtx,
    },
  });

  const tools = buildToolRegistry({});

  // SDLC harness: Mastra agents + tools, coordinated by HarnessRunner.
  const harnessAgents = buildSdlcAgentsFromConfig(cfg);
  const gitOps = new GitOps({ repoRoot: cfg.harness.repoRoot });

  // eslint-disable-next-line no-console
  console.log(
    `guanaco-cli · model=${cfg.ollamaModel} · ollama=${cfg.ollamaBaseUrl} · harness=${cfg.harness.provider}`,
  );
  const logFile = getLogFile();
  if (logFile) {
    // eslint-disable-next-line no-console
    console.log(`debug log: ${logFile}  (view in-app with /log)`);
    logInfo('startup', `guanaco-cli model=${cfg.ollamaModel} harness=${cfg.harness.provider}`);
  }

  const shutdown = (signal: string) => () => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, stopping...`);
    setTimeout(() => process.exit(0), 250);
  };

  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));

  await startCli({
    ollama,
    tools,
    streamEnabled: cfg.streamEnabled,
    harnessAgents,
    harnessConfig: cfg.harness,
    gitOps,
  });
}

main().catch((err) => {
  logError('main', err);
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});