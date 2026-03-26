#!/bin/bash
# Safe rebuild script for Sovereign server
# Builds, then gracefully restarts via launchd (zero-downtime)
set -e

cd /Users/josh/workspaces/hexafield/sovereign/packages/server

echo "Building server..."
pnpm build

echo "Restarting via launchd..."
# Send SIGTERM — launchd will auto-restart with new code
PID=$(lsof -i :5801 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PID" ]; then
  kill "$PID"
  sleep 3
fi

# Verify it came back
for i in 1 2 3 4 5; do
  if curl -s "http://127.0.0.1:5801/" -o /dev/null -w "" 2>/dev/null; then
    echo "Server restarted successfully (attempt $i)"
    exit 0
  fi
  sleep 2
done

echo "WARNING: Server did not restart within 10 seconds"
exit 1
