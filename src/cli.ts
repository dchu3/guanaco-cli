import enquirer from 'enquirer';
import pc from 'picocolors';
import ora from 'ora';
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
  console.log(pc.cyan(pc.bold('\nWelcome to the Guanaco CLI! 🦙')));
  // eslint-disable-next-line no-console
  console.log(pc.dim('Type your message or use a command (e.g., /help).\n'));
  showHelp();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { input } = await enquirer.prompt<{ input: string }>({
        type: 'input',
        name: 'input',
        message: pc.green(pc.bold('You')),
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
          console.log(pc.cyan('\n🧹 Chat history cleared.\n'));
        } else if (cmd === 'model') {
          // eslint-disable-next-line no-console
          console.log(pc.cyan(`\n🤖 Current model: ${pc.bold(deps.ollama.currentModel)}\n`));
        } else if (cmd === 'execute') {
          if (!args) {
            // eslint-disable-next-line no-console
            console.log(pc.yellow('Usage: /execute <command>'));
          } else {
            try {
              const { stdout } = await execAsync(`./scripts/secure_execute.sh "${args.replace(/"/g, '\\"')}"`);
              // eslint-disable-next-line no-console
              console.log(`\n${pc.dim(stdout.trim() || '(no output)')}\n`);
            } catch (err: unknown) {
              const errorMsg = err instanceof Error ? ((err as { stdout?: string }).stdout || err.message) : String(err);
              // eslint-disable-next-line no-console
              console.log(`\n${pc.red(pc.bold('❌ Error:'))} ${pc.red(errorMsg.trim())}\n`);
            }
          }
        } else if (cmd === 'exit' || cmd === 'quit') {
          process.exit(0);
        } else {
          // eslint-disable-next-line no-console
          console.log(pc.yellow(`Unknown command: /${cmd}. Type /help for available commands.`));
        }
        continue;
      }

      deps.history.push(CLI_USER_ID, { role: 'user', content: text });
      process.stdout.write(`\n${pc.blue(pc.bold('AI'))}: `);

      const spinner = ora({
        text: pc.dim('Thinking...'),
        color: 'cyan',
      }).start();

      try {
        const streamEnabled = deps.streamEnabled !== false;
        let fullResponse = '';

        const handleDelta = (chunk: string) => {
          if (spinner.isSpinning) {
            spinner.stop();
          }
          fullResponse += chunk;
          process.stdout.write(chunk);
        };

        const reply = await deps.ollama.chat(deps.history.get(CLI_USER_ID), {
          tools: deps.tools,
          maxToolSteps: deps.maxToolSteps,
          onAssistantDelta: streamEnabled ? handleDelta : undefined,
        });

        if (spinner.isSpinning) {
          spinner.stop();
        }

        if (!streamEnabled) {
          process.stdout.write(reply);
          fullResponse = reply;
        }

        process.stdout.write('\n\n');
        deps.history.push(CLI_USER_ID, { role: 'assistant', content: fullResponse });
      } catch (err) {
        if (spinner.isSpinning) {
          spinner.stop();
        }
        throw err;
      }
    } catch (err) {
      if (err === '') {
        // Enquirer throws empty string on Ctrl+C in some cases
        process.exit(0);
      }
      // eslint-disable-next-line no-console
      console.error(`\n${pc.red(pc.bold('❌ Error:'))}`, pc.red(err instanceof Error ? err.message : String(err)));
    }
  }
}

function showHelp() {
  const commands = [
    ['/help', 'Show this help message'],
    ['/clear', 'Reset chat history'],
    ['/model', 'Show current model'],
    ['/execute', 'Execute a shell command (restricted)'],
    ['/exit', 'Exit the application'],
  ];

  // eslint-disable-next-line no-console
  console.log(pc.bold('Available Commands:'));
  for (const [cmd, desc] of commands) {
    // eslint-disable-next-line no-console
    console.log(`  ${pc.cyan(cmd.padEnd(10))} — ${pc.dim(desc)}`);
  }
  // eslint-disable-next-line no-console
  console.log();
}
