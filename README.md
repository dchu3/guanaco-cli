# guanaco-cli

A **local / small-model coding harness** built on the [@earendil-works/pi-tui](https://github.com/earendil-works/pi) framework and [Mastra](https://mastra.ai). It connects to **Ollama** models you run on your own machine (or [Ollama Cloud](https://ollama.com/cloud) as a fallback) and coordinates a team of SDLC-role agents to implement a feature end-to-end: plan (product ⇄ architect) → implement → review → test → commit.

Guanaco is a wild version of Llama.

## Why this harness?

Local and small LLMs are cheap, private, and fast — but they drift, loop, and hallucinate tools more easily than frontier models. Guanaco compensates by treating **Mastra as the guide**: each agent owns exactly one SDLC step, the workflow enforces hand-offs, and conservative-but-aggressive budgets (bounded cycles, bounded turns, repo-root jailing) keep the team on target. The defaults are tuned for capable local models; turn the human-in-the-loop gates back on when you want to steer a trickier request.

## Features

- ☑ **Local-first coding harness**: Mastra workflow coordinates Product, Architect, Coder, Reviewer, and Tester agents running against local Ollama models.
- ☑ **Aggressive local defaults**: every SDLC role defaults to a capable coder-tuned model, with more review/test cycles and longer tool timeouts so small models get multiple chances to finish.
- ☑ **CLI Interface**: Interactive terminal chat with streaming output, `/help`, `/clear`, `/model`, and shell execution (`!` prefix).
- ☑ **SDLC Harness**: `/feature <prompt>` runs the Mastra-coordinated team with optional human-in-the-loop gates.
- ☑ **Mastra Agents**: Each role is a Mastra `Agent` with scoped tools, wired to a per-role Ollama model.
- ☑ **Repo-grounded tools**: `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `shell`, `git_diff` — all jailed to the repo root with a destructive-command denylist.
- ☑ **Safe git flow**: the harness only ever commits on a new `feature/harness-<slug>` branch it creates (or automatically when `HARNESS_AUTO_COMMIT=1`).
- ☑ **Local or cloud**: `OLLAMA_PROVIDER=local` (default) or `cloud`.
- ☑ Tests for the Ollama client, tools, model resolution, and harness orchestration (with mock models).

## Prerequisites

1. **Node.js 20+**
2. **Ollama** running locally (for local mode):
   ```bash
   ollama serve            # starts the server on http://localhost:11434
   ollama pull qwen3.5:0.8b
   ollama pull qwen2.5-coder:7b   # aggressive local default for all harness roles
   ```

For lighter hardware you can keep planning roles on `qwen3.5:0.8b` and only run coding roles on `qwen2.5-coder:7b` via `HARNESS_MODEL_<ROLE>`.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

`.env.example` is the canonical source of defaults. It uses local Ollama models and aggressive harness budgets (`HARNESS_AUTO_COMMIT=1`, more cycles, longer timeouts). For a safer, more interactive run, set `HARNESS_AUTO_COMMIT=0` and `HARNESS_HUMAN_IN_LOOP_INTAKE=1`.

For a production-style run:

```bash
npm run build
npm start

# Override the chat model
npm start -- --model qwen2.5-coder:3b

# Use Ollama Cloud for the harness agents
OLLAMA_PROVIDER=cloud OLLAMA_API_KEY=sk-... npm start
```

### Global `guanaco` command (run the harness in any repo)

The package exposes a `guanaco` bin. No `sudo`, no `npm link`.

**From scratch (one line, no manual clone):**

```bash
curl -fsSL https://raw.githubusercontent.com/dchu3/guanaco-cli/main/scripts/remote-install.sh | bash
```

That clones the repo to `~/.local/share/guanaco-cli`, builds it, and installs
the `guanaco` shim on your `PATH`. (To audit the script first, download it
instead of piping: `curl -fsSL …/remote-install.sh -o /tmp/guanaco-install.sh`,
read it, then `bash /tmp/guanaco-install.sh`.) Pin a version with
`GUANACO_REF=<tag-or-branch>`, steer the clone dir with `GUIANACO_HOME=<dir>`,
or point at a fork with `GUIANACO_REPO=<git-url>`.

**From an existing checkout:**

```bash
bash scripts/install.sh          # or: npm run install:cli
```

If `~/.local/bin` isn't on your `PATH`, the installer appends a markered
`export PATH=...` to your shell rc and tells you to open a new shell. Undo
with `bash scripts/uninstall.sh` (or `npm run uninstall:cli`).

To update later, from **any** folder:

```bash
guanaco update                 # git pull + rebuild + refresh the shim
```

(`guanaco update` refuses to pull over uncommitted local changes in the repo
it was installed from; commit/stash first. Equivalent to `bash scripts/update.sh`
or `npm run update:cli`.)

Now from **any** git repo:

```bash
cd /path/to/other-repo
guanaco                      # HARNESS_REPO_ROOT defaults to the current dir
/feature add a /hello command that prints a greeting
guanaco --version             # prints the installed version
```

The wrapper loads env config from `~/.config/guanaco/.env` (global) and your
current directory's `.env` (per-repo override; see [Environment variables](#environment-variables))
and runs the compiled app — no `tsx watch`, so no file-watch restarts. Point it
at a repo elsewhere with `HARNESS_REPO_ROOT`:

```bash
HARNESS_REPO_ROOT=/path/to/other-repo guanaco
# or override per-role models inline:
HARNESS_MODEL_CODER=qwen2.5-coder:7b guanaco
```

If you haven't built yet, `guanaco` prints a reminder to run `npm run build`.

<details><summary>Alternative: <code>npm link</code> (if you have a writable npm prefix)</summary>

```bash
npm run build
npm link            # may need sudo, or a user-owned npm prefix
```

This is equivalent to the installer for users whose npm prefix is user-writable.
</details>

<details><summary>How the installer chooses its bin dir</summary>

Precedence: `$GUIANACO_BIN_DIR` if set &rarr; first writable dir already on
`PATH` &rarr; `~/.local/bin` (created if needed). The choice is recorded in
`~/.config/guanaco/install.env` so `uninstall.sh` is deterministic. The
launcher is a small bash shim that `exec`s `node <pkgdir>/bin/guanaco.js`, so
it keeps working after you move around; if the repo is moved/deleted the shim
prints a friendly "re-run install.sh" message instead of crashing.
</details>

## Running the harness

From inside a git repo (the harness operates only within the repo root):

```
/feature add a /hello command that prints a greeting
```

The harness will:
1. **Intake** — the Orchestrator parses your feature prompt. By default it does **not** pause (`HARNESS_HUMAN_IN_LOOP_INTAKE=0`); set it to `1` if you want to confirm/refine the plan before implementation.
2. **Plan** — the Product agent writes acceptance criteria and the Architect explores the repo and proposes a change set, both derived directly from your feature request. They can iterate (`HARNESS_MAX_PLAN_CYCLES`), then proceed automatically.
3. **Implement** — the Coder edits files and runs the build via the `shell` tool.
4. **Review** — the Reviewer diffs against the design/criteria; on `CHANGES_REQUESTED` it loops back to the Coder (up to `HARNESS_MAX_REVIEW_CYCLES`).
5. **Test** — the Tester writes/runs tests; on `TESTS_FAILED` it loops back to the Coder (up to `HARNESS_MAX_TEST_CYCLES`).
6. **Finalize** — the Orchestrator summarizes; with `HARNESS_AUTO_COMMIT=1` (default) it creates `feature/harness-<slug>` and commits automatically. Set `HARNESS_AUTO_COMMIT=0` to require approval.

Other commands:

- `/agents` — list the SDLC agents and their resolved models
- `/harness-status` — show the current/last run state
- `/model <name>` — switch the chat model
- `!<command>` — run a shell command directly
- `/clear`, `/help`, `/exit`

Plain text (not starting with `/` or `!`) is a regular single-agent chat via the Ollama client.

## Environment variables

`guanaco` loads env vars from (in override order):

1. **`~/.config/guanaco/.env`** — global config, applies in every repo. Put your
   usual Ollama URL + model here so you don't need a `.env` in each repo.
2. **`<cwd>/.env`** — per-repo override (wins over the global).

Only files that exist are loaded (so Node never prints `.env not found`), and
plain exported env vars from your shell profile work too.

| Variable               | Required | Default                  | Notes                                  |
| ---------------------- | :------: | ------------------------ | -------------------------------------- |
| `OLLAMA_BASE_URL`      |          | `http://localhost:11434` | Ollama HTTP endpoint                   |
| `OLLAMA_MODEL`         |          | `qwen3.5:0.8b`           | Chat model. Overridable via `--model`. |
| `OLLAMA_PROVIDER`      |          | `local`                  | `local` or `cloud` for harness agents  |
| `OLLAMA_API_KEY`       | cloud    | _(unset)_                | Required when `OLLAMA_PROVIDER=cloud`  |
| `HARNESS_MODEL_*`      |          | `qwen2.5-coder:7b` (all roles) | Per-role model overrides (`_ORCHESTRATOR`, `_PRODUCT`, `_ARCHITECT`, `_CODER`, `_REVIEWER`, `_TESTER`) |
| `HARNESS_MAX_REVIEW_CYCLES` |     | `4`                      | Max Coder⇄Reviewer loops               |
| `HARNESS_MAX_TEST_CYCLES`   |     | `4`                      | Max Coder⇄Tester loops                 |
| `HARNESS_MAX_PLAN_CYCLES`   |     | `0`                      | Max Product⇄Architect plan refinement rounds |
| `HARNESS_MAX_AGENT_STEPS`  |     | `12`                     | Max tool-loop steps per agent turn     |
| `HARNESS_AUTO_COMMIT`  |          | `1`                      | `1` = commit without asking            |
| `HARNESS_AUTO_STASH`  |          | `1`                      | `1` = auto-stash a dirty tree before a run and restore it after (instead of hard-blocking with `dirty-tree`). `0` = require a clean tree. |
| `HARNESS_HUMAN_IN_LOOP_INTAKE` |  | `0`                      | Pause at intake to confirm the plan    |
| `HARNESS_TOOL_TIMEOUT_MS`   |     | `300000`                 | Per `shell` tool call timeout (ms)      |
| `HARNESS_AGENT_TIMEOUT_MS`  |     | `300000`                 | Per-turn *inactivity* timeout (ms); keep > tool timeout. 0 = off |
| `HARNESS_AGENT_HARD_TIMEOUT_MS` |  | `600000`                 | Per-turn hard wall-clock cap (ms); 0 = off |
| `HARNESS_MAX_TURN_OUTPUT_BYTES` |  | `1000000`               | Max streamed bytes per agent turn before truncation/abort |
| `HARNESS_MAX_WALL_CLOCK_MS` |     | `0`                      | Max total wall-clock time for a full run (ms); 0 = off |
| `HARNESS_REPO_ROOT`    |          | `process.cwd()`           | Repo root the harness is jailed to      |
| `OLLAMA_TEMPERATURE`   |          | `0.8`                    | Overridable via `--temperature`        |
| `OLLAMA_TOP_P`         |          | `0.9`                    | Overridable via `--top-p`              |
| `OLLAMA_NUM_CTX`       |          | `2048`                   | Overridable via `--num-ctx`            |
| `REQUEST_TIMEOUT_MS`   |          | `60000`                  | Ollama request timeout                  |
| `STREAM_ENABLED`       |          | `1`                      | Stream the reply incrementally          |
| `DEBUG`                |          | `0`                      | Set `1` for verbose logs to stderr      |

## Project layout

```
src/
  index.ts          # entry point + graceful shutdown
  config.ts         # env/arg parsing incl. harness config
  cli.ts            # pi-tui interface + /feature harness runner
  ollama.ts         # legacy single-agent Ollama client + tool-calling loop
  tools.ts          # legacy tool registry (kept for /chat mode)
  mastra/
    index.ts        # buildSdlcAgentsFromConfig + re-exports
    models.ts       # local (ollama-ai-provider) + cloud model-router resolution
    agents.ts       # SDLC role agents (Mastra Agent) + instructions + AgentLike
    tools.ts        # repo-grounded Mastra tools (read/write/edit/glob/grep/shell/git_diff)
  harness/
    runner.ts       # HarnessRunner state machine: plan→…→finalize with HITL gates
    git.ts          # GitOps (clean-tree guard, branch+commit), slugify
    types.ts        # HarnessHooks, HarnessRunResult, HarnessRunState
  util/log.ts       # debug() helper
```

## Scripts

| Script                   | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `npm run dev`            | `tsx` run from source (no watch — Enter stays submit) |
| `npm run dev:watch`      | `tsx watch` (Enter restarts in watch mode — caveat)  |
| `npm run build`          | TypeScript build to `dist/`                          |
| `npm start`             | Run the compiled app from `dist/`                    |
| `npm run install:cli`    | Install the global `guanaco` shim via `scripts/install.sh`   |
| `npm run update:cli`      | Update an existing install via `scripts/update.sh`    |
| `npm run uninstall:cli`  | Remove the `guanaco` shim via `scripts/uninstall.sh`  |
| `npm test`              | Run the Vitest suite                                  |
| `npm run lint`           | ESLint over `src/` and `tests/`                      |

## License

MIT
