# guanaco-cli

An **interactive CLI** that connects to a **local LLM** via [Ollama](https://ollama.com). Guanaco is a wild version of Llama. Designed as a small, dependency-light base you can expand on.

No trading, no MCP, no payments — just `CLI ↔ Ollama`.

## Features

- ☑ **CLI Interface**: Interactive terminal chat with streaming output.
- ☑ Conversation memory (capped, with optional system prompt).
- ☑ `/help`, `/clear`, `/model`, `/execute` commands.
- ☑ Secure shell command execution via restricted allowlist.
- ☑ Configurable timeout, model, and base URL.
- ☑ Tests for the Ollama client and history store.

## Prerequisites

1. **Node.js 20+**
2. **Ollama** running locally:
   ```bash
   # Install: https://ollama.com/download
   ollama serve            # starts the server on http://localhost:11434
   ollama pull llama3.2    # or pull a lightweight model like qwen2.5:0.5b
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

# Override the model from .env using a flag
npm start -- --model qwen2.5-coder:3b

# Or simply as a positional argument
npm start qwen2.5-coder:3b
```

## Environment variables

| Variable               | Required | Default                  | Notes                                  |
| ---------------------- | :------: | ------------------------ | -------------------------------------- |
| `OLLAMA_BASE_URL`      |          | `http://localhost:11434` | Ollama HTTP endpoint                   |
| `OLLAMA_MODEL`         |          | `llama3.2`               | Must be pulled. Overridable via `--model` flag or positional arg. |
| `SYSTEM_PROMPT`        |          | _(unset)_                | Prepended to every conversation if set |
| `MAX_HISTORY_MESSAGES` |          | `20`                     | Cap for non-system messages            |
| `REQUEST_TIMEOUT_MS`   |          | `60000`                  | Ollama request timeout                 |
| `STREAM_ENABLED`       |          | `1`                      | Stream the reply incrementally         |
| `DEBUG`                |          | `0`                      | Set `1` for verbose logs to stderr     |

## Commands

- `/help` — list commands
- `/clear` — reset your chat history
- `/model` — show the configured model
- `/execute <command>` — run a shell command (restricted via allowlist)
- `/exit` — quit the application

Any other text message is forwarded to the LLM.

## Project layout

```
src/
  index.ts      # entry point + graceful shutdown
  config.ts     # env parsing & validation
  cli.ts        # interactive terminal interface
  ollama.ts     # local LLM client + tool-calling loop
  history.ts    # in-memory history management
  tools.ts      # tool registry and dispatcher
  util/log.ts   # debug() helper
scripts/
  secure_execute.sh # shell command restriction wrapper
```

## Scripts

| Script          | Purpose                           |
| --------------- | --------------------------------- |
| `npm run dev`   | `tsx watch` with live reload      |
| `npm run build` | TypeScript build to `dist/`       |
| `npm start`     | Run the compiled app from `dist/` |
| `npm test`      | Run the Vitest suite              |
| `npm run lint`  | ESLint over `src/` and `tests/`   |

## License

MIT
