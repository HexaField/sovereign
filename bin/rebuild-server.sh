#!/bin/bash
# Safe rebuild script for Sovereign
# Server runs via tsx watch — source changes auto-reload (no restart needed)
# Client needs explicit build

set -e
cd /Users/josh/workspaces/hexafield/sovereign

echo "Building client..."
cd packages/client && pnpm build
echo "Client built."

echo ""
echo "Server runs via tsx watch — source changes auto-reload."
echo "If server needs a hard restart: launchctl unload/load com.sovereign.server.plist"

# Verify server is still up
if curl -s "http://127.0.0.1:5801/" -o /dev/null 2>/dev/null; then
  echo "Server: ✅ running"
else
  echo "Server: ❌ not responding, forcing reload..."
  launchctl unload ~/Library/LaunchAgents/com.sovereign.server.plist 2>/dev/null
  sleep 1
  launchctl load ~/Library/LaunchAgents/com.sovereign.server.plist
  sleep 5
  if curl -s "http://127.0.0.1:5801/" -o /dev/null 2>/dev/null; then
    echo "Server: ✅ restarted"
  else
    echo "Server: ❌ FAILED TO START"
    exit 1
  fi
fi
