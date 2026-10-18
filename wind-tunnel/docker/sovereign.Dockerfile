# Sovereign wind-tunnel test image.
# Builds from source and runs headlessly with mock LLM endpoints.
#
#   docker build -f wind-tunnel/docker/sovereign.Dockerfile -t swt-sovereign .
#
# Run context: repo root (so COPY . gets the full monorepo).

FROM node:22-bookworm AS build

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy everything — monorepo packages change together so fine-grained
# cache layers offer diminishing returns vs maintenance cost.
COPY . .

# Install with dev deps (needed for build tooling).
# Force node-pty rebuild for linux-x64.
RUN NODE_ENV=development pnpm install --no-frozen-lockfile && \
    cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty && \
    npx node-gyp rebuild 2>/dev/null || true

# Build all server-side packages.
# Client build skipped — headless tests don't serve the UI.
RUN pnpm -r --filter '!@sovereign/client' build

# The codegraph CLI ships inside the @colbymchenry/codegraph dependency (with its
# own Node). No telemetry from the image.
ENV DO_NOT_TRACK=1

# Graphcoder fixture (s48): graphcoder-server's tiny-ts project, committed and
# indexed here, where git exists (the runtime image has none).
RUN mkdir -p /app/.wt-fixtures/graphcoder && \
    cp -r packages/graphcoder-server/test-fixtures/tiny-ts /app/.wt-fixtures/graphcoder/tiny-ts && \
    cd /app/.wt-fixtures/graphcoder/tiny-ts && \
    git init -q -b main && git add -A && \
    git -c user.email=wt@example.com -c user.name=wt commit -qm fixture && \
    /app/packages/graphcoder-server/node_modules/.bin/codegraph init .

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate && \
    apt-get update && apt-get install -y --no-install-recommends curl python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Stub out optional native deps that the server imports but the wind
# tunnel does not exercise.
ENV CHROME_PATH=/bin/true
ENV SEMBLE_MCP=off
# The bundled codegraph CLI on PATH: the code index (and through it Graphcoder)
# runs it; without it the code index stays off. Sessions keep the tool set they
# had before it was reachable: no codegraph MCP server.
ENV PATH=/app/packages/graphcoder-server/node_modules/.bin:$PATH
ENV CODEGRAPH_MCP=off
ENV DO_NOT_TRACK=1
# Let the Claude Code SDK run as root inside the container.
ENV IS_SANDBOX=1

COPY --from=build /app /app

# Config + data dirs for headless operation
RUN mkdir -p /data/config /data/data
COPY wind-tunnel/docker/config.json /data/config/config.json

ENV SOVEREIGN_CONFIG_DIR=/data/config
ENV SOVEREIGN_DATA_DIR=/data/data
ENV HOST=0.0.0.0
ENV PORT=5801

# The mock LLM URL gets injected via docker-compose or run args.
ENV ANTHROPIC_API_KEY=sk-ant-mock-key-wind-tunnel
# ANTHROPIC_BASE_URL set by compose

EXPOSE 5801

HEALTHCHECK --interval=2s --timeout=3s --retries=15 \
  CMD curl -sf http://localhost:5801/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
