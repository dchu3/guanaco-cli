import type { Container } from '@earendil-works/pi-tui';

/**
 * The four stacked regions of the CLI layout, in top-to-bottom order:
 *   header → chat → status → (Spacer) → editor
 *
 * `trimChatToFit` keeps the total rendered height within the terminal by
 * dropping the oldest chat children, so the header stays pinned at the top
 * and the editor stays pinned at the bottom (only the chat region scrolls).
 */
export interface ChatRegions {
  header: Container;
  chat: Container;
  status: Container;
  editor: Container;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Height of the fixed (non-chat) regions, including the 1-line Spacer. */
export function fixedHeight(regions: ChatRegions, columns: number): number {
  return (
    regions.header.render(columns).length +
    regions.status.render(columns).length +
    1 + // Spacer between status and editor
    regions.editor.render(columns).length
  );
}

/**
 * Trim the oldest children from the chat container until the chat fits within
 * `rows - fixedHeight`, so the whole layout stays within one screen.
 *
 * - No-op when the terminal size is unknown (non-TTY / not yet sized).
 * - Never strips below a single message block (Spacer + message), even if that
 *   one block overflows the budget — so very short terminals may still scroll
 *   the header, but typical terminals keep the header pinned.
 *
 * Pure: reads container state via `Container.render(width)` and mutates only
 * `chat` (removeChild). Does not touch the TUI or call requestRender.
 */
export function trimChatToFit(regions: ChatRegions, size: TerminalSize): void {
  const { columns, rows } = size;
  if (!Number.isFinite(columns) || columns <= 0 || !Number.isFinite(rows) || rows <= 0) {
    return;
  }
  const { chat } = regions;
  const budget = Math.max(0, rows - fixedHeight(regions, columns));
  // Keep at least one message block (Spacer + message = 2 children).
  while (chat.children.length > 2 && chat.render(columns).length > budget) {
    chat.removeChild(chat.children[0]);
  }
}

/**
 * Total rendered height of the full layout (all regions + the Spacer).
 * Useful for tests/assertions.
 */
export function totalHeight(regions: ChatRegions, columns: number): number {
  return (
    regions.header.render(columns).length +
    regions.chat.render(columns).length +
    regions.status.render(columns).length +
    1 + // Spacer
    regions.editor.render(columns).length
  );
}