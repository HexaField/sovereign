#!/bin/bash
# Sovereign server launcher for launchd
# KeepAlive=true in the plist ensures auto-restart on crash

cd /Users/josh/workspaces/hexafield/sovereign/packages/server

export HOST=127.0.0.1
export PORT=5801
export SOVEREIGN_TLS=false

exec /Users/josh/.nvm/versions/node/v24.4.1/bin/node \
  --env-file=.env.local \
  dist/index.js
