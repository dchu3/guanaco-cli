import enquirer from 'enquirer';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { OllamaClient } from './ollama.js';
import type { HistoryStore } from './history.js';
import type { ToolRegistry } from './tools.js';

export interface CliDeps {
  ollama: OllamaClient;
  history: HistoryStore;
  tools?: ToolRegistry;
  maxToolSteps?: number;
  streamEnabled?: boolean;
}

const CLI_USER_ID = 0;
const execAsync = promisify(exec);

export async function startCli(deps: CliDeps): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\nWelcome to the LLM CLI! Type your message or a command.\n');
  showHelp();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { input } = await enquirer.prompt<{ input: string }>({
        type: 'input',
        name: 'input',
        message: 'You:',
        validate: (value) => (value.trim().length === 0 ? 'Please enter a message.' : true),
      });

      const text = input.trim();

      if (text.startsWith('/')) {
        const parts = text.split(' ');
        const cmd = parts[0].slice(1).toLowerCase();
        const args = parts.slice(1).join(' ').trim();

        if (cmd === 'help') {
          showHelp();
        } else if (cmd === 'clear') {
          deps.history.clear(CLI_USER_ID);
          // eslint-disable-next-line no-console
          console.log('🧹 Chat history cleared.');
        } else if (cmd === 'model') {
          // eslint-disable-next-line no-console
          console.log(`Current model: ${deps.ollama.currentModel}`);
        } else if (cmd === 'execute') {
          if (!args) {
            // eslint-disable-next-line no-console
            console.log('Usage: /execute <command>');
          } else {
            try {
              const { stdout } = await execAsync(`./scripts/secure_execute.sh "${args.replace(/"/g, '\\"')}"`);
              // eslint-disable-next-line no-console
              console.log(`\n${stdout.trim() || '(no output)'}\n`);
            } catch (err: unknown) {
              const errorMsg = err instanceof Error ? ((err as { stdout?: string }).stdout || err.message) : String(err);
              // eslint-disable-next-line no-console
              console.log(`\n❌ Error: ${errorMsg.trim()}\n`);
            }
          }
        } else if (cmd === 'exit' || cmd === 'quit') {
          process.exit(0);
        } else {
          // eslint-disable-next-line no-console
          console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
        }
        continue;
      }

      deps.history.push(CLI_USER_ID, { role: 'user', content: text });

      process.stdout.write('\nAI: ');

      const streamEnabled = deps.streamEnabled !== false;
      let fullResponse = '';

      const handleDelta = (chunk: string) => {
        fullResponse += chunk;
        process.stdout.write(chunk);
      };

      const reply = await deps.ollama.chat(deps.history.get(CLI_USER_ID), {
        tools: deps.tools,
        maxToolSteps: deps.maxToolSteps,
        onAssistantDelta: streamEnabled ? handleDelta : undefined,
      });

      if (!streamEnabled) {
        process.stdout.write(reply);
        fullResponse = reply;
      }

      process.stdout.write('\n\n');
      deps.history.push(CLI_USER_ID, { role: 'assistant', content: fullResponse });
    } catch (err) {
      if (err === '') {
        // Enquirer throws empty string on Ctrl+C in some cases
        process.exit(0);
      }
      // eslint-disable-next-line no-console
      console.error('\n❌ Error:', err instanceof Error ? err.message : String(err));
    }
  }
}

function showHelp() {
  // eslint-disable-next-line no-console
  console.log(
    'Commands:\n' +
      '  /help    — show this help message\n' +
      '  /clear   — reset chat history\n' +
      '  /model   — show current model\n' +
      '  /execute — execute a shell command (restricted)\n' +
      '  /exit    — exit the application\n',
  );
}
