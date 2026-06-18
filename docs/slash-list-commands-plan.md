# Plan: `/` alone lists all available commands

## Objective

When the user types just `/` (with no command name) and presses Enter, the CLI
should **display all available slash commands** as a formatted list — the same
catalogue `/help` shows, but reachable from the natural "I forgot the
commands" gesture of submitting a bare slash. This replaces today's unhelpful
`Unknown command: /  (try /help)` message.

All work for this initiative happens on the `feature/slash-list-commands`
branch.

## Goals & Non-Goals

**Goals**
- Submitting `/` (empty after the slash, possibly with trailing whitespace)
  prints the full command catalogue as a system message in the chat region.
- The catalogue is rendered through the existing `Markdown` system-message
  path so it is consistent with `/help` styling (cyan headings, list bullets).
- The command list is driven by a **single source of truth** so `/`, `/help`,
  and the "Unknown command" hint never drift apart.
- Empty/whitespace-only input still no-ops (current behaviour preserved).
- Unknown commands still fall through to the `Unknown command: … (try /help)`
  status line (only a *bare* `/` lists commands).

**Non-Goals (for this iteration)**
- No live autocomplete popup while typing `/` (the `Editor` selectList theme
  exists, but a keystroke-triggered dropdown is a larger change — tracked
  separately if desired).
- No fuzzy matching or argument hints per command (kept to a flat catalogue).
- No restructuring of the chat-vs-harness command dispatch.

## Background / Key Files & Context

- `src/cli.ts` — the interactive pi-tui loop. The relevant block is the
  `if (trimmed.startsWith('/'))` dispatch starting around line 211. Today it
  splits `[cmd, ...args]`, then matches `/exit`, `/quit`, `/clear`, `/model`,
  `/agents`, `/harness-status`, `/feature`, `/help`, else `Unknown command`.
  A bare `/` splits into `cmd === '/'` with no args and falls through to the
  `Unknown command: /` branch.
- `addMessage(role, content)` — renders a `Markdown` system message into
  `chatContainer` and triggers `renderChat()`. Used by `/help` already.
- `showStatus(message)` — renders a single dim line into `statusContainer`.
  Used for transient hints like `Unknown command: …`.
- `tests/` — Vitest suites exist for `ollama`, `mastra/*`, `harness/*`,
  `ui/*`. There is currently no `cli.test.ts`; the input loop is hard to unit
  test because it drives a live `TUI`/`ProcessTerminal`. We will add a small
  **pure helper** module that the command list is extracted into so it is
  unit-testable without a terminal.

## Target Design

### 0. Live slash-menu autocomplete (the primary UX)

Typing `/` pops the Editor's built-in slash dropdown listing every command,
filtered live as you type; Tab/Enter completes the highlighted command. This
is what the user actually wants ("options appear when I press /") and is wired
in `src/cli.ts`:

```ts
import { CombinedAutocompleteProvider, type SlashCommand } from '@earendil-works/pi-tui';
import { COMMANDS } from './commands.js';

const slashCommands: SlashCommand[] = COMMANDS.map((c) => ({
  name: c.name,
  description: c.description,
  ...(c.args ? { argumentHint: c.args } : {}),
}));
editor.setAutocompleteMaxVisible(COMMANDS.length); // show all 8 at once
editor.setAutocompleteProvider(
  new CombinedAutocompleteProvider(slashCommands, process.cwd(), null),
);
```

With a slash prefix open, Enter **completes the highlighted command and
submits it** (standard pi-tui behaviour). To submit a literal bare `/` and get
the list as a chat message, close the dropdown with Escape first.

### 1. Extract a `COMMANDS` catalogue (single source of truth)

Create `src/commands.ts` exporting a typed catalogue:

```ts
export interface CommandSpec {
  name: string;            // e.g. "/feature"
  args: string;            // usage placeholder, e.g. "<prompt>"
  description: string;     // one-line summary
}

export const COMMANDS: CommandSpec[] = [
  { name: '/feature',        args: '<prompt>',          description: 'run the SDLC harness to implement a feature' },
  { name: '/agents',         args: '',                  description: 'list the SDLC agents and their models' },
  { name: '/harness-status', args: '',                  description: 'show the current/last harness run state' },
  { name: '/help',           args: '',                  description: 'show this help' },
  { name: '/clear',          args: '',                  description: 'clear chat history' },
  { name: '/model',          args: '<name>',            description: 'change chat model' },
  { name: '/exit',           args: '',                  description: 'exit the application' },
  { name: '/quit',           args: '',                  description: 'alias for /exit' },
];

export function formatCommandList(): string {
  // Returns the multi-line Markdown body used by both "/" and "/help".
}

/** true only for a bare slash with nothing (or whitespace) after it */
export function isBareSlash(input: string): boolean {
  return input.trim() === '/';
}
```

