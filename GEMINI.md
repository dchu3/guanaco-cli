# Project Overview: guanaco-cli

An interactive CLI application that provides a direct interface to a local Large Language Model (LLM) running via **Ollama**. It is built with **TypeScript** and **Node.js**, prioritizing a small dependency footprint and clear, maintainable logic. It supports any model compatible with Ollama (e.g., **llama3.2**, **qwen**, **phi3**). Guanaco is a wild version of Llama.

### Core Architecture
- **CLI Interface (`src/cli.ts`)**: An interactive terminal interface using `enquirer`. Features include command handling (`/help`, `/clear`, `/model`, `/execute`), and incremental message streaming.
- **Ollama Client (`src/ollama.ts`)**: A custom client for the Ollama `/api/chat` endpoint. It handles both standard and streaming responses and supports generic tool-calling/dispatching loops. The model is configurable via `OLLAMA_MODEL`, the `--model` flag, or a positional CLI argument.
- **Tooling Infrastructure (`src/tools.ts`)**: A generic registry and dispatcher for LLM tools.
- **Configuration (`src/config.ts`)**: Robust environment variable and CLI argument parsing (`process.argv`) and validation using a strictly typed `AppConfig` interface.

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
- **Context Integrity**: The LLM relies on specific message sequencing. Ensure that any modifications to `cli.ts` or `ollama.ts` preserve the `user` -> `assistant` -> `tool` -> `assistant` lifecycle.
- **Privacy & Security**: 
    - Never log or store API secrets.
    - Never use real names or email addresses in git commit messages or metadata.
- **Tooling**: Supports inline JSON tool calls for models that struggle with native Ollama tool definitions. Handle JSON parsing defensively in `src/ollama.ts`.
