import { Container, Spacer } from '@earendil-works/pi-tui';

/**
 * The stacked regions of the CLI layout, in top-to-bottom order:
 *   header → chat → status → filler (flex) → editor → footer
 *
 * `layoutToFit` keeps the total rendered height exactly equal to the terminal
 * height: it trims the oldest chat children when chat overflows, and grows /
 * shrinks the `filler` spacer when chat is shorter than the screen. That pins
 * the header at the top and the editor + footer at the bottom — only the chat
 * region scrolls (by dropping its oldest lines), so the input box never drifts
 * up and down as chat or status resize.
 */
export interface ChatRegions {
  header: Container;
  chat: Container;
  status: Container;
  /** Flex spacer between status and editor; sized each layout pass. */
  filler: Spacer;
  editor: Container;
  /** PWD + git branch line, rendered below the editor. */
  footer: Container;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Minimum blank gap the filler always keeps between status and editor. */
const MIN_GAP = 1;

/**
 * Height of the fixed (non-chat, non-flex) regions, including the minimum gap.
 * The filler's extra flex lines are excluded (they're computed from the
 * leftover space).
 */
export function fixedHeight(regions: ChatRegions, columns: number): number {
  return (
    regions.header.render(columns).length +
    regions.status.render(columns).length +
    regions.editor.render(columns).length +
    regions.footer.render(columns).length +
    MIN_GAP
  );
}

/**
 * Total rendered height of the full layout (all regions, including the
 * filler's current size). Useful for tests/assertions.
 */
export function totalHeight(regions: ChatRegions, columns: number): number {
  return (
    regions.header.render(columns).length +
    regions.chat.render(columns).length +
    regions.status.render(columns).length +
    regions.filler.render(columns).length +
    regions.editor.render(columns).length +
    regions.footer.render(columns).length
  );
}

/**
 * Trim the oldest chat children to fit (when chat overflows) and then size the
 * filler so the whole layout exactly fills the terminal: header pinned at the
 * top, editor + footer pinned at the bottom.
 *
 * Guarantees (important for avoiding pi-tui full-screen clears):
 * - No-op (except filler sizing) when the terminal size is unknown (non-TTY /
 *   not yet sized): we bail before trimming but still set the filler so a
 *   later render with a known size pins correctly.
 * - No trim when `budget < 2` (a minimal message block is Spacer + 1 line = 2):
 *   on very short terminals where even one block can't fit, trimming cannot
 *   help, so we don't shift chat (shifting chat from above the visible
 *   viewport would trigger pi-tui's `firstChanged < prevViewportTop` →
 *   `fullRender(true)` full-screen clear).
 * - Only commits a trim when the result actually fits the budget; otherwise it
 *   reverts, so trimming never leaves chat overflowing (which would also risk
 *   a full-render on the next change).
 * - Never strips below a single message block (Spacer + message).
 *
 * Pure w.r.t. the TUI: reads container state via `Container.render(width)` and
 * mutates only `chat` (removeChild) and `filler` (`setLines`). Does not touch
 * the TUI or call requestRender.
 */
export function layoutToFit(regions: ChatRegions, size: TerminalSize): void {
  const { columns, rows } = size;
  if (!Number.isFinite(columns) || columns <= 0 || !Number.isFinite(rows) || rows <= 0) {
    return;
  }
  const { chat } = regions;
  const budget = Math.max(0, rows - fixedHeight(regions, columns));
  if (budget >= 2) {
    // Snapshot so we can revert if trimming can't actually make it fit.
    const original = [...chat.children];
    // Keep at least one message block (Spacer + message = 2 children).
    while (chat.children.length > 2 && chat.render(columns).length > budget) {
      chat.removeChild(chat.children[0]);
    }
    // If the latest block alone still overflows the budget, revert so we don't
    // shift chat without benefit (avoids a pi-tui full-screen clear).
    if (chat.render(columns).length > budget) {
      chat.clear();
      for (const child of original) chat.addChild(child);
    }
  }
  // Grow/shrink the filler so the editor + footer sit at the very bottom.
  const used =
    regions.header.render(columns).length +
    regions.chat.render(columns).length +
    regions.status.render(columns).length +
    regions.editor.render(columns).length +
    regions.footer.render(columns).length;
  regions.filler.setLines(Math.max(MIN_GAP, rows - used));
}