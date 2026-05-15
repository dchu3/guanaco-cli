import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  TUI,
  ProcessTerminal,
  Container,
  Markdown,
  Editor,
  Text,
  Spacer,
  type MarkdownTheme,
  type EditorTheme,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { OllamaClient } from './ollama.js';
import type { ToolRegistry } from './tools.js';

export interface CliDeps {
  ollama: OllamaClient;
  tools: ToolRegistry;
  streamEnabled: boolean;
}

const MARKDOWN_THEME: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue.underline(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic.dim(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

const EDITOR_THEME: EditorTheme = {
  borderColor: (text: string) => chalk.dim(text),
  selectList: {
    selectedPrefix: (_text: string) => chalk.cyan('→ '),
    selectedText: (text: string) => chalk.cyan(text),
    description: (text: string) => chalk.dim(text),
    scrollInfo: (text: string) => chalk.dim(text),
    noMatch: (text: string) => chalk.red(text),
  },
};

const execAsync = promisify(exec);

export async function startCli(deps: CliDeps): Promise<void> {
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const editorContainer = new Container();

  ui.addChild(headerContainer);
  ui.addChild(chatContainer);
  ui.addChild(statusContainer);
  ui.addChild(new Spacer(1));
  ui.addChild(editorContainer);

  const editor = new Editor(ui, EDITOR_THEME, { paddingX: 1 });
  editorContainer.addChild(editor);
  ui.setFocus(editor);

  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(new Text(chalk.bold.cyan('  Guanaco CLI 🦙'), 1, 0));
  headerContainer.addChild(new Text(chalk.dim(`  Model: ${deps.ollama.currentModel}`), 1, 0));
  headerContainer.addChild(new Spacer(1));

  function addMessage(role: string, content: string): Markdown {
    let prefix = '';
    if (role === 'user') {
      prefix = chalk.bold.green('You: ');
    } else if (role === 'assistant') {
      prefix = chalk.bold.cyan('Assistant: ');
    } else {
      prefix = chalk.bold.yellow('System: ');
    }
    chatContainer.addChild(new Spacer(1));
    const msg = new Markdown(`${prefix}\n${content}`, 1, 0, MARKDOWN_THEME);
    chatContainer.addChild(msg);
    ui.requestRender();
    return msg;
  }

  function showStatus(message: string) {
    statusContainer.clear();
    statusContainer.addChild(new Text(chalk.dim(`  ${message}`), 1, 0));
    ui.requestRender();
  }

  ui.start();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await new Promise<string>((resolve) => {
      editor.onSubmit = (text) => {
        editor.onSubmit = undefined;
        resolve(text);
      };
    });

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const [cmd, ...args] = trimmed.split(' ');
      if (cmd === '/exit' || cmd === '/quit') {
        ui.stop();
        process.exit(0);
      } else if (cmd === '/clear') {
        chatContainer.clear();
        ui.requestRender();
        continue;
      } else if (cmd === '/model') {
        const modelName = args[0];
        if (modelName) {
          deps.ollama.setModel(modelName);
          headerContainer.clear();
          headerContainer.addChild(new Spacer(1));
          headerContainer.addChild(new Text(chalk.bold.cyan('  Guanaco CLI 🦙'), 1, 0));
          headerContainer.addChild(new Text(chalk.dim(`  Model: ${deps.ollama.currentModel}`), 1, 0));
          headerContainer.addChild(new Spacer(1));
          showStatus(`Switched to model: ${modelName}`);
        } else {
          showStatus('Usage: /model <name>');
        }
        continue;
      } else if (cmd === '/help') {
        addMessage('system', 'Available Commands:\n- /help: Show this help\n- /clear: Clear chat history\n- /model <name>: Change model\n- /exit: Exit the application\n- !<command>: Execute shell command');
        continue;
      }
    }

    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim();
      if (command) {
        addMessage('user', trimmed);
        showStatus(`Executing: ${command}`);
        try {
          const { stdout, stderr } = await execAsync(command);
          if (stdout) {
            addMessage('system', stdout.trim());
          }
          if (stderr) {
            addMessage('system', chalk.yellow(stderr.trim()));
          }
        } catch (err: unknown) {
          const execError = err as { stdout?: string; stderr?: string; message?: string };
          if (execError.stdout) {
            addMessage('system', execError.stdout.trim());
          }
          if (execError.stderr) {
            addMessage('system', chalk.yellow(execError.stderr.trim()));
          }
          addMessage('system', chalk.red(`Error executing command: ${err instanceof Error ? err.message : String(err)}`));
        }
        statusContainer.clear();
        ui.requestRender();
        continue;
      }
    }

    addMessage('user', trimmed);
    const assistantMsg = addMessage('assistant', '...');
    let fullResponse = '';

    try {
      showStatus('Thinking...');
      const response = await deps.ollama.chat([{ role: 'user', content: trimmed }], {
        onAssistantDelta: (chunk) => {
          fullResponse += chunk;
          assistantMsg.setText(`${chalk.bold.cyan('Assistant: ')}\n${fullResponse}`);
          ui.requestRender();
        },
      });

      if (!deps.streamEnabled) {
        assistantMsg.setText(`${chalk.bold.cyan('Assistant: ')}\n${response}`);
      }
      statusContainer.clear();
      ui.requestRender();
    } catch (err) {
      statusContainer.clear();
      statusContainer.addChild(new Text(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`), 1, 0));
      ui.requestRender();
    }
  }
}
