import { describe, it, expect } from 'vitest';
import { Container, Markdown, Text, Spacer, type MarkdownTheme } from '@earendil-works/pi-tui';
import { trimChatToFit, fixedHeight, totalHeight, type ChatRegions } from '../../src/ui/layout.js';

// Plain markdown theme (identity styling) so render heights reflect the
// raw text length / wrapping without ANSI color codes.
const plainTheme: MarkdownTheme = {
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

function buildRegions(): ChatRegions {
  const header = new Container();
  header.addChild(new Spacer(1));
  header.addChild(new Text('  Guanaco CLI · SDLC harness', 1, 0));
  header.addChild(new Text('  Model: llama3.2 · provider: local', 1, 0));
  header.addChild(new Spacer(1));

  const chat = new Container();
  const status = new Container();
  const editor = new Container();
  // Simulate the editor's two border rules + one content line.
  editor.addChild(new Text('────────────────', 1, 0));
  editor.addChild(new Text('  [editor]', 1, 0));
  editor.addChild(new Text('────────────────', 1, 0));

  return { header, chat, status, editor };
}

/** Add a chat message block (Spacer + Markdown), mirroring cli.addMessage. */
function addMessage(regions: ChatRegions, content: string): Markdown {
  regions.chat.addChild(new Spacer(1));
  const msg = new Markdown(`You: ${content}`, 1, 0, plainTheme);
  regions.chat.addChild(msg);
  return msg;
}

describe('trimChatToFit', () => {
  it('is a no-op when the terminal size is unknown (rows<=0 or columns<=0)', () => {
    const r = buildRegions();
    addMessage(r, 'hello');
    addMessage(r, 'world');
    const before = r.chat.children.length;
    trimChatToFit(r, { columns: 80, rows: 0 });
    trimChatToFit(r, { columns: 0, rows: 24 });
    trimChatToFit(r, { columns: -1, rows: 24 });
    expect(r.chat.children.length).toBe(before);
  });

  it('keeps the whole layout within terminal rows by trimming oldest messages', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 10; // small terminal
    // header=4, editor=3, spacer=1, status=0 → fixed=8, budget=2.
    // Each message block is Spacer(1) + 1 line = 2 lines, so only one fits.
    for (let i = 0; i < 6; i++) addMessage(r, `message ${i}`);
    trimChatToFit(r, { columns: cols, rows });

    expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
    // Header is fully preserved.
    expect(r.header.render(cols).length).toBe(4);
    // The latest message is retained; older ones were dropped.
    const lastMsg = r.chat.children[r.chat.children.length - 1] as Markdown;
    expect(lastMsg.render(cols).join(' ')).toContain('message 5');
  });

  it('never strips below a single message block, even when that block overflows', () => {
    const r = buildRegions();
    const cols = 20;
    const rows = 6; // fixed=8 already exceeds rows → budget=0
    addMessage(r, 'this is a fairly long message that will wrap');
    const before = r.chat.children.length;
    trimChatToFit(r, { columns: cols, rows });
    // At least the Spacer + message remain.
    expect(r.chat.children.length).toBeGreaterThanOrEqual(2);
    expect(r.chat.children.length).toBe(before); // nothing removed (only one block)
  });

  it('accounts for status height when computing the budget', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 11; // fixed without status = 8, budget=3 → one block(2) fits, two(4) don't
    for (let i = 0; i < 5; i++) addMessage(r, `m${i}`);
    r.status.addChild(new Text('  Thinking...', 1, 0)); // status now 1 line → fixed=9, budget=2
    trimChatToFit(r, { columns: cols, rows });
    expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
  });

  it('preserves the header across many add+trim cycles (header stays pinned)', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 12;
    for (let i = 0; i < 50; i++) {
      addMessage(r, `message number ${i}`);
      trimChatToFit(r, { columns: cols, rows });
      // Invariant: total fits in one screen (header always visible).
      expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
    }
    expect(r.header.render(cols).length).toBe(4);
    // The most recent message is present; the first is long gone.
    const last = r.chat.children[r.chat.children.length - 1] as Markdown;
    expect(last.render(cols).join(' ')).toContain('message number 49');
  });

  it('respects markdown wrapping: a long single-line message consumes multiple rows', () => {
    const r = buildRegions();
    const cols = 20;
    const rows = 12; // fixed=8, budget=4
    addMessage(r, 'short'); // 1 line
    addMessage(r, 'a'.repeat(60)); // wraps to several lines at width 20
    trimChatToFit(r, { columns: cols, rows });
    // The short block is dropped; only the latest (long, wrapping) block stays.
    // A single oversized block is allowed to overflow the budget (documented edge case).
    expect(r.chat.children.length).toBe(2);
    const last = r.chat.children[1] as Markdown;
    expect(last.render(cols).length).toBeGreaterThan(1);
  });

  it('exposes fixedHeight/totalHeight consistently', () => {
    const r = buildRegions();
    addMessage(r, 'x');
    const cols = 80;
    const fixed = fixedHeight(r, cols);
    const total = totalHeight(r, cols);
    // chat = Spacer(1) + message(1) = 2
    expect(total).toBe(fixed + 2);
  });
});