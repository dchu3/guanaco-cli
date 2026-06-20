# Refactor Plan: guanaco-cli → public GitHub template for Ollama-powered TS CLIs

## 0. Current state (what's here now)

The repo is currently a **local/small-model SDLC coding harness** built on `@earendil-works/pi-tui` + `@mastra/core`. It bundles three concerns that the prompt wants us to untangle:

1. **A polished interactive CLI shell** (`src/cli.ts`, `src/ui/layout.ts`, `src/commands.ts`, `src/util/log.ts`) — reusable, generic, worth keeping.
2. **A generic single-agent Ollama client** (`src/ollama.ts`, `src/tools.ts`, `src/config.ts`, `src/env-files.ts`, `src/version.ts`) — reusable, generic, worth keeping.
3. **A Mastra-coordinated SDLC agent team + harness runner + git ops** (`src/mastra/*`, `src/harness/*`) plus repo-specific install/update/remote-install machinery (`bin/guanaco.js`, `scripts/*.sh`, `patches/`) — the abandoned coding-harness direction to be removed or isolated.

### File inventory (keep / isolate / remove)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src/cli.ts` | **KEEP + trim** | Polished TUI, layout, spinner, footer, Ctrl+C handler, `/log`. Drop `/feature`, `/agents`, `/harness-status`, `runHarness`, `listAgents`, `harnessStatus`, harness imports/types. |
| `src/ui/layout.ts` | **KEEP** as-is | Pure, generic, well-tested layout helper. |
| `src/commands.ts` | **KEEP + trim** | Drop `/feature`, `/agents`, `/harness-status`. Keep `/help`, `/clear`, `/model`, `/log`, `/exit`, `/quit`, `!cmd`. |
| `src/ollama.ts` | **KEEP** | Generic streaming + tool-call loop client. |
| `src/tools.ts` | **KEEP** | Generic empty tool registry scaffold (good template extension point). |
| `src/config.ts` | **KEEP + trim** | Keep `AppConfig` + env/arg parsing for Ollama + generation params. Remove `HarnessConfig`, `SdlcRole`, all `HARNESS_*` parsing, `--provider`, `--auto-commit`, per-role model args. |
| `src/env-files.ts` | **KEEP + rename key** | Generic two-tier `.env` loader. Currently hard-codes `~/.config/guanaco/.env` → rename to template name. |
| `src/version.ts` | **KEEP** | Generic `--version`. |
| `src/util/log.ts` | **KEEP + rename** | File-backed debug log + stderr tee + `/log`. Rename `GUANACO_LOG_FILE` → `<TEMPLATE>_LOG_FILE` and default dir `~/.<template>/logs/`. |
| `src/index.ts` | **KEEP + trim** | Drop `buildSdlcAgentsFromConfig`, `GitOps`, harness wiring. Keep version fast-path, env capture, Ollama client, CLI start. |
| `src/mastra/*` | **ISOLATE** → `examples/mastra-sdlc-harness/` | Worth preserving as an optional example. Mastra is NOT a core dependency after move. |
| `src/harness/*` | **ISOLATE** → `examples/mastra-sdlc-harness/` | Harness runner + git ops belong with the Mastra example. |
| `tests/mastra/*` | **ISOLATE** → `examples/mastra-sdlc-harness/tests/` | Move with the Mastra example. |
| `tests/harness/*` | **ISOLATE** → `examples/mastra-sdlc-harness/tests/` | Move with the Mastra example. |
| `tests/util/log.test.ts` | **KEEP + update env name** | Tests generic log behavior; update `GUANACO_LOG_FILE` → new name. |
| `tests/commands.test.ts` | **KEEP + update** | Drop `/feature` etc. from expected list. |
| `tests/ui/*` | **KEEP** | Layout + viewport tests are generic. Update if command list shrinks. |
| `tests/ollama.test.ts` | **KEEP** | Generic Ollama client tests. |
| `tests/ctrlc-handler.test.ts` | **KEEP** | Tests exported `createCtrlCHandler`. |
| `tests/env-files.test.ts` | **KEEP + update paths** | Update `~/.config/guanaco/.env` → `~/.config/<template>/.env`. |
| `tests/version.test.ts` | **KEEP** | Generic. |
| `tests/remote-install.test.ts` | **REMOVE** | Tests repo-specific curl installer. |
| `tests/update.test.ts` | **REMOVE** | Tests repo-specific `update.sh`. |
| `bin/guanaco.js` | **REWRITE** as generic `bin/<template>.js` | Drop `guanaco update` subcommand + install.env resolution. Keep env-file loading + forwarding to `dist/index.js`. |
| `scripts/install.sh` | **REMOVE** | Repo-specific global installer. Template users `npm install` / `npm link` themselves. |
| `scripts/uninstall.sh` | **REMOVE** | Pairs with installer. |
| `scripts/update.sh` | **REMOVE** | Repo-specific updater. |
| `scripts/remote-install.sh` | **REMOVE** | Curl-pipe installer tied to a specific GitHub repo. |
| `scripts/bench-tools.ts` | **ISOLATE or REMOVE** | Benches the Mastra tool set. Move into the Mastra example or drop. |
| `patches/ollama-ai-provider+1.2.0.patch` | **REMOVE from core** | Only needed for `ollama-ai-provider` (Mastra path). Move patch + `postinstall`/`patch-package` devDep into the Mastra example folder. |
| `conductor/*.md` | **REMOVE** | Internal planning docs. |
| `docs/*.md` | **REMOVE** | All stale internal plan docs (`SDLC_HARNESS_PLAN.md`, etc.). Replace with a single `docs/` only if needed. |
| `GEMINI.md` | **REMOVE** | Stale internal agent-context doc (references `enquirer`, `/execute`, `master` branch — all wrong now). |
| `README.md` | **REWRITE** | New public-facing template README (see §4). |
| `.env.example` | **REWRITE** | Generic Ollama-only config; no `HARNESS_*`. |
| `.env` | **REMOVE from git** (already gitignored) | Contains real/local values. Ensure gitignored; do not commit. |
| `package.json` | **REWRITE metadata** | New generic name, bin, description, deps without Mastra/ollama-ai-provider/patch-package in core. |
| `package-lock.json` | **Regenerate** | After `package.json` dep changes. |
| `tsconfig.json`, `vitest.config.ts`, `.eslintrc.json`, `.prettierrc.json` | **KEEP** (minor: add `examples/` to lint/ts ignore) | Solid generic tooling. |
| `LICENSE` | **KEEP** (update author/copyright if desired) | MIT, fine for a template. |
| `.gitignore` | **KEEP + trim** | Drop `.guanaco/`, `conductor/`, `chat.db*`, `.gemini_security/`, `.npx_cache/`. Add `examples/*/node_modules/`. |

