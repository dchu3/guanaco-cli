# telegram-local-llm-bot

A minimal Telegram bot and **interactive CLI** that proxies messages to a **local LLM** via [Ollama](https://ollama.com). Single-user, with in-memory chat history. Designed as a small, dependency-light base you can expand on.

No trading, no MCP, no payments — just `Telegram/CLI ↔ Ollama`.

## Features

- ☑ **CLI Interface**: Interactive terminal chat with streaming output.
- ☑ **Telegram Interface**: Access control via `TELEGRAM_ALLOWED_USER_ID`.
- ☑ Conversation memory (capped, with optional system prompt).
- ☑ `/help`, `/clear`, `/model`, `/execute` commands (shared between CLI and Telegram).
- ☑ Secure shell command execution via restricted allowlist.
- ☑ Typing indicators and streaming responses for a modern feel.
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
3. (Optional) A Telegram bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user id.

## Setup

```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID if using Telegram
npm install
npm run dev
```

For a production-style run:

```bash
npm run build
npm start
```

## Environment variables

| Variable                   | Required | Default                     | Notes                                          |
| -------------------------- | :------: | --------------------------- | ---------------------------------------------- |
| `TELEGRAM_ENABLED`         |          | `1`                         | Set `0` to run CLI only                        |
| `TELEGRAM_BOT_TOKEN`       |    ✅*   | —                           | Required only if `TELEGRAM_ENABLED=1`          |
| `TELEGRAM_ALLOWED_USER_ID` |    ✅*   | —                           | Required only if `TELEGRAM_ENABLED=1`          |
| `OLLAMA_BASE_URL`          |          | `http://localhost:11434`    | Ollama HTTP endpoint                           |
| `OLLAMA_MODEL`             |          | `llama3.2`                  | Must be pulled (`ollama pull <model>`)         |
| `SYSTEM_PROMPT`            |          | _(unset)_                   | Prepended to every conversation if set         |
| `MAX_HISTORY_MESSAGES`     |          | `20`                        | Cap for non-system messages                    |
| `REQUEST_TIMEOUT_MS`       |          | `60000`                     | Ollama request timeout                         |
| `STREAM_ENABLED`           |          | `1`                         | Stream the reply incrementally                 |
| `DEBUG`                    |          | `0`                         | Set `1` for verbose logs to stderr             |

## Commands

Commands work in both CLI and Telegram:

- `/help` — list commands
- `/clear` — reset your chat history
- `/model` — show the configured model
- `/execute <command>` — run a shell command (restricted via allowlist)
- `/exit` — quit the application (CLI only)

Any other text message is forwarded to the LLM.

## Project layout

```
src/
  index.ts      # entry point + graceful shutdown
  config.ts     # env parsing & validation
  cli.ts        # interactive terminal interface
  telegram.ts   # Telegraf bot wiring
  ollama.ts     # local LLM client + tool-calling loop
  history.ts    # in-memory history management
  tools.ts      # tool registry and dispatcher
  util/log.ts   # debug() helper
scripts/
  secure_execute.sh # shell command restriction wrapper
```

## Scripts

| Script          | Purpose                              |
| --------------- | ------------------------------------ |
| `npm run dev`   | `tsx watch` with live reload         |
| `npm run build` | TypeScript build to `dist/`          |
| `npm start`     | Run the compiled app from `dist/`    |
| `npm test`      | Run the Vitest suite                 |
| `npm run lint`  | ESLint over `src/` and `tests/`      |

## License

MIT
