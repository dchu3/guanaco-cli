# Plan: Spinner, PWD/git footer, and pinning the input box to the bottom

## Goals (from the request)
1. **Working spinner** while agents are processing (instead of the static
   `Thinking…` text).
2. **Present-working-directory + git branch** shown **below** the input text
   box.
3. **Pin the input box near the bottom of the screen** — it currently drifts
   up and down as chat/status grow and shrink, which is distracting.
4. All work on a **new branch** (`feature/ui-spinner-pwd-pin-editor`).

---

## Root cause of the drifting input box

`@earendil-works/pi-tui` renders **all** children top-to-bottom into one
growing line buffer and shows the **bottom `terminal.rows` lines** as the
viewport (`tui.js` `doRender`: `bufferLength = Math.max(height, newLines.length)`
→ `previousViewportTop = bufferLength - height`). When the total content is
**shorter** than the terminal, the buffer is padded with empty lines **below**
the content, so the editor sits right after the last chat line (mid-screen)
with blank space beneath it. As chat grows / status appears / status clears,
the editor hops up and down.

`trimChatToFit` (added by the earlier scroll fix) only **trims** chat once it
overflows the screen — it does nothing to fill the gap when chat is **shorter**
than the screen, so the editor is only pinned at the bottom once content fills
the viewport.

## Fix: a flex spacer that pins the editor to the bottom

Insert a **dynamic `Spacer`** (the "filler") between the `status` region and
the `editor` region. On every layout pass, size it to
`rows - (header + chat + status + editor + footer)` (minimum 1 line). This
makes the total buffer **always equal `rows`**, so:

- The header stays pinned at the top.
- The `editor` + `footer` stay pinned at the bottom.
- Only the `chat` region scrolls (oldest lines dropped when it overflows).

The status region (which holds the spinner) therefore sits **just above the
input box**, and the editor no longer moves when chat/status resize — the
filler absorbs the difference.

### New region order (top → bottom)
```
header → chat → status → filler(flex) → editor → footer
```
(`footer` is the new PWD + git-branch line below the input box.)

---

## Changes by file

### `src/ui/layout.ts` (rewrite of the layout helpers)
- `ChatRegions` gains two members: `filler: Spacer` and `footer: Container`.
- `fixedHeight` now = `header + status + editor + footer + MIN_GAP` (the
  minimum 1-line gap the filler always keeps between status and editor).
