# Plan: One-command installer so `guanaco` runs from any folder

## Objective

Give a user a single command that installs guanaco-cli so they can `cd` into
**any folder** and launch the harness with `guanaco` — no manual `npm link`,
no `sudo`, no editing dotfiles by hand. The installer builds the app once and
puts a `guanaco` shim on the user's `PATH`; an uninstaller removes it.

All work for this initiative happens on the `feature/installer-script` branch.

## Goals & Non-Goals

**Goals**
- A POSIX bash installer (`scripts/install.sh`) that, from a clone of this
  repo: installs deps, builds `dist/`, and installs a `guanaco` executable on
  the user's `PATH` without root.
- Idempotent: re-running updates the build and refreshes the link.
- Works on Linux + macOS bash (the dev's platform is Linux/bash; macOS is a
  likely user platform too).
- Detects whether the chosen bin dir is on `PATH`; if not, appends a sourced
  `export PATH=...` line to the detected shell rc (`~/.bashrc` / `~/.zshrc`)
  and prints a clear "restart your shell" notice.
- A matching `scripts/uninstall.sh` that removes the shim and the rc lines.
- The shim runs the **existing** `bin/guanaco.js` (which already loads `.env`
  from `cwd` and sets `HARNESS_REPO_ROOT` to `cwd`), so no app-code changes are
  required for the "any folder" behaviour.
- `npm run install:cli` / `npm run uninstall:cli` wrappers for convenience.
- README section updated with the one-liner.

**Non-Goals (for this iteration)**
- No Windows support (a `.ps1`/`.cmd` installer can follow; the dev is on
  Linux). The shim itself is `#!/usr/bin/env node`, so Windows users with a
  POSIX-ish shell can still run the existing `bin/guanaco.js` directly.
- No auto-detection of Ollama / no model downloads — the installer only wires
  the CLI; it prints a note pointing at the existing `.env.example` / README
  for model config.
- No versioning/pinning or auto-update daemon — re-run the installer to
  update. (A future `guanaco update` subcommand is out of scope.)
- No Homebrew formula / npm global publish yet (`npm link` already works for
  users with a user-writable prefix; this script is the zero-sudo path).

## Background / Key Files & Context

