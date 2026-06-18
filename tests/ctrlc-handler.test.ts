import { describe, it, expect, vi } from 'vitest';
import {
  TUI,
  Container,
  Editor,
  CombinedAutocompleteProvider,
  type EditorTheme,
  type Terminal,
  type SlashCommand,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { createCtrlCHandler } from '../src/cli.js';
import { COMMANDS } from '../src/commands.js';

/** Minimal Terminal so we can drive a real Editor without stdin. */
class MockTerminal implements Terminal {
  constructor(public columns = 80, public rows = 24) {}
  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  get kittyProtocolActive(): boolean {
    return false;
  }
}

const editorTheme: EditorTheme = {
  borderColor: (t: string) => chalk.dim(t),
  selectList: {
    selectedPrefix: (t: string) => t,
    selectedText: (t: string) => t,
    description: (t: string) => t,
    scrollInfo: (t: string) => t,
    noMatch: (t: string) => t,
  },
};

const CTRL_C = '\x03';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const term = new MockTerminal();
  const ui = new TUI(term);
  const editorContainer = new Container();
  ui.addChild(editorContainer);
  const editor = new Editor(ui, editorTheme, { paddingX: 1 });
  editorContainer.addChild(editor);
  ui.setFocus(editor);

  const slashCommands: SlashCommand[] = COMMANDS.map((c) => ({
    name: c.name.slice(1),
    description: c.description,
    ...(c.args ? { argumentHint: c.args } : {}),
  }));
  editor.setAutocompleteMaxVisible(COMMANDS.length);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, process.cwd(), null),
  );

  const statusCalls: string[] = [];
  const quit = vi.fn();
  const handler = createCtrlCHandler({
    editor,
    ui,
    showStatus: (m: string) => statusCalls.push(m),
    quit,
  });
  return { ui, editor, handler, statusCalls, quit };
}

describe('createCtrlCHandler (two-stage Ctrl+C)', () => {
  it('quits when the editor is empty and no dropdown is open', () => {
    const { handler, quit, statusCalls } = setup();
    const result = handler(CTRL_C);
    expect(result).toEqual({ consume: true });
    expect(quit).toHaveBeenCalledTimes(1);
    expect(statusCalls).toHaveLength(0); // no clear hint
  });

  it('clears the input (and hints) when the editor has text, and does not quit', () => {
    const { editor, handler, quit, statusCalls } = setup();
    editor.setText('hello world');
    const result = handler(CTRL_C);
    expect(result).toEqual({ consume: true });
    expect(editor.getText()).toBe('');
    expect(quit).not.toHaveBeenCalled();
    expect(statusCalls).toEqual(['Input cleared — press Ctrl+C again to quit.']);
  });

  it('lets Ctrl+C pass through to the editor when the dropdown is open (does not clear or quit)', async () => {
    const { editor, handler, quit, statusCalls } = setup();
    // Type '/' to open the slash-menu dropdown, wait for the async getSuggestions.
    editor.handleInput('/');
    await sleep(30);
    expect(editor.isShowingAutocomplete()).toBe(true);

    const result = handler(CTRL_C);
    expect(result).toBeUndefined(); // do NOT consume — editor cancels dropdown
    expect(quit).not.toHaveBeenCalled();
    expect(statusCalls).toHaveLength(0);
  });

  it('ignores non-Ctrl+C input and key-release events', () => {
    const { handler, quit } = setup();
    expect(handler('a')).toBeUndefined();
    expect(handler('\r')).toBeUndefined();
    // Kitty-style key-release framing must not be treated as a press.
    expect(handler('\x1b[?1036l')).toBeUndefined();
    expect(quit).not.toHaveBeenCalled();
  });
});