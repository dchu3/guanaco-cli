# Project Overview: telegram-local-llm-bot

A minimal, single-user Telegram bot that provides a direct interface to a local Large Language Model (LLM) running via **Ollama**. It is built with **TypeScript** and **Node.js**, prioritizing a small dependency footprint and clear, maintainable logic. It supports any model compatible with Ollama (e.g., **llama3.2**, **qwen**, **phi3**).

### Core Architecture
- **Telegram Bot (`src/telegram.ts`)**: Uses the `Telegraf` library. Features include user authorization, command handling (`/start`, `/help`, `/clear`, `/model`), typing indicators, and incremental message streaming.
- **Ollama Client (`src/ollama.ts`)**: A custom client for the Ollama `/api/chat` endpoint. It handles both standard and streaming responses and supports generic tool-calling/dispatching loops. The model used is configurable via the `OLLAMA_MODEL` environment variable.
- **History Management (`src/history.ts`)**: Manages per-user in-memory chat history with strict enforcement of user/assistant message alternation and size-based window trimming.
- **Tooling Infrastructure (`src/tools.ts`)**: A generic registry and dispatcher for LLM tools. While the codebase is prepared for tool expansion, specific unstable tools (like web search) have been removed to ensure model reliability.
- **Configuration (`src/config.ts`)**: Robust environment variable parsing and validation using a strictly typed `AppConfig` interface.

## Building and Running

Ensure you have **Node.js 20+** and a local **Ollama** instance serving models (default: `llama3.2`).

### Commands
- **Install Dependencies**: `npm install`
- **Development**: `npm run dev` (uses `tsx watch` for hot reloading)
- **Production Build**: `npm run build` (compiles to `dist/` via `tsc`)
- **Run Production**: `npm start`
- **Testing**: `npm test` (runs the Vitest suite)
- **Linting**: `npm run lint` (runs ESLint)

## Development Conventions

- **Type Safety**: All contributions should maintain strict TypeScript typing. Avoid `any` or type casts where explicit guards or interfaces can be used.
- **Testing**: New features or bug fixes must be accompanied by tests in the `tests/` directory using **Vitest**.
- **Git Workflow**: 
    - Always create a feature branch for any changes.
    - Never commit or push directly to the `master` branch.
- **Context Integrity**: The LLM relies on specific message sequencing. Ensure that any modifications to `telegram.ts` or `ollama.ts` preserve the `user` -> `assistant` -> `tool` -> `assistant` lifecycle.
- **Privacy & Security**: 
    - Never log or store raw `TELEGRAM_BOT_TOKEN`.
    - Use the `maskPii` utility in `src/util/log.ts` when logging user IDs or sensitive metadata.
    - Always verify `TELEGRAM_ALLOWED_USER_ID` at the middleware level.
    - Never use real names or email addresses in git commit messages or metadata.
- **Tooling**: The bot supports inline JSON tool calls for models that struggle with native Ollama tool definitions. Handle JSON parsing defensively in `src/ollama.ts`.
