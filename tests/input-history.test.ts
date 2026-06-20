import { describe, it, expect } from 'vitest';
import { TUI, Container, Editor, type EditorTheme, type Terminal } from '@earendil-works/pi-tui';
import chalk from 'chalk';

/**
 * Input-history behaviour: the CLI records every submitted line via
 * `editor.addToHistory(text)` (see nextInput() in src/cli.ts), and the Editor
 * recalls it with Up/Down arrows. These tests drive a real Editor through the
 * same submit → addToHistory → arrow-nav flow to lock the behaviour in.
 */

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

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ENTER = '\r';

function setup(): Editor {
  const term = new MockTerminal();
  const ui = new TUI(term);
  const container = new Container();
  ui.addChild(container);
  const editor = new Editor(ui, editorTheme, { paddingX: 1 });
  container.addChild(editor);
  ui.setFocus(editor);
  return editor;
}

/** Mirror the CLI's submit path: onSubmit records history then resolves. */
function submit(editor: Editor, text: string): void {
  editor.setText(text);
  return new Promise<void>((resolve) => {
    editor.onSubmit = (submitted) => {
      editor.onSubmit = undefined;
      editor.addToHistory(submitted);
      resolve();
    };
    editor.handleInput(ENTER);
  }) as unknown as void;
  // (handleInput(ENTER) calls onSubmit synchronously; the Promise resolves
  // immediately, so casting the awaited result to void is fine for the tests.)
}

describe('Editor input history (Up/Down arrow recall)', () => {
  it('recalls the most recent submission when Up is pressed on an empty editor', () => {
    const editor = setup();
    submit(editor, 'hello world');
    expect(editor.getText()).toBe(''); // editor clears after submit

    editor.handleInput(ARROW_UP);
    expect(editor.getText()).toBe('hello world');
  });

  it('navigates older with Up and back to the next with Down', () => {
    const editor = setup();
    submit(editor, 'first');
    submit(editor, 'second');
    expect(editor.getText()).toBe('');

    editor.handleInput(ARROW_UP); // -> second (most recent)
    expect(editor.getText()).toBe('second');
    editor.handleInput(ARROW_UP); // -> first (older)
    expect(editor.getText()).toBe('first');
    editor.handleInput(ARROW_DOWN); // -> second
    expect(editor.getText()).toBe('second');
    editor.handleInput(ARROW_DOWN); // past newest -> cleared
    expect(editor.getText()).toBe('');
  });

  it('does not recall anything when no history has been recorded', () => {
    const editor = setup();
    editor.handleInput(ARROW_UP);
    expect(editor.getText()).toBe('');
  });

  it('dedupes consecutive identical submissions', () => {
    const editor = setup();
    submit(editor, 'same');
    submit(editor, 'same');
    expect(editor.getText()).toBe('');

    editor.handleInput(ARROW_UP);
    expect(editor.getText()).toBe('same');
    // Only one entry exists, so a second Up stays on 'same'.
    editor.handleInput(ARROW_UP);
    expect(editor.getText()).toBe('same');
  });

  it('does not record empty/whitespace-only submissions', () => {
    const editor = setup();
    submit(editor, '   ');
    expect(editor.getText()).toBe('');
    editor.handleInput(ARROW_UP);
    expect(editor.getText()).toBe(''); // nothing to recall
  });
});