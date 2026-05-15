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
import type { OllamaClient, Message } from './ollama.js';
import type { ToolRegistry } from './tools.js';

export interface CliDeps {
  ollama: OllamaClient;
  tools: ToolRegistry;
  streamEnabled: boolean;
}

const THEME = {
  accent: chalk.cyan,
  muted: chalk.dim,
  error: chalk.red,
  success: chalk.green,
  border: chalk.dim,
};

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
    selectedPrefix: (text: string) => chalk.cyan('→ '),
    selectedText: (text: string) => chalk.cyan(text),
    description: (text: string) => chalk.dim(text),
    scrollInfo: (text: string) => chalk.dim(text),
    noMatch: (text: string) => chalk.red(text),
  },
};

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
    const prefix = role === 'user' ? chalk.bold.green('You: ') : chalk.bold.cyan('Assistant: ');
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
        addMessage('system', 'Available Commands:\n- /help: Show this help\n- /clear: Clear chat history\n- /model <name>: Change model\n- /exit: Exit the application');
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
