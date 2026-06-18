import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CombinedAutocompleteProvider, isKeyRelease, matchesKey, type SlashCommand } from '@earendil-works/pi-tui';
import {
  TUI,
  ProcessTerminal,
  Container,
  Loader,
  Markdown,
  Editor,
  Text,
  Spacer,
  type MarkdownTheme,
  type EditorTheme,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { OllamaClient } from './ollama.js';
import type { ToolRegistry } from './tools.js';
import type { HarnessConfig, SdlcRole } from './config.js';
import type { SdlcAgents } from './mastra/agents.js';
import { DEFAULT_ROLE_MODELS } from './mastra/models.js';
import { HarnessRunner } from './harness/runner.js';
import type { GitOps } from './harness/git.js';
import type { HarnessHooks, HarnessStep } from './harness/types.js';
import { layoutToFit, type ChatRegions } from './ui/layout.js';
import { COMMANDS, formatCommandList, isBareSlash } from './commands.js';

export interface CliDeps {
  ollama: OllamaClient;
  tools: ToolRegistry;
  streamEnabled: boolean;
  harnessAgents?: SdlcAgents;
  harnessConfig?: HarnessConfig;
  gitOps?: GitOps;
}

const MARKDOWN_THEME: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue.underline(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic.dim(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

const EDITOR_THEME: EditorTheme = {
  borderColor: (text: string) => chalk.dim(text),
  selectList: {
    selectedPrefix: (_text: string) => chalk.cyan('→ '),
    selectedText: (text: string) => chalk.cyan(text),
    description: (text: string) => chalk.dim(text),
    scrollInfo: (text: string) => chalk.dim(text),
    noMatch: (text: string) => chalk.red(text),
  },
};

const AGENT_LABEL: Record<SdlcRole, string> = {
  orchestrator: 'Orchestrator',
  product: 'Product',
  architect: 'Architect',
  coder: 'Coder',
  reviewer: 'Reviewer',
  tester: 'Tester',
};

const STEP_LABEL: Record<HarnessStep, string> = {
  intake: 'Intake',
  requirements: 'Requirements',
  design: 'Design',
  implement: 'Implement',
  review: 'Review',
  test: 'Test',
  finalize: 'Finalize',
};

const execAsync = promisify(exec);

export async function startCli(deps: CliDeps): Promise<void> {
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  // Never blank the screen because content shrank (e.g. a message replaced or
  // the editor cleared). pi-tui's `clearOnShrink` path issues a full-screen
  // clear (\x1b[2J); we want only differential updates.
  ui.setClearOnShrink(false);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const fillerSpacer = new Spacer(1); // flex gap sized by layoutToFit
  const editorContainer = new Container();
  const footerContainer = new Container();

  // Top-to-bottom: header → chat → status → filler(flex) → editor → footer.
  // The filler grows to fill leftover rows so the editor + footer stay pinned
  // at the bottom of the screen (the input box no longer drifts as chat /
  // status resize). The footer shows the PWD + git branch below the input box.
  ui.addChild(headerContainer);
  ui.addChild(chatContainer);
  ui.addChild(statusContainer);
  ui.addChild(fillerSpacer);
  ui.addChild(editorContainer);
  ui.addChild(footerContainer);

  const editor = new Editor(ui, EDITOR_THEME, { paddingX: 1 });
  editorContainer.addChild(editor);
  ui.setFocus(editor);

  // Animated spinner shown in the status region while the assistant / harness
  // is processing. The Loader drives its own 80ms frame animation and calls
  // `ui.requestRender()` each tick (an unforced differential update — never a
  // \x1b[2J clear). It's stopped on construction and started on demand by
  // `startSpinner`; removed from the status container when idle.
  const spinner = new Loader(ui, chalk.cyan, chalk.dim, 'Working…');
  spinner.stop();

  // Power the Editor's built-in slash menu: typing `/` pops a dropdown of all
  // commands (filtered as you type, Tab/Enter completes). Built from the same
  // `COMMANDS` catalogue as `/help` and the bare-`/` listing so they never
  // drift. `basePath` enables the @-path file completions too. Show the whole
  // catalogue at once (only 8 commands) instead of paginating 5-up.
  //
  // NOTE: CombinedAutocompleteProvider expects slash-command names WITHOUT the
  // leading '/' — it prepends the '/' itself in applyCompletion()
  // (`${beforePrefix}/${item.value} `). Passing '/feature' would complete to
  // '//feature'. `COMMANDS` keeps the '/' for dispatch/display, so strip it here.
  const slashCommands: SlashCommand[] = COMMANDS.map((c) => ({
    name: c.name.slice(1),
    description: c.description,
    ...(c.args ? { argumentHint: c.args } : {}),
  }));
  editor.setAutocompleteMaxVisible(COMMANDS.length);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, process.cwd(), null),
  );

  ui.addInputListener(
    createCtrlCHandler({
      editor,
      ui,
      showStatus,
      quit: () => {
        spinner.stop();
        ui.stop();
        process.exit(0);
      },
    }),
  );

  // The stacked regions. `layoutToFit` trims the chat region when it overflows
  // and sizes the filler spacer so the whole layout always fills the terminal
  // — header pinned at the top, editor + footer pinned at the bottom, only chat
  // scrolls. This fixes the "entering input clears the screen" symptom (the
  // whole layout scrolling as one unit) AND the input box drifting up and down
  // as chat/status resize (the filler now absorbs the difference).
  const regions: ChatRegions = {
    header: headerContainer,
    chat: chatContainer,
    status: statusContainer,
    filler: fillerSpacer,
    editor: editorContainer,
    footer: footerContainer,
  };

  // Trim oldest chat children to fit, then size the filler so the whole
  // layout exactly fills the terminal (header pinned top, editor + footer
  // pinned bottom). IMPORTANT: never call ui.requestRender(true) here —
  // the forced path in pi-tui issues a full screen clear (\x1b[2J), which is
  // exactly the flicker we are avoiding.
  //
  // Called on discrete chat mutations (add message, status change, streaming
  // setText, /clear, harness hooks, footer refresh) — never on every
  // keystroke. While typing, only the editor changes (it sits inside the
  // visible viewport at the bottom), so it renders as a small differential
  // update with no full-render. Trimming/filler-sizing on each keystroke would
  // shift chat from above the viewport once content overflows `rows`,
  // triggering pi-tui's `firstChanged < prevViewportTop` → fullRender(true)
  // full-screen clear — the "screen refreshes when I type" symptom.
  function renderChat(): void {
    layoutToFit(regions, { columns: ui.terminal.columns, rows: ui.terminal.rows });
    ui.requestRender();
  }

  let activeRunner: HarnessRunner | undefined;

  function renderHeader(): void {
    headerContainer.clear();
    headerContainer.addChild(new Spacer(1));
    headerContainer.addChild(new Text(chalk.bold.cyan('Guanaco CLI 🦙  ·  SDLC harness'), 1, 0));
    const provider = deps.harnessConfig?.provider ?? 'local';
    headerContainer.addChild(
      new Text(
        chalk.dim(`Model: ${deps.ollama.currentModel}  ·  chat provider: ${provider}`),
        1,
        0,
      ),
    );
    headerContainer.addChild(new Spacer(1));
    renderChat();
  }
  renderHeader();

  function addMessage(role: string, content: string): Markdown {
    let prefix = '';
    if (role === 'user') {
      prefix = chalk.bold.green('You: ');
    } else if (role === 'assistant') {
      prefix = chalk.bold.cyan('Assistant: ');
    } else {
      prefix = chalk.bold.yellow('System: ');
    }
    chatContainer.addChild(new Spacer(1));
    const msg = new Markdown(`${prefix}\n${content}`, 1, 0, MARKDOWN_THEME);
    chatContainer.addChild(msg);
    renderChat();
    return msg;
  }

  function addAgentMessage(role: SdlcRole, content: string): Markdown {
    chatContainer.addChild(new Spacer(1));
    const msg = new Markdown(
      `${chalk.bold.magenta(`[${AGENT_LABEL[role]}]`)}\n${content}`,
      1,
      0,
      MARKDOWN_THEME,
    );
    chatContainer.addChild(msg);
    renderChat();
    return msg;
  }

  function showStatus(message: string): void {
    statusContainer.clear();
    statusContainer.addChild(new Text(chalk.dim(`${message}`), 1, 0));
    renderChat();
  }

  function clearStatus(): void {
    statusContainer.clear();
    renderChat();
  }

  /** Show an animated spinner in the status region while work is in flight. */
  function startSpinner(message: string): void {
    statusContainer.clear();
    spinner.setMessage(message);
    statusContainer.addChild(spinner);
    spinner.start();
    renderChat();
  }

  /** Stop the spinner and clear the status region. */
  function stopSpinner(): void {
    spinner.stop();
    statusContainer.clear();
    renderChat();
  }

  /** Shorten an absolute path by collapsing the home directory to `~`. */
  function shortenPath(cwd: string): string {
    const home = homedir();
    if (home && (cwd === home || cwd.startsWith(home + path.sep))) {
      return '~' + cwd.slice(home.length);
    }
    return cwd;
  }

  /** Render the footer line (PWD · git branch) below the input box, with a
   * blank line of padding underneath so it doesn't sit flush against the
   * terminal bottom edge. */
  function setFooterLine(branch?: string): void {
    const cwd = shortenPath(process.cwd());
    const line =
      branch !== undefined && branch.length > 0
        ? `${chalk.dim('📁')} ${chalk.dim(cwd)}  ${chalk.dim('·  🌿 ' + branch)}`
        : `${chalk.dim('📁')} ${chalk.dim(cwd)}`;
    footerContainer.clear();
    footerContainer.addChild(new Text(line, 1, 0));
    footerContainer.addChild(new Spacer(1)); // padding underneath
  }

  /**
   * Refresh the footer: paint the PWD synchronously, then resolve the current
   * git branch (independent of the harness `gitOps`, so it works without the
   * harness configured) and update the line. Branch may change after a
   * `/feature` run creates one, so call after harness runs and on startup.
   */
  async function refreshFooter(): Promise<void> {
    setFooterLine();
    renderChat();
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() });
      setFooterLine(stdout.trim());
      renderChat();
    } catch {
      // Not a git repo (or git unavailable) — leave the PWD-only footer.
    }
  }

  function nextInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      editor.onSubmit = (text) => {
        editor.onSubmit = undefined;
        resolve(text);
      };
    });
  }

  ui.start();

  // Re-pin the layout on terminal resize while idle: pi-tui handles its own
  // redraw on resize but does not re-invoke our filler sizing, so without this
  // the editor would drift after a resize until the next chat mutation. The
  // listener is called on every keystroke, so it only re-layouts when the size
  // actually changed (cheap compare of two numbers).
  let lastCols = ui.terminal.columns;
  let lastRows = ui.terminal.rows;
  ui.addInputListener(() => {
    if (ui.terminal.columns !== lastCols || ui.terminal.rows !== lastRows) {
      lastCols = ui.terminal.columns;
      lastRows = ui.terminal.rows;
      renderChat();
    }
    return undefined;
  });

  // Initial footer (PWD + git branch) below the input box.
  void refreshFooter();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await nextInput();
    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const [cmd, ...args] = trimmed.split(' ');
      const rest = trimmed.slice(cmd.length).trim();

      if (isBareSlash(trimmed)) {
        addMessage('system', formatCommandList());
        continue;
      }

      if (cmd === '/exit' || cmd === '/quit') {
        ui.stop();
        process.exit(0);
      } else if (cmd === '/clear') {
        chatContainer.clear();
        renderChat();
        void refreshFooter();
        continue;
      } else if (cmd === '/model') {
        const modelName = args[0];
        if (modelName) {
          deps.ollama.setModel(modelName);
          renderHeader();
          showStatus(`Switched to model: ${modelName}`);
        } else {
          showStatus('Usage: /model <name>');
        }
        continue;
      } else if (cmd === '/agents') {
        listAgents();
        continue;
      } else if (cmd === '/harness-status') {
        harnessStatus();
        continue;
      } else if (cmd === '/feature') {
        if (!rest) {
          showStatus('Usage: /feature <description of the feature to implement>');
          continue;
        }
        await runHarness(rest);
        continue;
      } else if (cmd === '/help') {
        addMessage('system', formatCommandList());
        continue;
      } else {
        showStatus(`Unknown command: ${cmd}  (try /help)`);
        continue;
      }
    }

    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim();
      if (command) {
        addMessage('user', trimmed);
        showStatus(`Executing: ${command}`);
        try {
          const { stdout, stderr } = await execAsync(command);
          if (stdout) addMessage('system', stdout.trim());
          if (stderr) addMessage('system', chalk.yellow(stderr.trim()));
        } catch (err: unknown) {
          const execError = err as { stdout?: string; stderr?: string; message?: string };
          if (execError.stdout) addMessage('system', execError.stdout.trim());
          if (execError.stderr) addMessage('system', chalk.yellow(execError.stderr.trim()));
          addMessage(
            'system',
            chalk.red(`Error executing command: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
        clearStatus();
        continue;
      }
    }

    // Default: legacy single-agent chat via the OllamaClient.
    addMessage('user', trimmed);
    const assistantMsg = addMessage('assistant', '...');
    let fullResponse = '';

    try {
      startSpinner('Thinking…');
      const response = await deps.ollama.chat([{ role: 'user', content: trimmed }], {
        onAssistantDelta: (chunk) => {
          fullResponse += chunk;
          assistantMsg.setText(`${chalk.bold.cyan('Assistant: ')}\n${fullResponse}`);
          renderChat();
        },
      });

      if (!deps.streamEnabled) {
        assistantMsg.setText(`${chalk.bold.cyan('Assistant: ')}\n${response}`);
        renderChat();
      }
      stopSpinner();
    } catch (err) {
      stopSpinner();
      statusContainer.addChild(
        new Text(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`), 1, 0),
      );
      renderChat();
    }
  }

  function listAgents(): void {
    if (!deps.harnessConfig || !deps.harnessAgents) {
      addMessage('system', 'Harness not configured.');
      return;
    }
    const cfg = deps.harnessConfig;
    const lines = ['SDLC agents:', ''];
    (Object.keys(DEFAULT_ROLE_MODELS) as SdlcRole[]).forEach((role) => {
      const model = cfg.roleModels[role] ?? DEFAULT_ROLE_MODELS[role];
      lines.push(`- ${AGENT_LABEL[role]}  ·  ${model}  ·  ${cfg.provider}`);
    });
    lines.push('', `Provider: ${cfg.provider}  ·  Repo: ${cfg.repoRoot}`);
    addMessage('system', lines.join('\n'));
  }

  function harnessStatus(): void {
    if (!activeRunner) {
      addMessage('system', 'No harness run yet. Start one with /feature <prompt>.');
      return;
    }
    const s = activeRunner.status();
    addMessage(
      'system',
      [
        `Step: ${STEP_LABEL[s.step]}`,
        `Review attempts: ${s.reviewAttempts}`,
        `Test attempts: ${s.testAttempts}`,
        `Reviewer verdict: ${s.lastReviewerVerdict ?? '—'}`,
        `Tester verdict: ${s.lastTesterVerdict ?? '—'}`,
        `Turns logged: ${s.log.length}`,
      ].join('\n'),
    );
  }

  async function runHarness(prompt: string): Promise<void> {
    if (!deps.harnessAgents || !deps.harnessConfig || !deps.gitOps) {
      addMessage('system', 'Harness not configured (agents/config/git missing).');
      return;
    }

    addMessage('user', `/feature ${prompt}`);
    startSpinner('Starting SDLC harness…');

    let currentMsg: Markdown | undefined;

    const hooks: HarnessHooks = {
      onStep: (step, phase) => {
        startSpinner(`${phase === 'start' ? '▶' : '✔'} ${STEP_LABEL[step]}`);
      },
      onAgentDelta: (role, _delta, full) => {
        if (!currentMsg) currentMsg = addAgentMessage(role, full);
        else currentMsg.setText(`${chalk.bold.magenta(`[${AGENT_LABEL[role]}]`)}\n${full}`);
        renderChat();
      },
      onAgentMessage: (role, text) => {
        if (currentMsg) {
          currentMsg.setText(`${chalk.bold.magenta(`[${AGENT_LABEL[role]}]`)}\n${text}`);
        } else {
          currentMsg = addAgentMessage(role, text);
        }
        renderChat();
        currentMsg = undefined;
      },
      onInfo: (text) => {
        addMessage('system', chalk.dim(text));
      },
      onSuspend: async (_reason, ask) => {
        addMessage('system', chalk.bold.yellow(`⚠ ${ask}`));
        stopSpinner();
        showStatus('Awaiting your input (type below and press Enter)…');
        const answer = await nextInput();
        clearStatus();
        return answer;
      },
    };

    const runner = new HarnessRunner({
      agents: deps.harnessAgents,
      config: deps.harnessConfig,
      git: deps.gitOps,
      hooks,
    });
    activeRunner = runner;

    try {
      const result = await runner.run(prompt);
      const tail = [
        `Harness finished: ${result.endReason}`,
        result.branch ? `Branch: ${result.branch}` : null,
        result.commit ? `Commit: ${result.commit.slice(0, 9)}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      addMessage('system', chalk.bold.cyan(tail));
    } catch (err) {
      addMessage('system', chalk.red(`Harness error: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      stopSpinner();
      activeRunner = undefined;
      // A harness run may create+checkout a branch; refresh the footer so it
      // reflects the new git branch below the input box.
      void refreshFooter();
    }
  }
}

