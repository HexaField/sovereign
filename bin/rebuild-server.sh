#!/bin/bash
# Safe rebuild script for Sovereign
# Guarded: only restarts server if builds succeed

set -e
cd /Users/josh/workspaces/hexafield/sovereign

echo "Type-checking server..."
cd packages/server && pnpm check
echo "Server type-check: ✅ passed"
cd ../..

echo ""
echo "Building server..."
cd packages/server && pnpm build
echo "Server built: ✅"
cd ../..

echo ""
echo "Building client..."
cd packages/client && pnpm build
echo "Client built: ✅"
cd ../..

echo ""
echo "All builds passed. Restarting server..."

# tsx watch auto-reloads on source changes, but compiled output changed — force restart
if launchctl list com.sovereign.server &>/dev/null; then
  launchctl unload ~/Library/LaunchAgents/com.sovereign.server.plist 2>/dev/null
  sleep 1
  launchctl load ~/Library/LaunchAgents/com.sovereign.server.plist
  sleep 5
  if curl -s "http://127.0.0.1:5801/" -o /dev/null 2>/dev/null; then
    echo "Server: ✅ restarted"
  else
    echo "Server: ❌ FAILED TO START after rebuild"
    exit 1
  fi
else
  echo "Server not running via launchd — restart manually or tsx watch will pick up changes."
fi