---

## 1. Target repo structure

```
<template-name>/
├── .env.example                 # generic Ollama-only config
├── .eslintrc.json
├── .gitignore
├── .prettierrc.json
├── LICENSE
├── README.md                    # public-facing template README
├── bin/<template>.js            # generic launcher: load .env, forward to dist
├── package.json                 # generic name, no Mastra in core deps
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                 # entry: version fast-path + Ollama client + startCli
│   ├── cli.ts                   # TUI shell (chat + slash commands + shell + /log)
│   ├── commands.ts              # /help /clear /model /log /exit /quit + !cmd
│   ├── config.ts                # AppConfig: Ollama URL/model/gen params from env+argv
│   ├── env-files.ts             # two-tier .env loader (global ~/.config/<template> + cwd)
│   ├── ollama.ts                # streaming + tool-call client
│   ├── tools.ts                 # empty tool registry scaffold
│   ├── version.ts               # --version
│   ├── ui/
│   │   └── layout.ts            # layoutToFit stacked-region layout
│   └── util/
│       └── log.ts               # file debug log + stderr tee + /log
├── tests/
│   ├── commands.test.ts
│   ├── ctrlc-handler.test.ts
│   ├── env-files.test.ts
│   ├── ollama.test.ts
│   ├── version.test.ts
│   ├── ui/{layout,cli-viewport}.test.ts
│   └── util/log.test.ts
└── examples/
    └── mastra-sdlc-harness/     # OPTIONAL, self-contained, not in core build
        ├── README.md            # how to add Mastra back, run the SDLC team
        ├── package.json         # own deps: @mastra/core, ollama-ai-provider, zod, patch-package
        ├── patches/ollama-ai-provider+1.2.0.patch
        ├── tsconfig.json
        ├── src/
        │   ├── index.ts         # example entry wiring harness into the template's CLI
        │   ├── mastra/{index,models,agents,tools}.ts
        │   ├── harness/{runner,git,types}.ts
        │   └── config-extras.ts # HarnessConfig + HARNESS_* parsing (extends AppConfig)
        └── tests/{harness,mastra}/
```

