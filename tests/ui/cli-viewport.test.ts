import { TUI, Container, Text, Spacer, Markdown, Editor, type MarkdownTheme, type EditorTheme, type Terminal } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { describe, it, expect } from 'vitest';
import { trimChatToFit, type ChatRegions } from '../../src/ui/layout.js';

/** Minimal Terminal implementation for driving TUI.render without stdin. */
class MockTerminal implements Terminal {
  writes: string[] = [];
  clears = 0;
  constructor(private readonly cols: number, private readonly rowsN: number) {}
  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(data: string): void {
    this.writes.push(data);
    // eslint-disable-next-line no-control-regex
    this.clears += (data.match(/\x1b\[2J/g) || []).length;
  }
  get columns(): number {
    return this.cols;
  }
  get rows(): number {
    return this.rowsN;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {
    this.clears += 1;
  }
  setTitle(): void {}
  setProgress(): void {}
}

const theme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

function buildApp(rows: number): { ui: TUI; term: MockTerminal; regions: ChatRegions; cols: number } {
  const cols = 80;
  const term = new MockTerminal(cols, rows);
  const ui = new TUI(term);

  const header = new Container();
  const chat = new Container();
  const status = new Container();
  const editor = new Container();
  ui.addChild(header);
  ui.addChild(chat);
  ui.addChild(status);
  ui.addChild(new Spacer(1));
  ui.addChild(editor);

  // Header (mirrors cli.renderHeader)
  header.addChild(new Spacer(1));
  header.addChild(new Text(chalk.bold.cyan('  Guanaco CLI 🦙  ·  SDLC harness'), 1, 0));
  header.addChild(new Text(chalk.dim('  Model: llama3.2  ·  chat provider: local'), 1, 0));
  header.addChild(new Spacer(1));

  // Editor stand-in (a real Editor needs stdin; two border rules + content line)
  editor.addChild(new Text('────────────', 1, 0));
  editor.addChild(new Text('  [editor]', 1, 0));
  editor.addChild(new Text('────────────', 1, 0));

  return { ui, term, regions: { header, chat, status, editor }, cols };
}

function renderChat(ui: TUI, regions: ChatRegions): void {
  trimChatToFit(regions, { columns: ui.terminal.columns, rows: ui.terminal.rows });
  ui.requestRender();
}

/** Like buildApp but uses a REAL Editor with the cli `onChange` trim hook. */
function buildAppWithEditor(
  rows: number,
): { ui: TUI; term: MockTerminal; regions: ChatRegions; editor: Editor; cols: number } {
  const cols = 80;
  const term = new MockTerminal(cols, rows);
  const ui = new TUI(term);

  const header = new Container();
  const chat = new Container();
  const status = new Container();
  const editorContainer = new Container();
  ui.addChild(header);
  ui.addChild(chat);
  ui.addChild(status);
  ui.addChild(new Spacer(1));
  ui.addChild(editorContainer);

  const editorTheme: EditorTheme = {
    borderColor: (t: string) => chalk.dim(t),
    selectList: {
      selectedPrefix: (_t: string) => chalk.cyan('→ '),
      selectedText: (t: string) => chalk.cyan(t),
      description: (t: string) => chalk.dim(t),
      scrollInfo: (t: string) => chalk.dim(t),
      noMatch: (t: string) => chalk.red(t),
    },
  };
  const editor = new Editor(ui, editorTheme, { paddingX: 1 });
  editorContainer.addChild(editor);
  ui.setFocus(editor);

  header.addChild(new Spacer(1));
  header.addChild(new Text(chalk.bold.cyan('  Guanaco CLI 🦙  ·  SDLC harness'), 1, 0));
  header.addChild(new Text(chalk.dim('  Model: llama3.2  ·  chat provider: local'), 1, 0));
  header.addChild(new Spacer(1));

  const regions: ChatRegions = { header, chat, status, editor: editorContainer };
  // Mirror cli.ts: trim on every editor text change (typing/paste/newline).
  editor.onChange = () => {
    trimChatToFit(regions, { columns: ui.terminal.columns, rows: ui.terminal.rows });
  };
  return { ui, term, regions, editor, cols };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CLI viewport integration (TUI + trimChatToFit)', () => {
  it('keeps the whole layout within one screen and the header pinned in the viewport', async () => {
    const rows = 10;
    const { ui, term, regions, cols } = buildApp(rows);

    // Initial render
    renderChat(ui, regions);
    await sleep(60);

    // Add many messages (each via the same path cli.addMessage uses).
    for (let i = 0; i < 20; i++) {
      regions.chat.addChild(new Spacer(1));
      regions.chat.addChild(new Markdown(`You: message ${i}`, 1, 0, theme));
      renderChat(ui, regions);
      await sleep(20);
    }

    // The full rendered buffer (what TUI would write) must fit in one screen.
    const lines = ui.render(cols);
    expect(lines.length).toBeLessThanOrEqual(rows);

    // The visible viewport is the bottom `rows` lines; the header must still be in it.
    const viewport = lines.slice(-rows);
    expect(viewport.some((l) => l.includes('Guanaco CLI'))).toBe(true);
    // And the editor is still visible too.
    expect(viewport.some((l) => l.includes('[editor]'))).toBe(true);
    // No forced clear-screen was emitted on incremental renders.
    expect(term.clears).toBe(0);
  });

  it('does not emit clear-screen sequences on streaming-style setText updates', async () => {
    const rows = 12;
    const { ui, term, regions, cols } = buildApp(rows);
    renderChat(ui, regions);
    await sleep(60);

    regions.chat.addChild(new Spacer(1));
    const msg = new Markdown('Assistant: ...', 1, 0, theme);
    regions.chat.addChild(msg);
    renderChat(ui, regions);
    await sleep(20);

    // Simulate streaming deltas growing the message.
    for (let i = 0; i < 30; i++) {
      msg.setText(`Assistant: ${'x'.repeat(i * 4)}`);
      renderChat(ui, regions);
      await sleep(10);
    }

    const lines = ui.render(cols);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(term.clears).toBe(0);
  });
});

describe('CLI viewport while typing (real Editor + onChange trim)', () => {
  it('keeps the header pinned while the user types a long, wrapping input', async () => {
    const rows = 24;
    const { ui, term, regions, editor, cols } = buildAppWithEditor(rows);
    renderChat(ui, regions);
    await sleep(40);

    // Pre-fill chat so the screen is nearly full.
    for (let i = 0; i < 8; i++) {
      regions.chat.addChild(new Spacer(1));
      regions.chat.addChild(new Markdown(`msg ${i} `.repeat(6), 1, 0, theme));
      renderChat(ui, regions);
    }
    await sleep(20);

    const before = ui.render(cols);
    expect(before.some((l) => l.includes('Guanaco CLI'))).toBe(true);

    // Simulate typing a long line that wraps across many editor lines.
    // editor.setText calls onChange once (per its contract) → trim runs;
    // then the TUI's post-handleInput requestRender is mirrored here.
    editor.setText('a'.repeat(400));
    ui.requestRender();
    await sleep(20);

    const lines = ui.render(cols);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.slice(-rows).some((l) => l.includes('Guanaco CLI'))).toBe(true);
    expect(term.clears).toBe(0);
  });

  it('keeps the header pinned while typing multi-line input (newlines)', async () => {
    const rows = 20;
    const { ui, regions, editor, cols } = buildAppWithEditor(rows);
    renderChat(ui, regions);
    await sleep(40);
    for (let i = 0; i < 6; i++) {
      regions.chat.addChild(new Spacer(1));
      regions.chat.addChild(new Markdown(`msg ${i} `.repeat(5), 1, 0, theme));
      renderChat(ui, regions);
    }
    // 10 newlines → editor grows to ~11 content lines (capped by maxVisibleLines).
    editor.setText(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
    ui.requestRender();
    await sleep(20);
    const lines = ui.render(cols);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.slice(-rows).some((l) => l.includes('Guanaco CLI'))).toBe(true);
  });
});