- Rename `trimChatToFit` → **`layoutToFit`**. It now:
  1. Computes `budget = rows - fixedHeight`.
  2. Trims oldest chat children down to `budget` (same revert-on-overflow
     safety as before: if even the latest block overflows, revert so chat is
     not shifted — avoids pi-tui's `firstChanged < prevViewportTop` full-clear).
  3. **Sets `filler.setLines(max(MIN_GAP, rows - used))`** where `used` is the
     sum of every region's rendered height except the filler. This is the new
     pinning step.
- `totalHeight` includes the filler + footer.
- A `MIN_GAP = 1` constant reserves the visual gap.

### `src/cli.ts`
- **Layout**: build the new children in order
  `header → chat → status → filler → editor → footer`. Replace the old fixed
  `new Spacer(1)` with the dynamic `filler` spacer.
- **Spinner**: import `Loader` from `@earendil-works/pi-tui`. Create one
  reusable `Loader` (stopped on construction). Add `startSpinner(message)` /
  `stopSpinner()` helpers:
  - `startSpinner`: clear `statusContainer`, add the loader, set its message,
    `loader.start()` (begins the 80ms frame animation; the loader calls
    `ui.requestRender()` itself each tick).
  - `stopSpinner`: `loader.stop()` (clears the interval) and clear
    `statusContainer`.
  - `renderChat` now calls `layoutToFit` (so the filler absorbs the spinner's
    1-2 line height and the editor never shifts when the spinner
    appears/disappears).
  - Replace the static `showStatus('Thinking…')` in the plain-chat path with
    `startSpinner('Thinking…')`; call `stopSpinner()` when the response
    completes/errors.
  - In the harness `onStep` hook use `startSpinner(\`${phase==='start'?'▶':'✔'} ${STEP_LABEL[step]}\`)`;
    `onSuspend` keeps a static `showStatus` (it's awaiting input, not
    processing); `stopSpinner()` in the harness `finally`.
  - Static `showStatus` is retained for non-processing messages (model
    switched, usage hints, "Input cleared — press Ctrl+C again to quit.",
    shell `Executing: …`).
- **Footer (PWD + git branch)**:
  - `renderFooter()` builds a dim single line:
    `📁 <shortened cwd>  ·  🌿 <branch>` (branch omitted when not in a repo).
  - `refreshFooter()` sets the PWD-only line synchronously, then `await`s a
    `git rev-parse --abbrev-ref HEAD` (via the already-promisified
    `execAsync`, independent of `gitOps`/harness config so it works even
    without the harness), updates the line, and calls `renderChat()`.
  - `process.cwd()` shortened with `os.homedir()` → `~`.
  - Called on startup (right after `ui.start()`) and after every harness run
    (branch may change via `createBranchAndCommit`) and after `/clear`
    (cheap; keeps it fresh).
- **Resize safety**: register an input listener that compares
  `ui.terminal.rows/columns` to the last seen size and calls `renderChat()`
  (→ `layoutToFit`) when they change, so a resize while idle re-pins the
  editor on the next keystroke.
- `quit()` also stops the spinner (clean teardown).

### `tests/ui/layout.test.ts` & `tests/ui/cli-viewport.test.ts`
- Update `ChatRegions` construction to include `filler: new Spacer(1)` and
  `footer: new Container()`.
- Replace `trimChatToFit` calls with `layoutToFit`.
- Existing assertions still hold:
  - `totalHeight <= rows` after fills.
  - header pinned in viewport, editor visible, 0 `\x1b[2J` clears.
  - no per-keystroke full-render while typing.
  - budget < 2 still skips trimming (and now just sets the filler).
  - latest-overflow still reverts (chat unshifted).
- Add a new test: **editor is pinned at the bottom when chat is shorter than
  the screen** — i.e. the filler fills the gap so the editor's lines are the
  last rendered lines of the buffer (before the footer), not floating
  mid-screen.
- Add a new test: **filler shrinks to MIN_GAP when chat overflows** and the
  layout still totals exactly `rows`.

---

## Edge cases & decisions
- **Spinner render height**: `Loader.render` prepends a blank line, so the
  status region is 2 lines while spinning and 1 line for static `showStatus`.
  `layoutToFit` reads `status.render(columns).length`, so the budget and
  filler always account for it — the editor stays pinned either way.
- **Spinner ticks**: the loader's 80ms `setInterval` calls
  `ui.requestRender()` (unforced) — a differential update, never a
  `\x1b[2J` clear. We never call `ui.requestRender(true)` anywhere.
- **Footer before branch resolves**: the footer shows PWD-only for the first
  render, then flips to PWD + branch once `git rev-parse` resolves; the
  follow-up `renderChat()` re-pins via the filler.
- **Not a git repo**: `git rev-parse` fails → footer shows PWD only (no `· 🌿`).
- **Short terminals**: `budget < 2` skips trimming (unchanged behaviour); the
  filler still gets sized so the editor stays at the bottom even on a 6-row
  terminal.
- **`/clear`**: clears chat; `refreshFooter()` + `renderChat()` re-pin.
- **No new dependencies**: uses `Loader`, `Spacer`, `Container`, `Text` from
  the already-pinned `@earendil-works/pi-tui`, plus Node `child_process` /
  `os` / `path`.

## Verification
- `npm run build`, `npm run lint`, `npm test` all green.
- Manual: run the CLI, confirm the spinner animates while the assistant /
  harness works and stops on completion; confirm the PWD + branch line shows
  below the input box and updates after a `/feature` run creates a branch;
  confirm the input box stays at the bottom while chat grows and while the
  spinner appears/disappears (no vertical drift).