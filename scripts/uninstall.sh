#!/usr/bin/env bash
# Uninstall the `guanaco` shim installed by scripts/install.sh.
# Removes the shim, the markered PATH block from your shell rc, and the
# install.env state file. Does NOT touch the cloned repo or ~/.local/bin.
set -euo pipefail

CONFIG_DIR="$HOME/.config/guanaco"
STATE="$CONFIG_DIR/install.env"

if [ ! -f "$STATE" ]; then
  echo "guanaco uninstall: no install record found at $STATE — nothing to do." >&2
  exit 0
fi

# Read install state.
BIN_DIR=""
PKG_DIR=""
# shellcheck disable=SC1090
while IFS='=' read -r key val; do
  case "$key" in
    GUANACO_BIN_DIR) BIN_DIR="$val" ;;
    GUANACO_PKG_DIR) PKG_DIR="$val" ;;
  esac
done <"$STATE"

# ── remove the shim ──────────────────────────────────────────────────────────
if [ -n "$BIN_DIR" ] && [ -f "$BIN_DIR/guanaco" ]; then
  rm -f "$BIN_DIR/guanaco"
  echo "Removed: $BIN_DIR/guanaco"
else
  echo "Shim already gone (BIN_DIR=$BIN_DIR)."
fi

# ── remove the markered PATH block from shell rc ────────────────────────────
remove_block() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  # Delete from the start marker to the end marker, inclusive. Safe if absent.
  if grep -q '# added by guanaco-cli installer' "$rc" 2>/dev/null; then
    # Use a temp file + sed -i portably (macOS sed needs -i '').
    local tmp
    tmp=$(mktemp)
    sed '/# added by guanaco-cli installer/,/# end guanaco-cli installer/d' "$rc" >"$tmp"
    mv "$tmp" "$rc"
    echo "Removed PATH block from $rc"
  fi
}

case "${SHELL:-}" in
  */zsh) remove_block "$HOME/.zshrc" ;;
  */bash) remove_block "$HOME/.bashrc" ;;
  *) remove_block "$HOME/.bashrc"; remove_block "$HOME/.zshrc" ;;
esac

# ── remove install state ─────────────────────────────────────────────────────
rm -f "$STATE"
if [ -d "$CONFIG_DIR" ] && [ -z "$(ls -A "$CONFIG_DIR" 2>/dev/null)" ]; then
  rmdir "$CONFIG_DIR" 2>/dev/null || true
fi
echo "Removed: $STATE"

echo ""
echo "Uninstalled. The package checkout at ${PKG_DIR:-<unknown>} is untouched."
echo "Open a new shell for PATH changes to take effect."