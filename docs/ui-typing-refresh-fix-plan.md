# Plan: Fix "screen refreshes when I type" (typing `/` or >2 chars)

## Symptom (latest report)
After the previous fixes, entering input still causes a visible **screen
refresh/flicker** — specifically when typing a `/` or more than ~2 characters.

## Diagnosis so far
Reproducing in a sandbox PTY + real `Editor` shows **0 `\x1b[2J` (clear-screen)
sequences and only one `fullRender` (first paint)** while typing — i.e. in this
environment typing is smooth 1-line differential updates. `PI_DEBUG_REDRAW`
confirms a single `fullRender: first render`. So the trigger is
**environment/content-dependent** and we need the user's actual redraw log to
confirm (step 1 below).

The mechanism that *does* cause a full-screen clear in `pi-tui` (read in
`node_modules/@earendil-works/pi-tui/dist/tui.js`, `doRender`) is:

```js
if (firstChanged < prevViewportTop) { fullRender(true); return; }   // full clear
```

`prevViewportTop = max(0, bufferLength - height)`. It is `0` only while the
whole layout fits in one screen (`bufferLength ≤ rows`). Once chat content
**overflows** `rows` (long chats, or short terminals where header+editor alone
exceed `rows`), `prevViewportTop > 0` and the visible viewport is the *bottom*
`rows` lines. Any change **above** the viewport then forces `fullRender(true)`
= a full screen clear.

The previous fix added `editor.onChange → trimChatToFit(...)`. Trimming
**removes the oldest chat child**, which shifts all remaining chat up — i.e. a
change at the *top* of the buffer (above the viewport when overflowing). So
once chat overflows `rows`, **each keystroke that triggers a trim** can hit
`firstChanged < prevViewportTop` → `fullRender(true)` → the visible "refresh".
This also explains why it appears once there is enough on screen (the "/"
/ ">2 chars" is just the point at which the user notices it / the editor line
activity crosses the trim threshold).

Two secondary full-render triggers also exist and should be eliminated
defensively:
- `clearOnShrink` branch (`newLines.length < maxLinesRendered`) → `fullRender(true)`
  (default off, but env/version-dependent).
- `requestRender(true)` (the only code path that resets `previousLines/Width/Height`
  to `-1` and forces a clear) — `cli.ts` never calls it; must stay that way.

## Goal
**No full-screen refresh/flicker while typing**, and a single clean update on
submit. We prioritise "no refresh" over "header always pinned on every
terminal size": on very short terminals the header may scroll during a long
typed draft, but it will not flicker, and on normal terminals (≥ ~12 rows) the
header stays pinned.

## Fix (src/cli.ts + src/ui/layout.ts)

### 1. Stop trimming on every keystroke (primary fix)
Remove the `editor.onChange = () => trimChatToFit(...)` hook. Typing only
changes the editor (which sits at the *bottom* of the buffer, i.e. inside the
visible viewport), so it renders as a small differential update with no
full-render. Chat is not mutated while typing, so there is no above-viewport
shift → `firstChanged < prevViewportTop` never fires while typing.

Keep trimming only on **discrete chat mutations** (the existing `renderChat()`
path: `addMessage`, `addAgentMessage`, `showStatus`, `clearStatus`, streaming
`setText`, `/clear`, harness hooks). Submit is a deliberate action; a single
update there is acceptable and, with the guard in step 2, won't be a full clear.

### 2. Make `trimChatToFit` only trim when it keeps the layout within `rows`
In `src/ui/layout.ts`, change the trim so it never produces a state where
`bufferLength > rows` *as a result of trimming* (which would push
`prevViewportTop > 0` and risk a full-render on the next change). Concretely:

- Compute `budget = rows - fixedHeight` as today.
- **Skip trimming entirely when `budget < 2`** (a minimal message block is
  `Spacer(1) + 1 line = 2`): on very short terminals where even one block can't
  fit, trimming can't help, so don't shift chat (avoids the full-render). The
  header may scroll there; that's the documented tradeoff.
