#!/usr/bin/env bash
# Install guanaco-cli so the `guanaco` command runs from any folder.
#
# Idempotent: re-running rebuilds and refreshes the shim. Never needs sudo —
# it installs into a user-owned bin dir (default ~/.local/bin) and, if that
# dir isn't on PATH, appends a markered export to your shell rc.
set -euo pipefail

# ── resolve the package directory (this script's dir/..), portably ──────────
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
PKG_DIR=$(cd "$SCRIPT_DIR/.." && pwd -P)

if [ ! -f "$PKG_DIR/package.json" ] || [ ! -f "$PKG_DIR/bin/guanaco.js" ]; then
  echo "guanaco install: could not locate the package at $PKG_DIR" >&2
  echo "Run scripts/install.sh from a checkout of the guanaco-cli repo." >&2
  exit 1
fi

# ── toolchain checks ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "guanaco install: 'node' is required (>= 20.6). Install Node.js first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "guanaco install: 'npm' is required. Install Node.js first." >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "guanaco install: Node >= 20.6 is required (found $(node -v))." >&2
  exit 1
fi

# ── build the app ────────────────────────────────────────────────────────────
echo "→ Installing dependencies (this can take a minute on first run)…"
# Skip the npm install if node_modules is fresh and the lockfile is unchanged.
if [ ! -d "$PKG_DIR/node_modules" ]; then
  (cd "$PKG_DIR" && npm install)
else
  (cd "$PKG_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 || npm install)
fi
echo "→ Building the app…"
(cd "$PKG_DIR" && npm run build)

ENTRY="$PKG_DIR/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "guanaco install: build failed — $ENTRY not found after 'npm run build'." >&2
  exit 1
fi

# ── choose a user-owned bin dir (precedence; never root) ───────────────────
BIN_DIR=""
if [ -n "${GUIANACO_BIN_DIR:-}" ] && [ -d "$GUIANACO_BIN_DIR" ] && [ -w "$GUIANACO_BIN_DIR" ]; then
  BIN_DIR="$GUIANACO_BIN_DIR"
fi
if [ -z "$BIN_DIR" ]; then
  # First writable directory already on PATH (so we don't have to touch rc).
  IFS=':' read -r -a PATH_DIRS <<<"$PATH"
  for d in "${PATH_DIRS[@]}"; do
    if [ -n "$d" ] && [ -d "$d" ] && [ -w "$d" ]; then
      BIN_DIR="$d"
      break
    fi
  done
fi
if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

# ── write the launcher shim ─────────────────────────────────────────────────
SHIM="$BIN_DIR/guanaco"
cat >"$SHIM" <<EOF
#!/usr/bin/env bash
# Installed by guanaco-cli installer. Do not edit; rerun scripts/install.sh.
# Resolves the package at a fixed absolute path so 'guanaco' works from any cwd.
PKG_DIR="$PKG_DIR"
if [ ! -f "\$PKG_DIR/bin/guanaco.js" ] || [ ! -f "\$PKG_DIR/dist/index.js" ]; then
  echo "guanaco: package not found at \$PKG_DIR." >&2
  echo "Re-run scripts/install.sh from the guanaco-cli repo, or update GUIANACO_PKG_DIR." >&2
  exit 1
fi
exec /usr/bin/env node "\$PKG_DIR/bin/guanaco.js" "\$@"
EOF
chmod +x "$SHIM"

# ── record install state for uninstall + re-runs ───────────────────────────
CONFIG_DIR="$HOME/.config/guanaco"
mkdir -p "$CONFIG_DIR"
cat >"$CONFIG_DIR/install.env" <<EOF
# Written by guanaco-cli installer. Used by scripts/uninstall.sh.
GUANACO_BIN_DIR=$BIN_DIR
GUANACO_PKG_DIR=$PKG_DIR
EOF

# ── PATH fixup (only if needed) ──────────────────────────────────────────────
on_path=false
case ":$PATH:" in
  *":$BIN_DIR:"*) on_path=true ;;
esac

if [ "$on_path" = false ]; then
  rc=""
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) if [ -f "$HOME/.bashrc" ]; then rc="$HOME/.bashrc"; elif [ -f "$HOME/.zshrc" ]; then rc="$HOME/.zshrc"; fi ;;
  esac
  if [ -n "$rc" ]; then
    # Idempotent: a markered block we can safely delete on uninstall.
    if ! grep -q '# added by guanaco-cli installer' "$rc" 2>/dev/null; then
      {
        printf '\n# added by guanaco-cli installer\n'
        printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
        printf '# end guanaco-cli installer\n'
      } >>"$rc"
    fi
    echo "→ Added $BIN_DIR to PATH in $rc"
    echo "  Run:  source $rc   (or open a new shell)"
  else
    echo "→ No shell rc found; add $BIN_DIR to your PATH manually."
  fi
fi

# ── smoke check ────────────────────────────────────────────────────────────
echo ""
echo "Installed: $SHIM  →  $PKG_DIR"
if [ "$on_path" = true ]; then
  if "$SHIM" --version >/dev/null 2>&1; then
    echo "Smoke check: guanaco --version → $("$SHIM" --version 2>/dev/null || echo '?')"
  else
    echo "Smoke check: 'guanaco --version' failed; check that Node can run the shim." >&2
  fi
  echo ""
  echo "Now from ANY folder:"
  echo "  cd /path/to/your-repo && guanaco"
else
  echo "Open a new shell (or source your rc), then from ANY folder:"
  echo "  cd /path/to/your-repo && guanaco"
fi
echo ""
echo "Configure models via a .env in the folder you run from (see .env.example)."
echo "Uninstall with: bash scripts/uninstall.sh"