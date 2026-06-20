# Ollama CLI Template

A **starter template for building local-first, Ollama-powered command-line apps in TypeScript** — a polished terminal UI, streaming responses, config/env handling, and a slash-command shell. Bring your own Ollama model and start building.

## Features

- **Polished TUI** (built on [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)): pinned header, bottom-anchored input box, auto-trimming scrolling chat, animated spinner, and a PWD + git-branch footer.
- **Streaming responses** rendered incrementally as the model emits tokens.
- **Slash commands**: `/help`, `/clear`, `/model <name>`, `/log`, `/exit`, `/quit` (with a fuzzy autocomplete dropdown when you type `/`).
- **Shell passthrough**: type `!<command>` to run a shell command inline.
- **Config via `.env`** in the project directory, with CLI-flag overrides (`--model`, `--temperature`, `--top-p`, `--num-ctx`).
- **Generic Ollama client** with optional tool-calling loop — extend `src/tools.ts` to give the model tools.
- **File-backed debug log** + in-app `/log` so errors the TUI overwrites on screen are recoverable.
- **`--version` fast-path** that works without a running Ollama.
- **Tooling wired up**: TypeScript, Vitest, ESLint, Prettier.

## Prerequisites

1. **Node.js 20+**
2. **Ollama** running locally, with at least one model pulled:
   ```bash
   ollama serve                       # starts the server on http://localhost:11434
   ollama pull qwen2.5:3b             # (or any model you like)
   ```

## Quick start

```bash
cp .env.example .env          # then edit OLLAMA_MODEL to match a model you've pulled
npm install
npm run dev
```

For a production-style run:

```bash
npm run build
npm start

# Override the chat model for a single run
npm start -- --model llama3.2:3b
```

## Usage examples

Start the app, then just type to chat:

```
You: Summarize how HTTP caching works in two sentences.
Assistant: …
```

Switch models, run a shell command, or clear the screen — all without leaving the app:

```
/model qwen2.5:7b
!ls -la
/clear
/help
```

Override config inline:

```bash
OLLAMA_MODEL=llama3.2:3b npm start
npm start -- --temperature 0.3 --top-p 0.95
```

## Use this template

Click GitHub's **"Use this template"** button on the repo page, or with the GitHub CLI:

```bash
gh repo create --template <owner>/ollama-cli-template my-app
cd my-app
npm install
npm run dev
```

For a global `ollama-cli` command from your checkout:

```bash
npm run build
npm link            # may need a user-owned npm prefix
```

## Template customization checklist

- [ ] **Rename the app**: update `package.json` (`name`, `bin`, `description`); rename `bin/ollama-cli.js` and its error strings; update the header text in `src/cli.ts`; update the startup line in `src/index.ts`; update the log-file env var + default dir in `src/util/log.ts` (`OLLAMA_CLI_LOG_FILE`, `~/.ollama-cli`); update `.gitignore` (`.ollama-cli/`).
- [ ] **Pick a default model** in `.env.example` and in `src/config.ts` (the `OLLAMA_MODEL` fallback).
- [ ] **Add your own slash commands** in `src/commands.ts` and dispatch them in the `while (true)` loop in `src/cli.ts`.
- [ ] **Add tools** to `src/tools.ts` (`buildToolRegistry`) and pass them to `ollama.chat(messages, { tools })` in the chat turn in `src/cli.ts`.
- [ ] **Set a system prompt** via `SYSTEM_PROMPT` in `.env`, or hardcode one in `src/index.ts` / `src/cli.ts`.
- [ ] **Rewrite this `README.md`** with your app's name and features.
- [ ] **Update `LICENSE`** copyright if needed.

## Project layout

```
src/
  index.ts          # entry point + graceful shutdown + --version fast-path
  config.ts         # env/arg parsing (Ollama URL/model/generation params)
  cli.ts            # pi-tui interface + slash-command dispatch + chat turn
  commands.ts       # slash-command catalogue (single source of truth)
  ollama.ts         # streaming + tool-calling Ollama client
  tools.ts          # tool registry scaffold (extend to give the model tools)
  version.ts        # read version from package.json
  ui/layout.ts      # stacked-region layout (header/chat/status/filler/editor/footer)
  util/log.ts       # file-backed debug log + stderr tee + /log
bin/ollama-cli.js   # launcher: loads <cwd>/.env, forwards to dist/index.js
```

## Scripts

| Script              | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | `tsx` run from source                     |
| `npm run dev:watch` | `tsx watch` (auto-restart on file change) |
| `npm run build`     | TypeScript build to `dist/`               |
| `npm start`         | Run the compiled app from `dist/`        |
| `npm test`          | Run the Vitest suite                      |
| `npm run lint`      | ESLint over `src/` and `tests/`           |

## License

MIT