- Otherwise trim while `chat.render(columns).length > budget` and
  `children.length > 2`, as today — but add a final check: if after trimming to
  one block `totalHeight(regions) > rows`, **revert** by not having trimmed
  (i.e. only trim when the result actually fits). Practically, with `budget ≥ 2`
  and normal-sized messages, trimming to the tail keeps `total ≤ rows`, so
  `prevViewportTop` stays `0` and no full-render is possible.

This guarantees: whenever we trim, `bufferLength ≤ rows` → `prevViewportTop = 0`
→ the `firstChanged < prevViewportTop` branch (which requires
`prevViewportTop > 0`) can never fire on a trim.

### 3. Disable `clearOnShrink` explicitly
Call `ui.setClearOnShrink(false)` once after constructing the `TUI` (in
`startCli`). This eliminates the `clearOnShrink` full-render path regardless of
env/`PI_CLEAR_ON_SHRINK`/pi-tui version. (We never want the screen to blank
because content shrank — e.g. when a message is replaced or the editor clears.)

### 4. Never force a render
Keep the existing rule: all incremental updates use `ui.requestRender()` (no
`force`). Add a comment reiterating that `requestRender(true)` triggers a full
`\x1b[2J` clear and must never be used for updates.

## Key files & context
- `src/cli.ts` — `startCli`: remove the `editor.onChange` trim hook; add
  `ui.setClearOnShrink(false)`; keep `renderChat()` for discrete mutations.
- `src/ui/layout.ts` — `trimChatToFit`: add the `budget < 2` skip + "only trim
  if result fits" guard; keep `fixedHeight`/`totalHeight` helpers.
- `@earendil-works/pi-tui` (`dist/tui.js` `doRender`) — no changes; referenced
  for the `firstChanged < prevViewportTop` and `clearOnShrink` behaviour.

## Tests (`tests/ui/`)
- Extend `cli-viewport.test.ts`:
  - **Short terminal, typing does not full-render**: `rows = 8` (header+editor
    already ≥ rows), pre-fill chat to overflow, simulate typing a long wrapping
    input (`editor.setText(long)` + `ui.requestRender()`), assert
    `term.clears === 0` (no `\x1b[2J`) and the buffer is not cleared.
    (Currently this passes at `rows=24`; the new test covers the overflow case.)
  - **`setClearOnShrink(false)` holds**: trigger a shrink (replace a tall
    message with a short one via `setText`) and assert `term.clears === 0`.
  - **`trimChatToFit` skips on `budget < 2`**: build regions with `rows` so small
    that `budget < 2`, add messages, call `trimChatToFit`, assert chat children
    are unchanged (no shift).
- Keep the existing 24-row typing + submit tests green.

## Verification
1. **User-side diagnosis (do first)**: run with `PI_DEBUG_REDRAW=1` (e.g.
   `PI_DEBUG_REDRAW=1 npm run dev`), reproduce the refresh, and share
   `~/.pi/agent/pi-debug.log`. Each `fullRender:` line gives the exact reason
   (`firstChanged < viewportTop`, `clearOnShrink`, `heightChanged`,
   `terminal width changed`). This confirms which branch fires before/after
   the fix.
2. `npm run lint`, `npm run build`, `npm test` all green; existing 54 tests pass.
3. Manual PTY drive (`script`/`pty`) typing `/`, long lines, and submitting;
   assert `grep -c $'\x1b[2J'` stays `0` across the whole session and
   `pi-debug.log` shows only the first-render `fullRender`.

## Rollout
Single commit on `feature/mastra-sdlc-harness`:
`fix(ui): stop per-keystroke chat trim + disable clearOnShrink to prevent typing refresh`.

## Future (out of scope)
A proper scrollable chat `Component` (or upstream `pi-tui` viewport) that pins
header + editor and scrolls chat internally with keyboard navigation, preserving
full history — eliminating both the header-scroll and the trim entirely. The
`showOverlay`-pinned-header idea was tested and does **not** work: pi-tui's
differential renderer doesn't re-composite the overlay after a terminal scroll,
so the header still scrolls off. Noted here to avoid re-attempting it.