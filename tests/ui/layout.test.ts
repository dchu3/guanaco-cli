import { describe, it, expect } from 'vitest';
import { Container, Markdown, Text, Spacer, type MarkdownTheme } from '@earendil-works/pi-tui';
import { layoutToFit, fixedHeight, totalHeight, type ChatRegions } from '../../src/ui/layout.js';

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
  const filler = new Spacer(1);
  const editor = new Container();
  const footer = new Container();
  // Simulate the editor's two border rules + one content line.
  editor.addChild(new Text('────────────────', 1, 0));
  editor.addChild(new Text('  [editor]', 1, 0));
  editor.addChild(new Text('────────────────', 1, 0));

  return { header, chat, status, filler, editor, footer };
}

/** Add a chat message block (Spacer + Markdown), mirroring cli.addMessage. */
function addMessage(regions: ChatRegions, content: string): Markdown {
  regions.chat.addChild(new Spacer(1));
  const msg = new Markdown(`You: ${content}`, 1, 0, plainTheme);
  regions.chat.addChild(msg);
  return msg;
}

describe('layoutToFit', () => {
  it('is a no-op when the terminal size is unknown (rows<=0 or columns<=0)', () => {
    const r = buildRegions();
    addMessage(r, 'hello');
    addMessage(r, 'world');
    const before = r.chat.children.length;
    layoutToFit(r, { columns: 80, rows: 0 });
    layoutToFit(r, { columns: 0, rows: 24 });
    layoutToFit(r, { columns: -1, rows: 24 });
    expect(r.chat.children.length).toBe(before);
  });

  it('keeps the whole layout within terminal rows by trimming oldest messages', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 10; // small terminal
    // header=4, editor=3, spacer=1, status=0 → fixed=8, budget=2.
    // Each message block is Spacer(1) + 1 line = 2 lines, so only one fits.
    for (let i = 0; i < 6; i++) addMessage(r, `message ${i}`);
    layoutToFit(r, { columns: cols, rows });

    expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
    // Header is fully preserved.
    expect(r.header.render(cols).length).toBe(4);
    // The latest message is retained; older ones were dropped.
    const lastMsg = r.chat.children[r.chat.children.length - 1] as Markdown;
    expect(lastMsg.render(cols).join(' ')).toContain('message 5');
  });

  it('skips trimming entirely when budget < 2 (very short terminal), leaving chat unshifted', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 6; // fixed=8 > rows → budget = max(0, 6-8) = 0 < 2
    for (let i = 0; i < 3; i++) addMessage(r, `m${i}`);
    const before = r.chat.children.length;
    layoutToFit(r, { columns: cols, rows });
    // No trim (and therefore no chat shift) — shifting chat above the viewport
    // would trigger a pi-tui full-screen clear, which is what we avoid here.
    expect(r.chat.children.length).toBe(before);
  });

  it('accounts for status height when computing the budget', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 11; // fixed without status = 8, budget=3 → one block(2) fits, two(4) don't
    for (let i = 0; i < 5; i++) addMessage(r, `m${i}`);
    r.status.addChild(new Text('  Thinking...', 1, 0)); // status now 1 line → fixed=9, budget=2
    layoutToFit(r, { columns: cols, rows });
    expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
  });

  it('preserves the header across many add+trim cycles (header stays pinned)', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 12;
    for (let i = 0; i < 50; i++) {
      addMessage(r, `message number ${i}`);
      layoutToFit(r, { columns: cols, rows });
      // Invariant: total fits in one screen (header always visible).
      expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
    }
    expect(r.header.render(cols).length).toBe(4);
    // The most recent message is present; the first is long gone.
    const last = r.chat.children[r.chat.children.length - 1] as Markdown;
    expect(last.render(cols).join(' ')).toContain('message number 49');
  });

  it('trims an oversized OLDER wrapping message, keeping the latest that fits', () => {
    const r = buildRegions();
    const cols = 20;
    const rows = 12; // fixed=8, budget=4
    addMessage(r, 'a'.repeat(60)); // older, wraps to several lines at width 20
    addMessage(r, 'short'); // latest, block = Spacer + 1 line = 2
    layoutToFit(r, { columns: cols, rows });
    // The oversized older block is dropped; the latest (short) fits.
    expect(totalHeight(r, cols)).toBeLessThanOrEqual(rows);
    expect(r.chat.children.length).toBe(2); // Spacer + short
    const last = r.chat.children[1] as Markdown;
    expect(last.render(cols).join(' ')).toContain('short');
  });

  it('reverts (does not shift chat) when the latest message alone overflows the budget', () => {
    const r = buildRegions();
    const cols = 20;
    const rows = 12; // fixed=8, budget=4
    addMessage(r, 'short'); // older, block 2
    addMessage(r, 'a'.repeat(60)); // latest, wraps to ~4 lines → block ~5 > budget
    const before = r.chat.children.length; // 4
    layoutToFit(r, { columns: cols, rows });
    // Trimming can't make it fit (the latest alone overflows) → revert, so chat
    // is not shifted (avoids a pi-tui full-screen clear). Overflow is accepted.
    expect(r.chat.children.length).toBe(before);
    expect(totalHeight(r, cols)).toBeGreaterThan(rows);
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

  it('pins the editor at the bottom by filling the gap when chat is short', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 30; // lots of room — chat is far shorter than the screen
    addMessage(r, 'hello'); // chat = Spacer + 1 line = 2
    layoutToFit(r, { columns: cols, rows });

    // The filler absorbed the leftover space so the whole layout fills the screen.
    expect(totalHeight(r, cols)).toBe(rows);
    // The filler is what grew (everything else is at its natural height).
    const natural =
      r.header.render(cols).length +
      r.chat.render(cols).length +
      r.status.render(cols).length +
      r.editor.render(cols).length +
      r.footer.render(cols).length;
    expect(r.filler.render(cols).length).toBe(rows - natural);
    // The editor is the last region before the footer, i.e. its content sits at
    // the bottom of the buffer (not floating mid-screen).
    const lines = [
      ...r.header.render(cols),
      ...r.chat.render(cols),
      ...r.status.render(cols),
      ...r.filler.render(cols),
      ...r.editor.render(cols),
      ...r.footer.render(cols),
    ];
    expect(lines.length).toBe(rows);
    expect(lines[lines.length - 1 - r.footer.render(cols).length - 1]).toContain('[editor]');
  });

  it('shrinks the filler to the minimum gap when chat overflows the screen', () => {
    const r = buildRegions();
    const cols = 80;
    const rows = 12; // header=4, editor=3, footer=0, status=0, MIN_GAP=1 → fixed=8, budget=4
    for (let i = 0; i < 6; i++) addMessage(r, `message ${i}`); // overflows budget
    layoutToFit(r, { columns: cols, rows });

    // Filler collapses to the minimum gap; layout still totals exactly `rows`.
    expect(r.filler.render(cols).length).toBe(1);
    expect(totalHeight(r, cols)).toBe(rows);
    // Header still pinned at the top.
    expect(r.header.render(cols).length).toBe(4);
  });
});