`formatCommandList()` produces something like:

```
Available commands:

- **/feature** _<prompt>_ — run the SDLC harness to implement a feature
- **/agents** — list the SDLC agents and their models
- **/harness-status** — show the current/last harness run state
- **/help** — show this help
- **/clear** — clear chat history
- **/model** _<name>_ — change chat model
- **/exit** — exit the application
- **/quit** — alias for /exit

Tip: type `!<command>` to run a shell command.
```

### 2. Wire `/` into the dispatch (`src/cli.ts`)

Inside the existing `if (trimmed.startsWith('/'))` block, **before** the
per-command `if/else` chain, add:

```ts
const [cmd, ...args] = trimmed.split(' ');
const rest = trimmed.slice(cmd.length).trim();

if (isBareSlash(trimmed)) {
  addMessage('system', formatCommandList());
  continue;
}
```

Then refactor the existing `/help` branch to reuse the same helper:

```ts
} else if (cmd === '/help') {
  addMessage('system', formatCommandList());
  continue;
}
```

so both paths render identical content from `COMMANDS`.

### 3. Preserve existing behaviour

- Empty input (`!trimmed`) → `continue` (unchanged).
- `!<command>` shell path → unchanged.
- Unknown slash command (e.g. `/nope`) → still hits the
  `showStatus(\`Unknown command: ${cmd}  (try /help)\`)` branch, because a
  non-bare unknown command is not intercepted by the new `isBareSlash` guard.

### 4. Tests (`tests/commands.test.ts`)

New Vitest file exercising the pure helper — no terminal needed:

- `COMMANDS` contains the expected names (snapshot of the catalogue).
- `formatCommandList()` includes every command name and the `!<command>` tip.
- `isBareSlash('/')` → `true`.
- `isBareSlash('/ ')` → `true` (trailing spaces).
- `isBareSlash('/help')` → `false`.
- `isBareSlash('')` → `false`.
- `isBareSlash('hello')` → `false`.

## Implementation Steps

0. `git checkout -b feature/slash-list-commands` *(done — this branch).*
1. Add `src/commands.ts` with `CommandSpec`, `COMMANDS`, `formatCommandList`,
   `isBareSlash`.
2. Edit `src/cli.ts`:
   - import the new helpers + `CombinedAutocompleteProvider`/`SlashCommand`;
   - wire the live slash-menu autocomplete provider onto the editor (step 0);
   - add the bare-`/` guard at the top of the slash dispatch;
   - rewrite the `/help` branch to call `formatCommandList()`.
3. Fix `npm run dev` refresh: `tsx watch` intercepts Enter as a manual restart
   trigger (`[tsx] Return key Restarting...`), so every submit restarted the
   app and cleared the screen. Drop `watch` from `dev`; keep a separate
   `dev:watch` script with `--clear-screen=false` for file-reload (caveat:
   Enter still restarts in watch mode).
4. Add `tests/commands.test.ts` and extend `tests/ui/cli-viewport.test.ts`
   with dropdown-render + no-full-clear tests; run `npm test`.
5. `npm run lint` and `npm run build` (tsc) to confirm no regressions.
6. PTY smoke test (`script`) of both `npm run dev` and `npm start`: type `/` →
   dropdown shows all 8 commands; `grep -c $'\x1b[2J'` stays 0 across the session.
7. Commit + push the branch; open a PR for review.

## Risks & Notes

- **Drift risk** is the main thing this plan fixes: today `/help` hard-codes
  its list inline while the dispatch chain hard-codes the accepted commands
  separately. Centralising in `COMMANDS` removes the duplicate list; the
  dispatch chain itself stays as-is for now (it could later be generated from
  `COMMANDS`, but that risks losing the per-command arg-parsing logic, so it
  is left as a follow-up).
- The bare-`/` list is emitted as a **system chat message** (not a transient
  status line) so it stays in scrollback for reference — matching `/help`.
- No layout/render changes: we reuse `addMessage('system', …)`, so the
  `trimChatToFit` + differential-render guardrails documented in
  `docs/ui-typing-refresh-fix-plan.md` and `docs/ui-scroll-fix-plan.md` are
  not affected.