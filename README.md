# guanaco-cli

An **interactive coding harness** built on the [@earendil-works/pi-tui](https://github.com/earendil-works/pi) framework and [Mastra](https://mastra.ai). It connects to **Ollama** models — local or [Ollama Cloud](https://ollama.com/cloud) — and coordinates a team of SDLC-role agents to implement a feature end-to-end: plan → requirements → design → implement → review → test → commit.

Guanaco is a wild version of Llama.

## Features

- ☑ **CLI Interface**: Interactive terminal chat with streaming output, `/help`, `/clear`, `/model`, and shell execution (`!` prefix).
- ☑ **SDLC Harness**: `/feature <prompt>` runs a Mastra-coordinated team of agents (Orchestrator, Product, Architect, Coder, Reviewer, Tester) with human-in-the-loop gates.
- ☑ **Mastra Agents**: Each role is a Mastra `Agent` with scoped tools, wired to a per-role Ollama model.
- ☑ **Repo-grounded tools**: `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `shell`, `git_diff` — all jailed to the repo root with a destructive-command denylist.
- ☑ **Safe git flow**: the harness only ever commits on a new `feature/harness-<slug>` branch it creates, after human approval (or `--auto-commit`).
- ☑ **Local or cloud**: `OLLAMA_PROVIDER=local` (default) or `cloud`.
- ☑ Tests for the Ollama client, tools, model resolution, and harness orchestration (with mock models).

## Prerequisites

1. **Node.js 20+**
2. **Ollama** running locally (for local mode):
   ```bash
   ollama serve            # starts the server on http://localhost:11434
   ollama pull qwen3.5:0.8b
   ollama pull qwen2.5-coder:7b   # coding roles benefit from a coder-tuned model
   ```

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

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

The package exposes a `guanaco` bin. The simplest install — no `sudo`, no
`npm link` — is the bundled installer, which builds the app and drops a
`guanaco` launcher on your `PATH` (default `~/.local/bin`):

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

The wrapper loads `.env` from your current directory (so a `.env` in the target
repo is picked up) and runs the compiled app — no `tsx watch`, so no file-watch
restarts. Point it at a repo elsewhere with `HARNESS_REPO_ROOT`:

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
1. **Intake** — the Orchestrator decomposes the request into a plan, then (by default) pause for you to confirm or refine.
2. **Requirements** — the Product agent writes acceptance criteria.
3. **Design** — the Architect explores the repo and proposes a change set.
4. **Implement** — the Coder edits files and runs the build via the `shell` tool.
5. **Review** — the Reviewer diffs against the design/criteria; on `CHANGES_REQUESTED` it loops back to the Coder (up to `HARNESS_MAX_REVIEW_CYCLES`).
6. **Test** — the Tester writes/runs tests; on `TESTS_FAILED` it loops back to the Coder (up to `HARNESS_MAX_TEST_CYCLES`).
7. **Finalize** — the Orchestrator summarizes; with `HARNESS_AUTO_COMMIT=0` (default) it asks for approval, then creates `feature/harness-<slug>` and commits.

Other commands:

- `/agents` — list the SDLC agents and their resolved models
- `/harness-status` — show the current/last run state
- `/model <name>` — switch the chat model
- `!<command>` — run a shell command directly
- `/clear`, `/help`, `/exit`

Plain text (not starting with `/` or `!`) is a regular single-agent chat via the Ollama client.

## Environment variables

| Variable               | Required | Default                  | Notes                                  |
| ---------------------- | :------: | ------------------------ | -------------------------------------- |
| `OLLAMA_BASE_URL`      |          | `http://localhost:11434` | Ollama HTTP endpoint                   |
| `OLLAMA_MODEL`         |          | `qwen3.5:0.8b`           | Chat model. Overridable via `--model`. |
| `OLLAMA_PROVIDER`      |          | `local`                  | `local` or `cloud` for harness agents  |
| `OLLAMA_API_KEY`       | cloud    | _(unset)_                | Required when `OLLAMA_PROVIDER=cloud`  |
| `HARNESS_MODEL_*`      |          | see defaults             | Per-role model overrides (`_ORCHESTRATOR`, `_PRODUCT`, `_ARCHITECT`, `_CODER`, `_REVIEWER`, `_TESTER`) |
| `HARNESS_MAX_REVIEW_CYCLES` |     | `2`                      | Max Coder⇄Reviewer loops               |
| `HARNESS_MAX_TEST_CYCLES`   |     | `2`                      | Max Coder⇄Tester loops                 |
| `HARNESS_MAX_AGENT_STEPS`  |     | `8`                      | Max tool-loop steps per agent turn     |
| `HARNESS_AUTO_COMMIT`  |          | `0`                      | `1` = commit without asking            |
| `HARNESS_HUMAN_IN_LOOP_INTAKE` |  | `1`                      | Pause at intake to confirm the plan    |
| `HARNESS_TOOL_TIMEOUT_MS`   |     | `120000`                 | Per `shell` tool call timeout (ms)      |
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
    runner.ts       # HarnessRunner state machine: intake→…→finalize with HITL gates
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
