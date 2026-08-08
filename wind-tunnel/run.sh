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
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)  NO_BUILD=true; shift ;;
    --keep)      KEEP=true; shift ;;
    --native)    NATIVE=true; shift ;;
    *)           EXTRA_ARGS+=("$1"); shift ;;
  esac
done

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
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
  else
    echo ""
    echo "🔒 Keeping containers (--keep). Stop with:"
    echo "   docker compose -f wind-tunnel/$COMPOSE_FILE down -v"
  fi
}
trap cleanup EXIT

# Build images
if [[ "$NO_BUILD" == "false" ]]; then
  echo "🔨 Building Docker images..."
  docker compose -f "$COMPOSE_FILE" build
fi

# Start services
echo "🚀 Starting services..."
docker compose -f "$COMPOSE_FILE" up -d

# Wait for health
echo "⏳ Waiting for services to become healthy..."
TIMEOUT=120
ELAPSED=0
while ! docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null \
    | grep -q '"Health":"healthy".*sovereign'; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo "❌ Sovereign failed to become healthy within ${TIMEOUT}s"
    docker compose -f "$COMPOSE_FILE" logs sovereign | tail -30
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