The Mastra example is **self-contained**: its own `package.json`, `tsconfig.json`, `node_modules`, and tests. The core template builds and tests run **without** it. The example's README explains how to merge its pieces into the main `src/` if a user wants the harness as their app.

---

## 2. Naming

Pick a generic, publishable template name. Candidates:
- `ollama-cli-template`
- `ollama-ts-cli-starter`
- `local-llm-cli-template`

**Recommendation: `ollama-cli-template`** (bin name `ollama-cli`, env prefix `OLLAMA_CLI`, config dir `~/.config/ollama-cli/`, log dir `~/.ollama-cli/logs/`). It reads as a template and is descriptive.

All renames in the plan below assume `ollama-cli-template` / `ollama-cli`. (Easy to swap.)

---

## 3. Step-by-step execution plan

### Phase A — Isolate Mastra + harness (before deleting anything)

1. Create `examples/mastra-sdlc-harness/` with subdirs `src/`, `tests/`, `patches/`.
2. `git mv src/mastra examples/mastra-sdlc-harness/src/mastra`
3. `git mv src/harness examples/mastra-sdlc-harness/src/harness`
4. `git mv tests/mastra examples/mastra-sdlc-harness/tests/mastra`
5. `git mv tests/harness examples/mastra-sdlc-harness/tests/harness`
6. `git mv patches examples/mastra-sdlc-harness/patches` (move the whole `patches/` dir)
7. `git mv scripts/bench-tools.ts examples/mastra-sdlc-harness/bench-tools.ts`
8. Write `examples/mastra-sdlc-harness/package.json`:
   - name `mastra-sdlc-harness-example`
   - deps: `@mastra/core`, `ollama-ai-provider`, `zod`, `picomatch`, plus the template's runtime deps (`chalk`, `marked`, `ora`, `@earendil-works/pi-tui`) if it imports the template's `src/` — OR make it standalone by copying the small pieces it needs. **Prefer: the example imports from the parent template via a relative path / workspace**, and documents that it's an opt-in add-on. Simplest clean option: example has its **own** copy of the harness+mastra code and its own deps; it does not import the template's `src/` at build time. Document that the files are meant to be copied into the template's `src/` to adopt.
9. Write `examples/mastra-sdlc-harness/tsconfig.json` (extend a base or standalone).
10. Write `examples/mastra-sdlc-harness/README.md`:
    - What it is: a Mastra-coordinated SDLC agent team (Product/Architect/Coder/Reviewer/Tester) that the core template deliberately leaves out.
    - Why it's optional: keeps the core template Mastra-free.
    - How to adopt: copy `src/mastra/`, `src/harness/`, `src/config-extras.ts` into the template's `src/`; add the deps from this example's `package.json` to the root; re-add the `postinstall: patch-package` script and the `patches/` dir; wire `buildSdlcAgentsFromConfig` + `GitOps` into `src/index.ts` and the `/feature` command into `src/cli.ts`.
    - Env vars: the `HARNESS_*` table (moved from the main README).
    - How to run its own tests: `cd examples/mastra-sdlc-harness && npm install && npm test`.
