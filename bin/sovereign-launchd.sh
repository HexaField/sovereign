#!/usr/bin/env bash
# Sovereign runtime entrypoint for launchd.
# All configuration lives in {SOVEREIGN_CONFIG_DIR}/config.json —
# no .env files consulted. SOVEREIGN_CONFIG_DIR and SOVEREIGN_DATA_DIR are
# the only env vars consulted directly by the server.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ENTRY="$REPO_DIR/packages/server/dist/index.js"

# With HOME unset, bash expands ~ from the password database.
export HOME="${HOME:-$(cd ~ && pwd)}"
# Prefer the newest nvm-installed node, when there is one.
NVM_NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
export PATH="${NVM_NODE_BIN:+$NVM_NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NODE_ENV="${NODE_ENV:-production}"
export SOVEREIGN_CONFIG_DIR="${SOVEREIGN_CONFIG_DIR:-$HOME/.sovereign}"
export SOVEREIGN_DATA_DIR="${SOVEREIGN_DATA_DIR:-$SOVEREIGN_CONFIG_DIR/data}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node binary not found in PATH: $PATH" >&2
  exit 1
fi

mkdir -p "$SOVEREIGN_CONFIG_DIR" "$SOVEREIGN_DATA_DIR"
cd "$REPO_DIR"

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "Built server entry missing: $SERVER_ENTRY" >&2
  echo "Run 'bin/sovereign build' first." >&2
  exit 1
fi

exec "$NODE_BIN" "$SERVER_ENTRY"
