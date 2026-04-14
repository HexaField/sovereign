#!/usr/bin/env bash
# Sovereign runtime entrypoint for launchd.
# Loads repo-local env and starts the built production server.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ENTRY="$REPO_DIR/packages/server/dist/index.js"

load_env_file() {
  local file="$1"
  if [ -f "$file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$file"
    set +a
  fi
}

load_env_file "$REPO_DIR/.env"
load_env_file "$REPO_DIR/.env.local"

export HOME="${HOME:-/Users/josh}"
export PATH="/Users/josh/.nvm/versions/node/v24.4.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-5801}"
export SOVEREIGN_TLS="${SOVEREIGN_TLS:-false}"
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
