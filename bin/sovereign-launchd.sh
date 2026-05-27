#!/usr/bin/env bash
# Sovereign runtime entrypoint for launchd.
# All configuration lives in {SOVEREIGN_DATA_DIR}/config.json —
# no .env files consulted.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ENTRY="$REPO_DIR/packages/server/dist/index.js"

export HOME="${HOME:-/Users/josh}"
export PATH="/Users/josh/.nvm/versions/node/v24.4.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NODE_ENV="${NODE_ENV:-production}"
export SOVEREIGN_DATA_DIR="${SOVEREIGN_DATA_DIR:-$REPO_DIR/packages/server/.data}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node binary not found in PATH: $PATH" >&2
  exit 1
fi

mkdir -p "$SOVEREIGN_DATA_DIR"
cd "$REPO_DIR"

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "Built server entry missing: $SERVER_ENTRY" >&2
  echo "Run 'bin/sovereign build' first." >&2
  exit 1
fi

exec "$NODE_BIN" "$SERVER_ENTRY"
