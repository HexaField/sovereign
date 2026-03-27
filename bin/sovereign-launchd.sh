#!/bin/bash
# Sovereign server launcher for launchd
# Uses tsx for direct TypeScript execution with hot-reload on file changes
# KeepAlive=true in the plist ensures auto-restart on crash

cd /Users/josh/workspaces/hexafield/sovereign/packages/server

export HOST=127.0.0.1
export PORT=5801
export SOVEREIGN_TLS=false
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789/ws
export OPENCLAW_GATEWAY_TOKEN=a21bff6d29312bc1a3775bda951a28a26480a17c485d6f3e
export OPENCLAW_WORKSPACE=/Users/josh/.openclaw/workspace
export PATH=/Users/josh/.nvm/versions/node/v24.4.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/Users/josh
export NODE_ENV=production

exec /Users/josh/workspaces/hexafield/sovereign/node_modules/.bin/tsx \
  watch \
  src/index.ts
