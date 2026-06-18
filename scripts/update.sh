#!/usr/bin/env bash
# Update an existing guanaco-cli install.
#
# Reads ~/.config/guanaco/install.env for the package dir, refuses to pull
# over uncommitted local changes, runs `git pull --ff-only`, then rebuilds and
# refreshes the shim via scripts/install.sh (idempotent — won't duplicate the
# PATH block). No sudo; never force-pulls over local edits.
set -euo pipefail

STATE="$HOME/.config/guanaco/install.env"
if [ ! -f "$STATE" ]; then
  echo "guanaco update: no install record at $STATE." >&2
  echo "Run scripts/install.sh first (or update manually: git pull && npm run build)." >&2
  exit 1
fi

PKG_DIR=""
while IFS='=' read -r key val; do
  case "$key" in
    GUANACO_PKG_DIR) PKG_DIR="$val" ;;
  esac
done <"$STATE"

if [ -z "$PKG_DIR" ] || [ ! -d "$PKG_DIR" ]; then
  echo "guanaco update: install record points at a missing dir: '$PKG_DIR'." >&2
  exit 1
fi
if [ ! -f "$PKG_DIR/scripts/install.sh" ]; then
  echo "guanaco update: $PKG_DIR is not a guanaco-cli checkout (no scripts/install.sh)." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "guanaco update: 'git' is required." >&2
  exit 1
fi

# Refuse to pull over uncommitted local changes (tracked files only).
if ! git -C "$PKG_DIR" diff --quiet || ! git -C "$PKG_DIR" diff --cached --quiet; then
  echo "guanaco update: $PKG_DIR has local changes — commit or stash them first:" >&2
  git -C "$PKG_DIR" status --short >&2 || true
  exit 1
fi

echo "→ Pulling latest in $PKG_DIR"
git -C "$PKG_DIR" pull --ff-only

echo "→ Rebuilding and refreshing the shim"
bash "$PKG_DIR/scripts/install.sh"

echo ""
echo "Updated. Run 'guanaco --version' to confirm."