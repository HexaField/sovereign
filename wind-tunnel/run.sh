#!/usr/bin/env bash
# Sovereign Wind Tunnel — entry point.
#
# Usage:
#   ./wind-tunnel/run.sh                          # build + run all
#   ./wind-tunnel/run.sh --scenario s1            # run one scenario
#   ./wind-tunnel/run.sh --scenario s1,s3         # run specific scenarios
#   ./wind-tunnel/run.sh --no-build               # skip docker build
#   ./wind-tunnel/run.sh --keep                   # keep containers after run
#   ./wind-tunnel/run.sh --native                 # use already-running services
#
# Environment:
#   SOVEREIGN_URL   — override sovereign endpoint (default: http://localhost:5811)
#   MOCK_LLM_URL    — override mock LLM endpoint (default: http://localhost:8900)

set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="docker/docker-compose.yml"
NO_BUILD=false
KEEP=false
NATIVE=false
AD4M=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)  NO_BUILD=true; shift ;;
    --keep)      KEEP=true; shift ;;
    --native)    NATIVE=true; shift ;;
    --ad4m)      AD4M=true; shift ;;
    *)           EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# ad4m lane: overlay the ad4m node + provision step, and point the s10 scenario
# at the node's host-exposed MCP. Needs an ad4m executor image (AD4M_EXEC_IMAGE,
# default ad4m-test:latest); s10 self-skips if the node is unreachable.
#
# The ad4m lane runs s10 by itself by default. s9 restarts the Sovereign
# container mid-suite; s10's waker then races that reconnect, so the two do not
# share one Sovereign instance. Run the base suite (s1–s9) via plain ./run.sh,
# the ad4m lane via ./run.sh --ad4m. Pass an explicit --scenario to override.
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ "$AD4M" == "true" ]]; then
  COMPOSE_ARGS+=(-f "docker/docker-compose.ad4m.yml")
  # Default the ad4m lane to s10 unless the caller chose scenarios explicitly.
  if [[ ! " ${EXTRA_ARGS[*]} " == *" --scenario "* ]]; then
    EXTRA_ARGS+=(--scenario s10)
  fi
  export AD4M_MCP_URL="${AD4M_MCP_URL:-http://localhost:14561}"
  export AD4M_PROVISION_FILE="${AD4M_PROVISION_FILE:-$(pwd)/ad4m/.provision/provision.json}"
  # Fresh Sovereign data per run. The bind mount below IS Sovereign's whole
  # /data/data, so a prior run's sessions + ad4m watch list would otherwise
  # persist — a stale watched perspective churns 404s after s9's restart and
  # delays the current mention's detection past s10's window. Clear via a root
  # container (the provision + sovereign containers write it as root).
  mkdir -p ad4m/.provision
  docker run --rm -v "$(pwd)/ad4m/.provision:/d" alpine:latest \
    sh -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null || true' >/dev/null 2>&1 || true
fi

# Install deps if needed
if [[ ! -d "node_modules" ]]; then
  echo "📦 Installing wind-tunnel dependencies..."
  npm install --no-audit --no-fund 2>/dev/null
fi

if [[ "$NATIVE" == "true" ]]; then
  # Run against already-running services (no Docker)
  echo "🔗 Native mode — using existing services"
  SOVEREIGN_URL="${SOVEREIGN_URL:-http://localhost:5811}"
  MOCK_LLM_URL="${MOCK_LLM_URL:-http://localhost:8900}"

  exec npx tsx src/main.ts \
    --sovereign-url "$SOVEREIGN_URL" \
    --mock-llm-url "$MOCK_LLM_URL" \
    "${EXTRA_ARGS[@]}"
fi

# Docker mode
cleanup() {
  if [[ "$KEEP" == "false" ]]; then
    echo ""
    echo "🧹 Tearing down containers..."
    docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans 2>/dev/null || true
  else
    echo ""
    echo "🔒 Keeping containers (--keep). Stop with:"
    echo "   docker compose ${COMPOSE_ARGS[*]} down -v (from wind-tunnel/)"
  fi
}
trap cleanup EXIT

# Build images
if [[ "$NO_BUILD" == "false" ]]; then
  echo "🔨 Building Docker images..."
  docker compose "${COMPOSE_ARGS[@]}" build
fi

# Start services
echo "🚀 Starting services..."
docker compose "${COMPOSE_ARGS[@]}" up -d

# Wait for health
echo "⏳ Waiting for services to become healthy..."
TIMEOUT=$([[ "$AD4M" == "true" ]] && echo 240 || echo 120)
ELAPSED=0
while ! docker compose "${COMPOSE_ARGS[@]}" ps --format json 2>/dev/null \
    | grep -q '"Health":"healthy".*sovereign'; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo "❌ Sovereign failed to become healthy within ${TIMEOUT}s"
    docker compose "${COMPOSE_ARGS[@]}" logs sovereign | tail -30
    exit 1
  fi
done
echo "✓ Services healthy"
echo ""

# Run scenarios
npx tsx src/main.ts \
  --sovereign-url "http://localhost:5811" \
  --mock-llm-url "http://localhost:8900" \
  "${EXTRA_ARGS[@]}"
