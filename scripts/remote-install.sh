#!/usr/bin/env bash
# Remote installer for guanaco-cli — meant to be curl-piped:
#
#   curl -fsSL https://raw.githubusercontent.com/dchu3/guanaco-cli/main/scripts/remote-install.sh | bash
#
# (To audit first: curl -fsSL …/remote-install.sh -o /tmp/guanaco-install.sh && less /tmp/guanaco-install.sh && bash /tmp/guanaco-install.sh)
#
# It clones the repo to a managed dir (default ~/.local/share/guanaco-cli) and
# runs scripts/install.sh, which builds the app and puts a `guanaco` shim on
# PATH. After that, `guanaco update` keeps the install fresh (it pulls this
# clone and rebuilds).
#
# Environment overrides:
#   GUIANACO_REPO  git URL to clone from  (default: the public GitHub repo)
#   GUIANACO_REF   branch or tag to pin   (default: main)
#   GUIANACO_HOME  clone/install dir      (default: ~/.local/share/guanaco-cli)
#   GUIANACO_BIN_DIR  passed through to install.sh (its own bin dir)
set -euo pipefail

REPO="${GUIANACO_REPO:-https://github.com/dchu3/guanaco-cli.git}"
REF="${GUANACO_REF:-main}"
HOME_DIR="${GUIANACO_HOME:-$HOME/.local/share/guanaco-cli}"

# ── toolchain checks ────────────────────────────────────────────────────────
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "guanaco remote-install: '$1' is required. Install it and re-run." >&2
    exit 1
  fi
}
need git
need node
need npm
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "guanaco remote-install: Node >= 20.6 is required (found $(node -v))." >&2
  exit 1
fi

# ── obtain/refresh the source tree ──────────────────────────────────────────
if [ -d "$HOME_DIR/.git" ]; then
  # Re-run on an existing managed clone: refuse to clobber local edits.
  if ! git -C "$HOME_DIR" diff --quiet || ! git -C "$HOME_DIR" diff --cached --quiet; then
    echo "guanaco remote-install: $HOME_DIR has local changes — aborting to avoid clobbering." >&2
    echo "Commit/stash them, or remove the dir and re-run." >&2
    git -C "$HOME_DIR" status --short >&2 || true
    exit 1
  fi
  echo "→ Refreshing existing clone at $HOME_DIR (ref: $REF)"
  git -C "$HOME_DIR" fetch origin --tags --quiet
  # Checkout the requested ref (branch or tag); fail clearly if it doesn't exist.
  if ! git -C "$HOME_DIR" checkout "$REF" --quiet 2>/dev/null; then
    echo "guanaco remote-install: ref '$REF' not found in $REPO." >&2
    exit 1
  fi
  # Fast-forward / hard-sync to the remote ref (the dir is app-managed, not user code).
  git -C "$HOME_DIR" reset --hard "origin/$REF" --quiet 2>/dev/null || true
else
  echo "→ Cloning $REPO (ref: $REF) into $HOME_DIR"
  if ! git clone --quiet --branch "$REF" "$REPO" "$HOME_DIR" 2>/dev/null; then
    # Fall back to a full clone + checkout (handles some ref/transport edge cases).
    git clone --quiet "$REPO" "$HOME_DIR"
    if ! git -C "$HOME_DIR" checkout "$REF" --quiet 2>/dev/null; then
      echo "guanaco remote-install: ref '$REF' not found in $REPO." >&2
      exit 1
    fi
  fi
fi

INSTALL_SH="$HOME_DIR/scripts/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
  echo "guanaco remote-install: $INSTALL_SH not found — is this a guanaco-cli checkout?" >&2
  exit 1
fi

echo "→ Running installer (builds the app + installs the 'guanaco' shim)…"
# Pass GUIANACO_BIN_DIR through so users can steer the bin location.
export GUIANACO_BIN_DIR="${GUIANACO_BIN_DIR:-}"
bash "$INSTALL_SH"