#!/usr/bin/env bash
#
# Sovereign watchdog — independent health monitor + self-heal.
#
# Runs on a launchd StartInterval (job: com.sovereign.watchdog), separate from
# the server job. Because it's independent, it can recover the server even when
# the server's own launchd job has been unloaded — KeepAlive only revives a
# *loaded* job, so an unloaded job is exactly the failure this guards against
# (see the 2026-06-04 outage).
#
# Each tick:
#   1. If the operator intentionally stopped the service (pause sentinel), do
#      nothing — the watchdog must not fight a deliberate `sovereign stop`.
#   2. If /health responds, do nothing.
#   3. Otherwise run `sovereign start`, which reaps orphans, installs the plist,
#      and bootstraps (or kickstarts) the service, then verifies health.
#
# All stdout/stderr is captured by the plist into data/logs/watchdog.log.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOVEREIGN="$REPO_DIR/bin/sovereign"

# launchd hands us a minimal environment — mirror sovereign-launchd.sh so the
# CLI resolves node, the config/data dirs, and therefore the health port.
export HOME="${HOME:-/Users/josh}"
export PATH="/Users/josh/.nvm/versions/node/v24.4.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export SOVEREIGN_CONFIG_DIR="${SOVEREIGN_CONFIG_DIR:-$HOME/.sovereign}"
export SOVEREIGN_DATA_DIR="${SOVEREIGN_DATA_DIR:-$SOVEREIGN_CONFIG_DIR/data}"

PAUSE_FILE="$SOVEREIGN_DATA_DIR/watchdog.paused"

_ts()  { date '+%Y-%m-%dT%H:%M:%S%z'; }
_log() { printf '%s [watchdog] %s\n' "$(_ts)" "$*"; }

# 1. Respect an intentional stop. Stay quiet so the log isn't spammed every 60s
#    while the service is deliberately down.
if [ -f "$PAUSE_FILE" ]; then
  exit 0
fi

# 2. Healthy? Nothing to do. `sovereign health` is a fast curl with a 2s cap.
if "$SOVEREIGN" health >/dev/null 2>&1; then
  exit 0
fi

# 3. Unhealthy and not intentionally stopped — heal. `start` is idempotent:
#    reaps orphans, installs the plist, bootstraps if unloaded or kickstarts if
#    loaded-but-unhealthy, then waits for health.
_log "health check FAILED — attempting recovery"
if "$SOVEREIGN" start; then
  _log "recovery succeeded — service healthy"
else
  _log "recovery FAILED — inspect $SOVEREIGN_DATA_DIR/logs/sovereign.stderr.log"
  exit 1
fi
