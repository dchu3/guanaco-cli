import enquirer from 'enquirer';
import pc from 'picocolors';
import ora from 'ora';
import type { OllamaClient, Message } from './ollama.js';
import type { ToolRegistry } from './tools.js';

export interface CliDeps {
  ollama: OllamaClient;
  systemPrompt?: string;
  tools?: ToolRegistry;
  maxToolSteps?: number;
  streamEnabled?: boolean;
}

export async function startCli(deps: CliDeps): Promise<void> {
  showHeader(deps);
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
          // eslint-disable-next-line no-console
          console.clear();
          showHeader(deps);
        } else if (cmd === 'model') {
          // eslint-disable-next-line no-console
          console.log(pc.cyan(`\n🤖 Current model: ${pc.bold(deps.ollama.currentModel)}\n`));
        } else if (cmd === 'exit' || cmd === 'quit') {
          process.exit(0);
        } else {
          // eslint-disable-next-line no-console
          console.log(pc.yellow(`Unknown command: /${cmd}. Type /help for available commands.`));
        }
        continue;
      }

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
            process.stdout.write(`\n${pc.blue(pc.bold('AI'))}: `);
          }
          fullResponse += chunk;
          process.stdout.write(chunk);
        };

        const messages: Message[] = [];
        if (deps.systemPrompt) {
          messages.push({ role: 'system', content: deps.systemPrompt });
        }
        messages.push({ role: 'user', content: text });

        const reply = await deps.ollama.chat(messages, {
          tools: deps.tools,
          maxToolSteps: deps.maxToolSteps,
          onAssistantDelta: streamEnabled ? handleDelta : undefined,
        });

        if (spinner.isSpinning) {
          spinner.stop();
          process.stdout.write(`\n${pc.blue(pc.bold('AI'))}: `);
        }

        if (!streamEnabled) {
          process.stdout.write(reply);
          fullResponse = reply;
        }

        process.stdout.write('\n\n');
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

function showHeader(deps: CliDeps) {
  // eslint-disable-next-line no-console
  console.log(pc.cyan(pc.bold('\nWelcome to the Guanaco CLI! 🦙')));
  // eslint-disable-next-line no-console
  console.log(
    pc.dim('Model: ') +
      pc.cyan(deps.ollama.currentModel) +
      pc.dim(' | Streaming: ') +
      pc.cyan(deps.streamEnabled !== false ? 'On' : 'Off')
  );
  // eslint-disable-next-line no-console
  console.log(pc.dim('Type your message or use a command (e.g., /help).\n'));
}

function showHelp() {
  const commands = [
    ['/help', 'Show this help message'],
    ['/clear', 'Clear the terminal screen'],
    ['/model', 'Show current model'],
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
