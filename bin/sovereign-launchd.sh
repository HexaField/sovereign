#!/bin/bash
# Sovereign server launcher for launchd
# Loads env from .env.local, starts the server

cd /Users/josh/workspaces/hexafield/sovereign

exec /Users/josh/.nvm/versions/node/v24.4.1/bin/node \
  --env-file=.env.local \
  packages/server/dist/index.js
