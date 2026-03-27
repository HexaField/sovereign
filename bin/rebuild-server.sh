#!/bin/bash
# Safe rebuild script for Sovereign server
# Builds, then gracefully restarts via launchd (zero-downtime goal)
set -e

cd /Users/josh/workspaces/hexafield/sovereign/packages/server

echo "Building server..."
pnpm build

echo "Restarting via launchd..."
PID=$(lsof -i :5801 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null
fi

# Wait for launchd to restart, with fallback to manual reload
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -s "http://127.0.0.1:5801/" -o /dev/null 2>/dev/null; then
    echo "Server restarted successfully (attempt $i)"
    exit 0
  fi
done

# Fallback: force unload/reload
echo "Auto-restart failed, forcing launchd reload..."
launchctl unload ~/Library/LaunchAgents/com.sovereign.server.plist 2>/dev/null
sleep 1
launchctl load ~/Library/LaunchAgents/com.sovereign.server.plist
sleep 5

if curl -s "http://127.0.0.1:5801/" -o /dev/null 2>/dev/null; then
  echo "Server restarted via forced reload"
  exit 0
fi

echo "ERROR: Server did not restart"
exit 1
