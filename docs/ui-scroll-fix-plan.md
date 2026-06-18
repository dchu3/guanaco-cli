# Plan: Fix "entering input clears the screen" UI bug

## Symptom
Any text or command typed into the input box and submitted makes the screen
appear to "clear": the header (Guanaco CLI title + model line) and earlier
chat history vanish from the visible viewport, leaving only the most recent
message(s) and the editor visible.

## Root cause (verified)
The app is driven by `@earendil-works/pi-tui`. Its rendering model is:

- `TUI` renders **all** children top-to-bottom into one growing line buffer
  (`headerContainer` → `chatContainer` → `statusContainer` → `Spacer` →
  `editorContainer`).
- On each render the **visible viewport is the bottom `terminal.rows` lines**
  of that buffer (`previousViewportTop = bufferLength - height` in
  `tui.js` `doRender`). Older content scrolls into the terminal scrollback.
- There is **no pinned header and no bounded/scrollable chat region**: every
  chat message grows the single buffer, so the header and older messages
  scroll out of view as soon as total content exceeds the terminal height.

Evidence gathered while reproducing:

- Driving the real app through a PTY (`script`) and submitting `hello` +
  Enter produces **zero** `\x1b[2J` (clear-screen) / `\x1b[3J` (clear
  scrollback) sequences. So the screen is *not* literally cleared — the
  header is simply scrolled off the top of the viewport.
- Decoding the captured synchronized-output frames after submit shows the
  visible viewport is just:
  ```
  You:
  hello
  Assistant:
  ...
    Thinking...
  ──────── (editor border)
  ──────── (editor border)
  ```
  i.e. the header lines that were rendered at the very first render are gone
  from the visible area.
- A mock-terminal repro confirms the only way `pi-tui` emits a real
  `\x1b[2J` is via `TUI.requestRender(true)` (the `force` path resets
  `previousLines/Width/Height` and triggers `fullRender(true)`). `cli.ts`
  only ever calls `ui.requestRender()` (no force), and the Editor's internal
  `requestRender()` calls are also unforced — so no forced clear is happening
  in practice.

Conclusion: this is a **layout/viewport** bug, not a literal clear-screen bug.
The whole content stack scrolls as one unit, so the header is not pinned and
the chat region is not bounded.

## Fix approach
Pin the header at the top and the editor/status at the bottom by **bounding
the chat region to the available height** between them. Because `pi-tui` has
no built-in scroll-view container, implement a "tail-bounded chat":

- After every chat mutation (add message / stream delta / status change),
  measure the rendered height of each fixed region and trim the **oldest**
  children from `chatContainer` until the total rendered height
  ≤ `terminal.rows`. This keeps the entire layout within one screen, so the
  header stays at the top and the editor stays at the bottom; only the chat
  region scrolls (by dropping its oldest lines).

This is deterministic, uses only public `pi-tui` APIs (`Container.render(width)`
returns the wrapped line count, `TUI.terminal.rows/columns`), and requires no
new dependencies. A proper scrollable-chat component is called out below as a
future enhancement.

## Key files & context
- `src/cli.ts` — the `startCli` function. Owns the container layout
  (`headerContainer`, `chatContainer`, `statusContainer`, `Spacer`,
  `editorContainer`) and the `addMessage` / `addAgentMessage` / `showStatus` /
  `clearStatus` helpers and the harness `onAgentDelta`/`onAgentMessage`
  streaming hooks. All chat mutations go through these helpers, so the trim
  logic can be centralized here.
- `@earendil-works/pi-tui` (`dist/tui.js`, `dist/tui.d.ts`) — `TUI.terminal`
  (public) exposes `rows`/`columns`; `Container.render(width): string[]` gives
  the wrapped line count for any region. No changes to the library.

## Implementation steps
1. **Add a `trimChatToFit()` helper in `src/cli.ts`** (closure over
   `ui`/`headerContainer`/`chatContainer`/`statusContainer`/`editorContainer`):
   - Read `width = ui.terminal.columns`, `rows = ui.terminal.rows`. If
     `rows <= 0` (non-TTY / not yet sized), bail out (no trimming).
   - Compute the fixed-region height:
     `fixed = headerContainer.render(width).length
            + statusContainer.render(width).length
            + 1 /* Spacer */
            + editorContainer.render(width).length`.
   - `budget = max(0, rows - fixed)`.
   - While `chatContainer.children.length > 0` and
     `chatContainer.render(width).length > budget`, remove the oldest child
     (`chatContainer.removeChild(chatContainer.children[0])`).
   - `ui.requestRender()` (unforced — never `true`, to avoid the forced clear).
