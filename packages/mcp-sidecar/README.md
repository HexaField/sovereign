# @sovereign/mcp-sidecar

Standalone MCP server daemon. Decouples Sovereign's MCP tool catalog from the main daemon's lifecycle.

## Why a sidecar?

Sovereign's in-process MCP server (`createSovereignMcpServer` in `@sovereign/agent-backend`) is the path Claude Code SDK sessions hosted inside the Sovereign daemon use by default. It's fast (zero serialisation) but its lifetime is tied to the daemon: `bin/sovereign build` reloads the daemon, the in-process MCP instance dies with it, the SDK sees "sovereign disconnected," and the deferred-tool catalog goes through a re-discovery cycle.

The sidecar exposes the same 16 tools over **MCP Streamable HTTP** at a stable URL (default `http://127.0.0.1:5802/api/mcp`). Each tool handler forwards to a new `POST /api/mcp-rpc/:tool` endpoint on the Sovereign daemon, where the existing `SovereignToolDeps` bag executes the call. The sidecar holds no business logic and zero `@sovereign/*` deps — every tool body is a ~5-line HTTP fetch.

Result:

| Scenario                          | In-process                    | Sidecar                                         |
| --------------------------------- | ----------------------------- | ----------------------------------------------- |
| Latency per call                  | ~µs                           | ~1 ms loopback                                  |
| Tool catalog when daemon is up    | available                     | available                                       |
| Tool catalog when daemon restarts | **lost until reconnect**      | **preserved** (calls fail until daemon is back) |
| Surviving SDK compact events      | needs PostCompact rehydration | needs PostCompact rehydration                   |

The compact rehydration fix is implemented separately in `packages/agent-backend/src/claude-code/claude-code.ts` (PostCompact hook calls `liveQuery.setMcpServers(mcpServers)`).

## Architecture

```
┌─ Claude Code SDK ────────────────────────────────────┐
│                                                      │
│   sdkOptions.mcpServers.sovereign =                  │
│     { type: 'http', url: 'http://127.0.0.1:5802/' }  │
└──────────────┬───────────────────────────────────────┘
               │ MCP over HTTP (stable URL across daemon restarts)
               ▼
┌─ com.sovereign.mcp (this package) ───────────────────┐
│                                                      │
│  POST /api/mcp        ─ Streamable HTTP transport    │
│  GET  /api/mcp/health ─ liveness probe               │
│                                                      │
│  Tool handlers:  fetch(SOVEREIGN_URL + '/api/mcp-rpc/<tool>')
└──────────────┬───────────────────────────────────────┘
               │ HTTP RPC (15 tools today)
               ▼
┌─ com.sovereign.server ───────────────────────────────┐
│                                                      │
│  POST /api/mcp-rpc/:tool                             │
│    → buildHandlers(deps)[tool](args)                 │
│    → existing SovereignToolDeps bag                  │
│      (cron / sessions / agents / browser / …)        │
└──────────────────────────────────────────────────────┘
```

## Adoption

Default behaviour is unchanged: the in-process MCP server remains the fallback. To route in-daemon SDK sessions through the sidecar, set:

```sh
export SOVEREIGN_MCP_HTTP_URL=http://127.0.0.1:5802/api/mcp
```

before launching Sovereign (or add it to the LaunchAgent plist's `EnvironmentVariables`). The wiring switch lives in `packages/agent-backend/src/claude-code/claude-code.ts` and only applies when the env var is set.

External Claude Code clients (terminal `claude`, IDE plugins) can adopt the sidecar URL directly without any Sovereign-side change:

```sh
claude mcp add --transport http sovereign http://127.0.0.1:5802/api/mcp
```

## Install (per-machine)

```sh
# 1. Build everything (in particular `packages/mcp-sidecar/dist/`).
bin/sovereign build

# 2. Render + install the LaunchAgent plist (placeholders → real paths).
#    A `bin/sovereign install-mcp` helper would do this; for now:
sed -e "s|MCP_LAUNCH_SCRIPT_PLACEHOLDER|$(pwd)/bin/sovereign-mcp-launchd.sh|g" \
    -e "s|REPO_DIR_PLACEHOLDER|$(pwd)|g" \
    -e "s|MCP_STDOUT_LOG_PLACEHOLDER|$HOME/.sovereign/data/logs/sovereign-mcp.stdout.log|g" \
    -e "s|MCP_STDERR_LOG_PLACEHOLDER|$HOME/.sovereign/data/logs/sovereign-mcp.stderr.log|g" \
    support/com.sovereign.mcp.plist > ~/Library/LaunchAgents/com.sovereign.mcp.plist
launchctl load ~/Library/LaunchAgents/com.sovereign.mcp.plist

# 3. Verify.
curl -fsS http://127.0.0.1:5802/api/mcp/health | jq
curl -fsS http://127.0.0.1:5801/api/mcp-rpc | jq   # tool catalog on the daemon side
```

## Tool surface

The sidecar must mirror exactly what `agent-backend`'s `mcp-server.ts` defines. Drift between the two would mean the sidecar publishes a tool the daemon can't execute, or vice versa. CI should diff the schemas.

Currently mirrored:

`cron_create` · `cron_list` · `cron_delete` · `sessions_list` · `sessions_send` · `sessions_history` · `agents_list` · `agents_spawn` · `browser_open` · `browser_act` · `browser_close` · `notifications_send` · `read_meeting` · `create_issue` · `update_planning_node` · `list_orgs`

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `SOVEREIGN_MCP_PORT` | `5802` | Listen port. |
| `SOVEREIGN_MCP_HOST` | `127.0.0.1` | Bind address. Keep loopback. |
| `SOVEREIGN_URL` | `http://127.0.0.1:5801` | Upstream daemon URL. |
| `SOVEREIGN_MCP_RPC_SECRET` | unset | Shared secret. When set, sent as `X-Sovereign-Mcp-Secret` and required by the daemon. |
