/**
 * Single source of truth for the CLI slash-command catalogue.
 *
 * Used by both the bare-`/` listing and `/help` so the two never drift,
 * and by `tests/commands.test.ts` for unit coverage without a terminal.
 */

export interface CommandSpec {
  /** The literal command token, e.g. `/model`. */
  name: string;
  /** Usage placeholder for arguments, e.g. `<name>`; empty if no args. */
  args: string;
  /** One-line summary shown in the catalogue. */
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: '/log',
    args: '',
    description: 'show the debug log file path and recent entries',
  },
  {
    name: '/help',
    args: '',
    description: 'show this help',
  },
  {
    name: '/clear',
    args: '',
    description: 'clear chat history',
  },
  {
    name: '/model',
    args: '<name>',
    description: 'change chat model',
  },
  {
    name: '/exit',
    args: '',
    description: 'exit the application',
  },
  {
    name: '/quit',
    args: '',
    description: 'alias for /exit',
  },
];

/**
 * Render the catalogue as a Markdown body suitable for `addMessage('system', …)`.
 * Every command name and the `!<command>` shell tip are guaranteed to appear.
 */
export function formatCommandList(): string {
  const lines = ['Available commands:', ''];
  for (const cmd of COMMANDS) {
    const argPart = cmd.args ? ` _${cmd.args}_` : '';
    lines.push(`- **${cmd.name}**${argPart} — ${cmd.description}`);
  }
  lines.push('', 'Tip: type `!<command>` to run a shell command.');
  return lines.join('\n');
}

/**
 * True only for a bare slash with nothing (or whitespace) after it.
 * `''`, `'/'`, `'/   '` → true-ish only for the slash forms; plain text and
 * real commands like `'/help'` return false.
 */
export function isBareSlash(input: string): boolean {
  return input.trim() === '/';
}