2. **Call `trimChatToFit()` after every chat mutation**:
   - At the end of `addMessage`.
   - At the end of `addAgentMessage`.
   - In the harness `onAgentDelta`/`onAgentMessage` hooks (after
     `currentMsg.setText(...)` / adding the agent message), because a
     streaming message grows in height as deltas arrive.
   - After `showStatus` and `clearStatus`, since status height changes the
     chat budget.
3. **Guard the empty-input `continue` path**: when `trimmed` is empty the
   loop `continue`s with no mutation — no trim needed (unchanged).
4. **Do not introduce `requestRender(true)` anywhere.** Document, in a
   comment near the helper, that forced renders trigger a full screen clear
   in `pi-tui` and must be avoided for incremental updates.

## Edge cases & decisions
- **Short terminals**: if `budget` is very small (e.g. 2–3 lines), the chat
  keeps only the latest message tail. Acceptable; the header + editor remain
  visible, which is the goal. If `budget` is 0 or negative, keep at least the
  most recent message (don't strip the just-added message): stop trimming once
  only one message block remains even if it overflows.
- **Multi-line editor input**: while typing a multi-line draft the editor
  region grows, shrinking the chat budget; `trimChatToFit` (called on each
  status/chat mutation, not on every keystroke) handles it on the next
  mutation. If desired, an enhancement can call it on editor `onChange` too —
  left out of the initial fix to avoid extra renders per keystroke.
- **`/clear`**: still calls `chatContainer.clear()`; no trim needed.
- **Harness `onSuspend`**: adds a system message then awaits input; the added
  message triggers a trim via `addMessage`. Fine.
- **Markdown wrapping**: `Container.render(width)` already accounts for
  wrapping, so the budget calculation is accurate regardless of message
  length or terminal width.
- **Resize**: `pi-tui` handles resize with its own full redraw; on the next
  chat mutation `trimChatToFit` re-evaluates against the new `rows`. No extra
  resize handler required for the fix (a future nicety).

## Verification & testing
- **Manual (PTY capture)**: drive `dist/index.js` through `script`, submit a
  few messages, and assert the captured synchronized-output frames still
  contain the header line (`Guanaco CLI`) in the visible viewport after
  multiple submits (previously it disappeared). Confirm still **0**
  `\x1b[2J` sequences.
- **Unit test (`tests/cli/viewport.test.ts`, new)**: instantiate `TUI` with a
  `MockTerminal` (implements the `Terminal` interface, `columns`/`rows`
  configurable, `write()` captures output, counts `\x1b[2J`). Reproduce the
  layout from `startCli`'s container structure (or factor the layout+trim
  into a small testable function), add many messages, and assert:
  - the rendered buffer height never exceeds `terminal.rows`;
  - the header text is present in the last `rows` lines after N messages;
  - no `\x1b[2J` is emitted on incremental message adds.
  (This requires the layout/trim logic to be exercisable without real stdin;
  the `Editor` is the only stdin-coupled piece, so the test can build the
  containers + `trimChatToFit` directly, or we refactor those into a
  `createLayout(ui)` helper returning `{ header, chat, status, editor,
  addMessage, addAgentMessage, trimChatToFit }` for testability.)
- **Regression**: `npm run lint`, `npm run build`, `npm test` all stay green.
- **Existing behaviour preserved**: `/help`, `/clear`, `/model`, `!` shell,
  `/feature` harness run, and plain chat still work; streaming deltas still
  render incrementally.

## Future enhancement (out of scope for this fix)
Introduce a real scrollable chat `Component` (or upstream a bounded viewport
in `pi-tui`) so the chat region can scroll with keyboard/PageUp/PageDown
while header and editor stay fixed, preserving full history instead of
dropping the oldest lines. The tail-bound in this fix is the pragmatic
stabilization; the scrollable region is the proper long-term design.