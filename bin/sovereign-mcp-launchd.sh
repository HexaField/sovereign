#!/usr/bin/env bash
# launchd entrypoint for com.sovereign.mcp — the standalone MCP server.
# Lives in its own process so a Sovereign rebuild leaves the SDK's tool
# catalog intact (the URL stays stable, the SDK reconnects in place).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MCP_ENTRY="$REPO_DIR/packages/mcp-sidecar/bin/sovereign-mcp.mjs"

export HOME="${HOME:-/Users/josh}"
export PATH="/Users/josh/.nvm/versions/node/v24.4.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NODE_ENV="${NODE_ENV:-production}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node binary not found in PATH: $PATH" >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/packages/mcp-sidecar/dist/index.js" ]; then
  echo "MCP sidecar dist missing — run 'bin/sovereign build' first." >&2
  exit 1
fi

cd "$REPO_DIR"
exec "$NODE_BIN" "$MCP_ENTRY"