/**
 * Build the Ctrl+C input-listener for `ui.addInputListener`. Two-stage, matching
 * the Editor's "let parent handle (exit/clear)" intent (its ctrl+c handler is a
 * no-op). stdin is in raw mode so Ctrl+C arrives as a byte, not a SIGINT — the
 * index.ts SIGINT handler never fires from the keystroke, so we handle it here,
 * before the editor:
 *   1. autocomplete dropdown open -> let it pass; the editor cancels it
 *      (tui.select.cancel includes ctrl+c);
 *   2. editor has text -> clear the input (and hint to press again to quit);
 *   3. editor empty -> call `quit` (same as /exit).
 *
 * Extracted so the behaviour is unit-testable without a live terminal.
 */
export interface CtrlCHandlerDeps {
  editor: Editor;
  ui: TUI;
  showStatus: (message: string) => void;
  quit: () => void;
}

export function createCtrlCHandler(deps: CtrlCHandlerDeps): (data: string) => { consume: true } | undefined {
  const { editor, ui, showStatus, quit } = deps;
  return (data) => {
    if (isKeyRelease(data)) return undefined;
    if (!matchesKey(data, 'ctrl+c')) return undefined;
    if (editor.isShowingAutocomplete()) return undefined; // editor cancels dropdown
    if (editor.getText().length > 0) {
      editor.setText('');
      showStatus('Input cleared — press Ctrl+C again to quit.');
      ui.requestRender();
      return { consume: true };
    }
    quit();
    return { consume: true };
  };
}