- `bin/guanaco.js` — the existing global entry point. It `spawn`s
  `node --env-file-if-exists=.env dist/index.js` with `cwd = process.cwd()`,
  so running it from any folder already targets that folder. The installer
  just needs to put an executable `guanaco` on `PATH` that invokes this file
  from the **installed package location** (not the user's cwd). Crucially, the
  package dir must stay built (`dist/` present) — the shim points at
  `<pkgdir>/bin/guanaco.js`, which resolves `<pkgdir>/dist/index.js`.
- `package.json` `bin` — already declares `"guanaco": "bin/guanaco.js"`. The
  installer is a user-owned alternative to `npm link` (which writes into the
  system npm prefix and often needs `sudo`).
- `npm config get prefix` on the dev box is `/usr` (root-owned), which is
  exactly why `npm link`/`npm install -g` is painful here — motivates the
  `~/.local/bin` approach.
- Node 20.6+ is required because `bin/guanaco.js` uses
  `node --env-file-if-exists`. The installer will check `node -v` and bail
  with a clear message if older.

## Target Design

### Install location: `~/.local/bin/guanaco`
`~/.local/bin` is the conventional user-owned bin dir on Linux (systemd,
freedesktop) and is commonly on `PATH` or trivially added. It needs no `sudo`.
Fallback precedence the installer tries, in order:

1. `$GUIANACO_BIN_DIR` if set;
2. first writable dir already on `PATH` (so we don't have to touch rc files);
3. `~/.local/bin` (created if missing).

Record the chosen dir into `~/.config/guanaco/install.env`
(`GUANACO_BIN_DIR=...` and `GUANACO_PKG_DIR=...`) so the uninstaller and
future re-runs are deterministic.

### The shim: a tiny launcher script
Rather than symlink `bin/guanaco.js` (a symlink would break if the repo is
moved/deleted, and `~/.local/bin` symlinks into a source tree are fragile),
the installer writes a **standalone launcher** `~/.local/bin/guanaco`:

```sh
#!/usr/bin/env bash
# Installed by guanaco-cli installer. Do not edit; rerun scripts/install.sh.
exec "/usr/bin/env" node "<GUANACO_PKG_DIR>/bin/guanaco.js" "$@"
```

- `bin/guanaco.js` already does the right thing: loads `.env` from `cwd`,
  spawns `dist/index.js` with `cwd = process.cwd()`. So the shim only needs
  to locate the package and forward args.
- Using an absolute `<GUANACO_PKG_DIR>` means the user can `cd` anywhere and
  the harness still finds the built app. The installer verifies `dist/`
  exists (builds it if missing) and bails with a clear message otherwise.
- `chmod +x` the shim.
- The shim is shell-agnostic (bash), so it works in any terminal.

### What `install.sh` does (in order)
1. `set -euo pipefail`; resolve the package dir as the script's own dir
   (`scripts/` → repo root via `$(dirname "$0")/..`), canonicalised with
   `readlink -f`/`realpath`/`pwd -P` (macOS `realpath` may be missing —
   fall back to a `cd "$(dirname "$0")/.." && pwd -P` subshell).
2. Require `node` ≥ 20.6 (`node -v` parse; bail with message if older) and
   `npm`.
3. In the package dir: `npm install --omit=dev`? — **No**: we need
   `typescript`/`tsx`? No, only `tsc` at build time which is in
   devDependencies. So `npm install` (full, to get devDeps for the build),
   then `npm run build`. Re-runs can skip `npm install` if `node_modules`
   present and `package-lock.json` unchanged (cheap `git diff --quiet` check),
   but always rebuild to pick up source changes.
4. Choose bin dir (precedence above); create it; `chmod +x`.
5. Write the shim, `chmod +x`.
6. Persist `~/.config/guanaco/install.env`.
7. If the bin dir is **not** on `PATH`, detect the user's shell rc
   (`$SHELL` → `.bashrc`/`.zshrc`; if `$SHELL` empty, prefer `.bashrc` if
   present else `.zshrc`), and append (idempotently — guard with a marker
   comment so re-runs don't duplicate):
   ```sh
   # added by guanaco-cli installer
   export PATH="$HOME/.local/bin:$PATH"
   ```
   Print: "Added ~/.local/bin to PATH in <rc>. Run `source <rc>` or open a new
   shell, then `guanaco`."
8. Smoke check: if the bin dir is on the active `PATH`, run
   `guanaco --version` (see "Version flag" below) and print the path. If not
   on `PATH` yet, just print the manual next-step.
9. Print a short "next steps" block: point at `.env.example` for
   `OLLAMA_BASE_URL`/model config, and `guanaco` + `/help` for usage.

### `uninstall.sh`
1. Read `~/.config/guanaco/install.env` for `GUANACO_BIN_DIR`.
2. Remove `"$GUANACO_BIN_DIR/guanaco"`.
3. Remove the markered `export PATH=...` block from the detected rc (sed
   delete between the marker comments; safe no-op if absent).
4. Remove `~/.config/guanaco/install.env` (leave `~/.config/guanaco` dir or
   rm it if empty).
5. Does **not** touch the cloned repo or `~/.local/bin` itself.

### npm script wrappers
Add to `package.json`:
```json
"install:cli": "bash scripts/install.sh",
"uninstall:cli": "bash scripts/uninstall.sh"
```
(Not `preinstall`/`postinstall` — those would run on every `npm install` and
surprise contributors. Keep them explicit.)

### Version flag (tiny app change)
Add a `--version`/`-v` fast-path in `src/cli.ts` (before starting the TUI) and
in `bin/guanaco.js` so the installer's smoke check and users can run
`guanaco --version` without launching the full TUI. Reads `version` from
`package.json`. Small, well-tested by a new `tests/cli.test.ts` unit (parse
args → print version → exit, no terminal).

## Key Files & Context

- `scripts/install.sh` — new. The installer.
- `scripts/uninstall.sh` — new. The uninstaller.
- `bin/guanaco.js` — add `--version` fast-path (exit before spawning the
  built app when `--version`/`-v` is the only arg).
- `src/cli.ts` — add `--version` handling at the top of `startCli` (print
  version, exit 0). Actually cleaner: handle in `src/index.ts` main() before
  building deps, so it doesn't construct Ollama/Mastra. Decide during impl.
- `package.json` — add `install:cli`/`uninstall:cli` scripts; bump nothing.
- `README.md` — new "Install" section with the one-liner and the PATH note,
  replacing/augmenting the existing `npm link` section (keep `npm link` as
  the "if you have a writable prefix" alternative).
- `~/.config/guanaco/install.env` — runtime state (gitignored, user-owned,
  not in repo).

## Implementation Steps

1. `git checkout -b feature/installer-script` *(done — this branch).*
2. Add `--version`/`-v` fast-path to `src/index.ts` (before `loadConfig`) and
   `bin/guanaco.js`, with a unit test.
3. Write `scripts/install.sh` (idempotent, `set -euo pipefail`, macOS+Linux
   path-derivation fallbacks, marker-guarded rc edit, smoke check).
4. Write `scripts/uninstall.sh` (reads install.env, removes shim + rc block +
   install.env).
5. Add `install:cli` / `uninstall:cli` npm scripts.
6. Update README "Install" section.
7. `chmod +x scripts/*.sh`; `npm run lint` (eslint won't lint `.sh`, so just
   `npm run build` + `npm test` for the TS parts); `shellcheck` the scripts
   if available.
8. Manual smoke test in a throwaway dir:
   - `bash scripts/install.sh` from the repo → `which guanaco` resolves;
   - `cd /tmp && guanaco --version` prints version from any folder;
   - `cd /tmp/empty-repo && guanaco` launches against cwd;
   - re-run installer (idempotent, no duplicate rc lines);
   - `bash scripts/uninstall.sh` → `which guanaco` gone, rc block removed.
9. Commit + push the branch; open a PR.

## Risks & Notes

- **`~/.local/bin` not on `PATH`**: handled by the rc-edit step. We never
  write to system files or require root. The markered block makes uninstall
  safe and re-runs idempotent.
- **Moving/deleting the cloned repo** breaks the shim (absolute path).
  Mitigation: the shim prints a clear "guanaco: package not found at <path> —
  re-run scripts/install.sh from the repo" message when `dist/index.js` or
  `bin/guanaco.js` is missing, instead of crashing. (Reuse the existing
  `bin/guanaco.js` "compiled app not found" guard; the shim-level check is an
  extra friendly message.)
- **macOS `realpath` missing**: use the `cd ... && pwd -P` fallback for
  resolving the package dir so the script is portable.
- **`npm install` cost on re-runs**: cheaply skipped when `node_modules`
  exists and the lockfile is unchanged; `npm run build` always runs.
- **Existing `npm link` users**: unaffected; `npm link` and this installer are
  independent paths to the same `bin/guanaco.js`. README documents both.
- **No sudo ever**: the whole design avoids the root-owned npm prefix; this
  is the primary motivation over `npm install -g`/`npm link`.