11. Fix import paths inside the moved files (they used `../config.js`, `../util/log.js` from `src/mastra/` → now relative to the example's layout). Either:
    - Keep them importing a sibling `config-extras.ts` (a trimmed copy of the old `config.ts` `HarnessConfig`/`SdlcRole` + parsing), and copy `util/log.ts` into the example (or import from `../../src/util/log.ts` if a workspace is set up). **Cleanest for an isolated, runnable example: give it its own minimal `util/log.ts` shim** so it has zero compile-time dependency on the template's `src/`.
12. Move `tests/mastra` + `tests/harness` into the example and fix their imports.

### Phase B — Remove repo-specific automation & stale docs

13. `git rm -r conductor/ docs/ GEMINI.md`
14. `git rm scripts/install.sh scripts/uninstall.sh scripts/update.sh scripts/remote-install.sh`
15. `git rm tests/remote-install.test.ts tests/update.test.ts`
16. Remove the `scripts/` dir if now empty.
17. Confirm `.env` is gitignored and NOT committed (it already is). Do not commit its contents.

### Phase C — Trim the core source

18. `src/config.ts`:
    - Remove `SdlcRole`, `OllamaProviderMode`, `HarnessConfig`, `ollamaApiKey`, `roleModels`, all `HARNESS_*` env parsing, `--provider`, `--<role>-model`, `--auto-commit`, `--auto-stash`.
    - `AppConfig` loses the `harness` field. Keep: `ollamaBaseUrl`, `ollamaModel`, `systemPrompt`, `requestTimeoutMs`, `streamEnabled`, `temperature`, `topP`, `numCtx`.
    - Keep helper `intEnv`/`floatEnv`/`boolEnv`/`getArgValue`/`parseBool`.
19. `src/commands.ts`:
    - Drop the `/feature`, `/agents`, `/harness-status` entries. Update `formatCommandList` accordingly (no change needed beyond the array).
20. `src/cli.ts`:
    - Remove imports: `HarnessConfig`, `SdlcRole`, `SdlcAgents`, `DEFAULT_ROLE_MODELS`, `HarnessRunner`, `GitOps`, `HarnessHooks`, `HarnessStep`.
    - Remove `AGENT_LABEL`, `STEP_LABEL`, `activeRunner`, `activeAbort`, `listAgents`, `harnessStatus`, `runHarness`, the `/feature`/`/agents`/`/harness-status` command branches, and the Esc-abort input listener (only meaningful for harness runs).
    - Keep: header/chat/status/filler/editor/footer layout, spinner, footer (PWD + git branch — still a nice generic touch), Markdown rendering, `/model`, `/clear`, `/help`, `/log`, `!cmd`, default chat turn with streaming, Ctrl+C handler, resize listener.
    - Update `CliDeps`: drop `harnessAgents`, `harnessConfig`, `gitOps`. Keep `ollama`, `tools`, `streamEnabled`.
    - Update header text from `Guanaco CLI 🦙 · SDLC harness` to the template name (e.g. `Ollama CLI`). Drop the `harness=` provider bit from the model line.
21. `src/index.ts`:
    - Drop `buildSdlcAgentsFromConfig`, `GitOps`, harness wiring.
    - Keep version fast-path, `captureStderr`, `installGlobalErrorCapture`, `loadConfig`, `OllamaClient`, `buildToolRegistry`, `startCli`, signal handlers.
    - Update the startup console line to the template name + model + ollama URL (no `harness=`).
22. `src/env-files.ts`:
    - Rename the global path from `~/.config/guanaco/.env` → `~/.config/ollama-cli/.env`. Keep the two-tier logic.
23. `src/util/log.ts`:
    - Rename `GUANACO_LOG_FILE` → `OLLAMA_CLI_LOG_FILE`; default dir `~/.ollama-cli/logs/debug.log`. Update the doc comment.
24. `bin/guanaco.js` → `bin/ollama-cli.js`:
    - Remove the `guanaco update` branch and `resolvePkgDir`/`install.env` reading.
    - Keep: forward to `dist/index.js`, load `~/.config/ollama-cli/.env` then `cwd/.env` via `dist/env-files.js` (with inline fallback), forward extra args (`--version`, `--model`, etc.).
    - Update error messages to the new name.
25. Update `package.json` `bin` to `{ "ollama-cli": "bin/ollama-cli.js" }`.

### Phase D — Update tests for the trimmed core

26. `tests/commands.test.ts`: remove `/feature`, `/agents`, `/harness-status` from expected names.
27. `tests/env-files.test.ts`: update expected path `~/.config/guanaco/.env` → `~/.config/ollama-cli/.env`.
28. `tests/util/log.test.ts`: set `OLLAMA_CLI_LOG_FILE` instead of `GUANACO_LOG_FILE`.
29. `tests/ui/cli-viewport.test.ts`: if it asserts the full `COMMANDS` set, update to the trimmed set.
30. `tests/ctrlc-handler.test.ts`, `tests/ollama.test.ts`, `tests/version.test.ts`, `tests/ui/layout.test.ts`: no changes expected (verify).
31. Run `npm test` from the core and fix anything that referenced removed symbols.

### Phase E — package.json metadata rewrite

32. New `package.json`:
    ```json
    {
      "name": "ollama-cli-template",
      "version": "0.1.0",
      "description": "A starter template for building local-first, Ollama-powered command-line apps in TypeScript — polished TUI, streaming, config/env handling, and a slash-command shell.",
      "license": "MIT",
      "type": "module",
      "main": "dist/index.js",
      "bin": { "ollama-cli": "bin/ollama-cli.js" },
      "scripts": {
        "build": "tsc -p tsconfig.json",
        "dev": "tsx --env-file-if-exists=.env src/index.ts",
        "dev:watch": "tsx watch --clear-screen=false --env-file-if-exists=.env src/index.ts",
        "start": "node --env-file-if-exists=.env dist/index.js",
        "test": "vitest run",
        "lint": "eslint \"src/**/*.ts\" \"tests/**/*.ts\""
      },
      "dependencies": {
        "@earendil-works/pi-tui": "^0.74.0",
        "chalk": "^5.6.2",
        "marked": "^18.0.3",
        "ora": "^9.4.0",
        "picocolors": "^1.1.1"
      },
      "devDependencies": {
        "@types/node": "^20.12.12",
        "@typescript-eslint/eslint-plugin": "^7.11.0",
        "@typescript-eslint/parser": "^7.11.0",
        "eslint": "^8.57.0",
        "prettier": "^3.3.0",
        "tsx": "^4.11.0",
        "typescript": "^5.4.5",
        "vitest": "^4.1.5"
      }
    }
    ```
    - Removed from core deps: `@mastra/core`, `ollama-ai-provider`, `zod`, `picomatch`, `patch-package`, `@types/picomatch`.
    - Removed scripts: `install:cli`, `uninstall:cli`, `update:cli`, `postinstall`.
    - `keywords`: `ollama`, `cli`, `template`, `typescript`, `llm`, `local-llm`, `starter`, `tui`.
    - `repository`, `author`, `homepage`: fill in for the public GitHub repo.
33. Regenerate `package-lock.json` (`rm package-lock.json && npm install`).

### Phase F — tsconfig / lint scope

34. `tsconfig.json`: `include` stays `["src/**/*.ts"]` — the example is outside `src/`, so it won't be compiled by the core build. Good.
35. `.eslintrc.json`: add `examples/` to `ignorePatterns` so the example's (separately linted) code isn't checked by the root lint.

### Phase G — .env.example rewrite

36. New `.env.example` (generic, Ollama-only):
    ```
    # Ollama CLI template configuration.
    # Loaded from (in override order):
    #   1. ~/.config/ollama-cli/.env   (global — applies everywhere)
    #   2. <cwd>/.env                  (per-project override)
    # Only existing files are loaded. Plain exported env vars also work.

    # Ollama HTTP endpoint.
    OLLAMA_BASE_URL=http://localhost:11434
    # Default model (pull first with: ollama pull <model>).
    OLLAMA_MODEL=qwen2.5:3b

    # Optional system prompt prepended to every chat.
    SYSTEM_PROMPT=You are a helpful assistant running locally. Be concise.

    # Request timeout (ms).
    REQUEST_TIMEOUT_MS=60000
    # Stream the model's reply into the terminal (0 disables).
    STREAM_ENABLED=1
    # Verbose debug log to stderr + the log file (0/1).
    DEBUG=0

    # Debug log file (defaults to ~/.ollama-cli/logs/debug.log).
    # OLLAMA_CLI_LOG_FILE=/tmp/ollama-cli-debug.log

    # Generation parameters (optional).
    OLLAMA_TEMPERATURE=0.8
    OLLAMA_TOP_P=0.9
    OLLAMA_NUM_CTX=2048
    ```
    - No `HARNESS_*`, no `OLLAMA_PROVIDER`, no `OLLAMA_API_KEY`.
    - Pick a sensible default model that a newcomer is likely to have (`qwen2.5:3b` or `llama3.2:3b`).

### Phase H — README.md (public-facing template)

37. New `README.md` structure (per deliverables):
    - **Title + one-line value proposition**: "Ollama CLI Template — a starter for building local-first, Ollama-powered command-line apps in TypeScript."
    - **Features** bullet list: polished TUI (pinned header/input, scrolling chat, spinner, PWD+git footer), streaming responses, slash commands (`/help /clear /model /log /exit`), `!cmd` shell passthrough, two-tier `.env` config (global + per-project), generic Ollama client with optional tool-calling, file-backed debug log + `/log`, `--version`/`--model`/`--temperature`/`--top-p`/`--num-ctx` flags, Vitest + ESLint + Prettier wired up, optional Mastra SDLC-harness example.
    - **Prerequisites**: Node.js 20+, Ollama running locally, at least one pulled model. Include the `ollama serve` + `ollama pull` commands.
    - **Quick start**: `cp .env.example .env` → `npm install` → `npm run dev`. Then `npm run build` + `npm start`.
    - **Usage examples**: a sample chat session; `/model qwen2.5:7b`; `!ls -la`; `--model llama3.2:3b`; env override `OLLAMA_MODEL=... npm start`.
    - **"Use this template" guidance**: GitHub "Use this template" button → `gh repo create --template <owner>/ollama-cli-template my-app` → clone → `npm install` → run. Then `npm run build && npm link` for a global bin if desired.
    - **Template customization checklist** (a clear, copy-pasteable list):
      - [ ] Rename: `package.json` `name`/`bin`/`description`; `bin/ollama-cli.js` filename + error strings; `src/env-files.ts` `~/.config/ollama-cli`; `src/util/log.ts` `OLLAMA_CLI_LOG_FILE` + `~/.ollama-cli`; header text in `src/cli.ts`; startup line in `src/index.ts`.
      - [ ] Replace the default model in `.env.example` and `src/config.ts` (`'qwen3.5:0.8b'` fallback).
      - [ ] Add your own slash commands in `src/commands.ts` + dispatch in `src/cli.ts`.
      - [ ] Add tools to `src/tools.ts` (`buildToolRegistry`) and pass to `ollama.chat(..., { tools })`.
      - [ ] Tweak the system prompt via `SYSTEM_PROMPT` or hardcode in `src/index.ts`.
      - [ ] Update `README.md` with your app's name + features.
      - [ ] Update `LICENSE` copyright if needed.
      - [ ] (Optional) Adopt `examples/mastra-sdlc-harness/` for a multi-agent coding harness — see its README.
    - **Project layout** (trimmed tree, no `mastra/`/`harness/`).
    - **Scripts** table (build/dev/start/test/lint only).
    - **Optional: Mastra SDLC harness example** — one paragraph + link to `examples/mastra-sdlc-harness/README.md`. State clearly it's opt-in and the core template works without it.
    - **License**: MIT.

### Phase I — .gitignore cleanup

38. `.gitignore`: keep `node_modules/`, `dist/`, `.env`, `.env.local`, `*.log`, `.DS_Store`, `coverage/`. Remove `.guanaco/`, `conductor/`, `chat.db*`, `.gemini_security/`, `.npx_cache/`. Add `examples/*/node_modules/` and `examples/*/dist/`. Add `.ollama-cli/` (matches the renamed log dir, in case anyone runs from the repo root).

### Phase J — Verify

39. From repo root: `npm install`, `npm run build`, `npm test`, `npm run lint`. All green, no references to removed symbols.
40. `npm run dev` smoke (manual): confirm chat works against a local Ollama, `/help`, `/model`, `/clear`, `/log`, `!ls`, Ctrl+C twice-to-quit all work.
41. `cd examples/mastra-sdlc-harness && npm install && npm test` — confirm the isolated example still builds/tests (best-effort; this is the "preserve if worth it" path).
42. `grep -ri "guanaco\|harness\|mastra\|HARNESS_\|dchu3" src/ tests/ bin/ README.md .env.example package.json` — confirm no stray references in the core (Mastra example folder is the only allowed hit).

---

## 4. Mastra decision

**Mastra is ISOLATED, not removed.** The full `src/mastra/`, `src/harness/`, their tests, the `ollama-ai-provider` patch, and the `HARNESS_*` config all move into `examples/mastra-sdlc-harness/` as a self-contained, separately-installed, separately-tested example with its own README explaining how to adopt it. The core template has **zero** Mastra/`ollama-ai-provider`/`patch-package`/`zod`/`picomatch` dependencies and builds + runs + tests without it. This satisfies "do not make Mastra a required dependency" and "if worth preserving, move into an optional example or isolated folder."

---

## 5. Risks / trade-offs

- **Import rewiring in the moved example**: the harness/mastra files currently import `../config.js` (for `HarnessConfig`/`SdlcRole`) and `../util/log.js`. After moving, these break. Mitigation: give the example its own `config-extras.ts` (copy of the removed `HarnessConfig` + `HARNESS_*` parsing) and a tiny `util/log.ts` (or re-export from the parent via a workspace). Adds some duplication but keeps the example independently runnable — which is the whole point of isolating it. **If the rewiring proves messy, fallback: remove the example entirely** and instead keep a `docs/MASTRA_HARNESS.md` design note + a git tag/branch pointing at the pre-refactor commit so the code is recoverable. The prompt says "If there is a trade-off between preserving an old feature and making the template cleaner, choose the cleaner template."
- **Default model**: `src/config.ts` still hard-codes `'qwen3.5:0.8b'` as the fallback when `OLLAMA_MODEL` is unset. Update to a commonly-pulled model (`qwen2.5:3b` / `llama3.2:3b`) for first-run success.
- **`MAX_HISTORY_MESSAGES`** appears in `.env` but is never read by `src/config.ts` — drop it from `.env.example`.
- **`OLLAMA_API_KEY`**: only meaningful for cloud, which is a Mastra-example concern. Drop from core `.env.example`; keep in the example's env doc.

---

## 6. Summary (to produce at the end of execution)

- **Removed**: `conductor/`, `docs/` (all stale plan .md files), `GEMINI.md`, `scripts/{install,uninstall,update,remote-install}.sh`, `tests/{remote-install,update}.test.ts`, repo-specific global-installer machinery, `HARNESS_*` config, `/feature` `/agents` `/harness-status` commands, the `guanaco update` bin subcommand, `postinstall`/`patch-package`/`@mastra/core`/`ollama-ai-provider`/`zod`/`picomatch` from core deps, stale `.env` keys (`MAX_HISTORY_MESSAGES`, `HARNESS_*`, `OLLAMA_PROVIDER`, `OLLAMA_API_KEY`), and stale `.gitignore` entries.
- **Kept**: the pi-tui CLI shell (`src/cli.ts`, `src/ui/layout.ts`), command catalogue (`src/commands.ts` trimmed), Ollama streaming + tool-call client (`src/ollama.ts`, `src/tools.ts`), env/arg config (`src/config.ts` trimmed), two-tier `.env` loader (`src/env-files.ts`), file debug log + `/log` (`src/util/log.ts`), `--version` fast-path (`src/version.ts`), entry wiring (`src/index.ts` trimmed), generic launcher (`bin/ollama-cli.js`), the full Vitest/ESLint/Prettier/TS tooling, and the relevant tests.
- **Mastra**: **isolated** into `examples/mastra-sdlc-harness/` (self-contained package, own deps + tests + README + patch). Not a core dependency. Adoptable by copying files in.
- **Manual steps before publishing**:
  1. Choose/confirm the final template name and bin name; do the find-and-replace across `package.json`, `bin/`, `src/cli.ts` header, `src/index.ts` startup line, `src/env-files.ts`, `src/util/log.ts`, `README.md`, `.env.example`.
  2. Set `package.json` `repository`/`homepage`/`author`/`keywords` to the public repo's values.
  3. Update `LICENSE` copyright line if desired (currently `2026 dchu3`).
  4. Push to a fresh public GitHub repo and enable "Template repository" in Settings → General → "Template repository" checkbox, so the "Use this template" button appears.
  5. Add a short repo description + topics (`ollama`, `cli`, `template`, `typescript`, `llm`) on GitHub.
  6. Optional: add a CI workflow (`.github/workflows/ci.yml`) running `npm install && npm run build && npm test && npm run lint`.
  7. Double-check no secrets/private refs remain: `grep -ri "dchu3\|GUANACO\|HARNESS\|sk-\|API_KEY=" src/ tests/ bin/ README.md .env.example package.json` (example folder may legitimately retain `HARNESS_*`/`API_KEY` references).
  8. Verify first-run success on a clean clone: `npm install && cp .env.example .env && npm run dev` against a local Ollama with the default model pulled.