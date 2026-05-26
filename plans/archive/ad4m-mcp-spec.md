# Plan: AD4M Integration for Sovereign

**Date:** 2026-05-26  
**Status:** Implemented  
**Scope:** `@sovereign/ad4m` native package, Sovereign service/route/WS layer, authenticated MCP proxy to the AD4M executor's native MCP server

---

## Goal

Deeply integrate AD4M into Sovereign as a first-class native module — event bus waker, REST routes, WS channel, and notification bridge — and expose AD4M's full capability surface to AI runtimes via a transparent authenticated proxy to the AD4M executor's own MCP server.

The AI runtime layer is deliberately kept out of this design. Sovereign does not need to know which AI runtime is in use, and the AI runtime does not need to know it is talking to AD4M. The integration surface is:

```
Sovereign ↔ AD4M     (deep, native — this spec)
AI Runtime ↔ AD4M executor's native MCP   (proxied through Sovereign — auth injected)
```

AD4M is currently running on `field@192.168.1.199:12000` (WebSocket RPC, multi-user mode).

---

## Non-Goals

- Modifying any AI runtime adapter code (`agent-backend`, `SovereignToolDeps`, etc.)
- Reimplementing AD4M's MCP tool surface — the executor already exposes it natively
- Replacing the ADAM Launcher UI
- Direct Holochain DHT operations (use AD4M's language layer)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   field@192.168.1.199                             │
│                                                                    │
│  AD4M Executor                                                     │
│  ├── WebSocket RPC  ws://localhost:12000/api/v1/ws  (JWT auth)    │
│  └── MCP server     http://localhost:12000/mcp      (Bearer auth) │
│      (native tool surface — all AD4M operations)                  │
└──────────────────┬─────────────────────┬──────────────────────────┘
         WS RPC (JWT)                MCP (Bearer)
                  │                    │
                  ▼                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Sovereign Server                               │
│                                                                    │
│  packages/ad4m/  (@sovereign/ad4m)                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Ad4mService                                                 │ │
│  │  ├── Ad4mRpcClient (WS, JWT, auto-reconnect)                │ │
│  │  │   (types from @coasys/ad4m — git submodule)              │ │
│  │  ├── waker — AD4M WS subscriptions → EventBus (ad4m.*)     │ │
│  │  ├── notification bridge — AD4M notifs → Sovereign notifs  │ │
│  │  ├── REST routes  /api/ad4m/*  (UI data layer)              │ │
│  │  ├── WS channel   ad4m.* events → connected UI clients     │ │
│  │  └── MCP proxy    /api/ad4m/mcp  → AD4M executor /mcp      │ │
│  │                   (injects stored JWT as Bearer token)      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                    │                                               │
│                    ▼                                               │
│            Sovereign EventBus                                      │
│            (ad4m.* events flow to event stream,                    │
│             WS channel, notification bridge,                       │
│             thread routing via bootstrap.ts)                       │
│                                                                    │
│  AI runtime adapters — UNCHANGED                                   │
└──────────────────────────────────────────────────────────────────┘
                               │
                    /api/ad4m/mcp (HTTP, proxied)
                               │
               ┌───────────────┴───────────────┐
               │  Any MCP-compatible AI runtime │
               │  (manual config, runtime-agnostic) │
               └───────────────────────────────┘
```

---

## Dependency: `@coasys/ad4m` as git submodule

Types for the AD4M client are sourced directly from the upstream `@coasys/ad4m` package, not duplicated inline. The package is added as a git submodule and linked via pnpm workspace.

**Location:** `vendor/coasys/ad4m/` (submodule tracking `https://github.com/coasys/ad4m`)  
**pnpm workspace entry:** `vendor/coasys/ad4m/core`  
**Linked as:** `"@coasys/ad4m": "workspace:*"` in `packages/ad4m/package.json`

The submodule's `core/lib/` (declaration outputs) is gitignored and must be generated after cloning:

```bash
pnpm run build:vendor   # runs tsc --emitDeclarationOnly --skipLibCheck in vendor/coasys/ad4m/core
```

This is the only build step with external state. All other `pnpm build` steps are self-contained.

---

## Component 1: `@sovereign/ad4m` package

**Location:** `packages/ad4m/`  
**Pattern:** Sovereign module convention — factory function, typed service interface, no framework coupling. No dependency on any AI runtime adapter.

### File structure

```
packages/ad4m/
├── package.json          # name: @sovereign/ad4m; @coasys/ad4m: workspace:*
├── tsconfig.json         # erasableSyntaxOnly: false (for constructor props), declaration: true
├── src/
│   ├── index.ts          # public surface
│   ├── service.ts        # createAd4mService() — composition root
│   ├── client.ts         # Ad4mRpcClient wrapper; re-exports types from @coasys/ad4m
│   ├── rpc-client.ts     # Minimal WS JSON-RPC client — no @coasys/ad4m runtime dep
│   ├── auth.ts           # JWT token read/write helpers
│   ├── waker.ts          # AD4M WS subscriptions → EventBus
│   ├── notifications.ts  # AD4M notification bridge → Sovereign notifs
│   ├── routes.ts         # Express router — /api/ad4m/* REST routes
│   ├── ws.ts             # registerAd4mChannel(wsHandler, bus)
│   └── mcp/
│       └── server.ts     # mountMcpProxy() — transparent authenticated proxy
└── dist/
```

**No `mcp/tools/` directory.** The AD4M executor already exposes a complete MCP server natively. Sovereign proxies it — no tool re-implementation required.

### `createAd4mService(config, bus, notifications)`

```typescript
export interface Ad4mConfig {
  /** http(s):// URL of the AD4M executor's main API (WS-RPC) */
  host: string
  /** Absolute path to JWT token file */
  tokenFile: string
  /**
   * URL of the AD4M executor's native MCP endpoint.
   * Defaults to <host>/mcp (same host, same port, /mcp path).
   * Override if executor runs MCP on a separate port:
   * "http://192.168.1.199:3001/mcp"
   */
  mcpUrl?: string
  watchPerspectives?: string[]
  watchNeighbourhoods?: string[]
  routeDmThreads?: boolean
  routeSystemThread?: boolean
}

export interface Ad4mService {
  client(): Ad4mClientManager
  isConnected(): boolean
  router(): Router // /api/ad4m/* REST routes
  registerChannel(wsHandler: WsHandler): void
  mountMcp(app: Express, path?: string): void // proxy at /api/ad4m/mcp
  close(): void
}
```

### Auth / token management

AD4M uses a JWT capability system:

```
1. agent.requestCapability(authInfo) → requestId   (via REST: POST /api/ad4m/auth/setup)
2. User approves in ADAM Launcher (Settings → Authorized Apps)
3. agent.generateJwt(requestId, rand) → JWT         (via REST: POST /api/ad4m/auth/complete)
4. Stored at dataDir/ad4m-token.json (mode 600)
5. MCP proxy reads this token and injects it as Authorization: Bearer on every upstream request
```

Token management is entirely through Sovereign's REST routes. Once a token is stored, the MCP proxy works transparently — the AI runtime has no knowledge of the token.

### Waker (`waker.ts`)

Subscribes to AD4M real-time WS events. For each event, it:

1. Always emits a typed `ad4m.*` event on Sovereign's `EventBus`.
2. If thread routing is configured for that namespace, additionally emits an `ad4m.thread.message` event (handled by `bootstrap.ts`).

| AD4M subscription | Bus event type | Thread key (if routing enabled) |
| --- | --- | --- |
| `agent.addAgentStatusChangedListener` | `ad4m.agent.status_changed` | `ad4m/system` |
| `agent.addUpdatedListener` | `ad4m.agent.updated` | `ad4m/system` |
| `agent.addAppChangedListener` | `ad4m.apps.changed` | `ad4m/system` |
| `runtime.addMessageCallback` | `ad4m.dm.received` | `ad4m/dm/<senderDID>` |
| `runtime.addNotificationTriggeredCallback` | `ad4m.notification.triggered` | — (notification bridge only) |
| `perspective.addPerspectiveLinkAddedListener` (watched UUIDs) | `ad4m.perspective.link_added` | `ad4m/perspective/<uuid>` |
| `perspective.addPerspectiveLinkRemovedListener` (watched UUIDs) | `ad4m.perspective.link_removed` | `ad4m/perspective/<uuid>` |
| `neighbourhood.addSignalHandler` (watched neighbourhood UUIDs) | `ad4m.neighbourhood.signal` | `ad4m/neighbourhood/<uuid>` |

### Notification bridge (`notifications.ts`)

Subscribes to `ad4m.notification.triggered` on the EventBus and calls `notifications._store.append(...)` — AD4M alerts appear in the Sovereign notification feed with `source: 'ad4m'`. Deduplicates via `seenNotificationIds` set.

### REST routes (`routes.ts`) — `/api/ad4m/*`

Thin REST surface for the Sovereign UI.

| Route                                       | Description                                              |
| ------------------------------------------- | -------------------------------------------------------- |
| `GET  /api/ad4m/status`                     | Connection state, agent DID, executor version            |
| `GET  /api/ad4m/perspectives`               | List all perspectives                                    |
| `GET  /api/ad4m/perspectives/:uuid/links`   | Query links (source/predicate/target params)             |
| `POST /api/ad4m/perspectives/:uuid/links`   | Add a link                                               |
| `DELETE /api/ad4m/perspectives/:uuid/links` | Remove a link                                            |
| `GET  /api/ad4m/agent`                      | Own agent (DID, public perspective)                      |
| `GET  /api/ad4m/social/friends`             | Friend list                                              |
| `GET  /api/ad4m/social/inbox`               | Direct message inbox                                     |
| `POST /api/ad4m/social/message`             | Send a direct message                                    |
| `GET  /api/ad4m/runtime/info`               | Executor runtime info                                    |
| `GET  /api/ad4m/auth/status`                | Token presence and connection health                     |
| `POST /api/ad4m/auth/setup`                 | Start capability flow → returns requestId + instructions |
| `POST /api/ad4m/auth/complete`              | Complete capability flow → saves JWT, reconnects         |

### MCP proxy (`mcp/server.ts`)

`mountMcpProxy(app, mcpUrl, tokenFile, path='/api/ad4m/mcp')` mounts three handlers:

- `POST /api/ad4m/mcp` — forwards to `mcpUrl`, injects `Authorization: Bearer <token>`, streams the response (handles both JSON and SSE)
- `GET /api/ad4m/mcp` — SSE session stream
- `DELETE /api/ad4m/mcp` — session termination

The proxy reads the stored JWT from `tokenFile` on every request. No token caching — a freshly saved token is immediately effective without a server restart.

The AD4M executor's **native** tool surface is exposed through this proxy. Sovereign does not register, re-implement, or wrap any individual tools.

---

## Component 2: `bootstrap.ts` changes

```typescript
import { createAd4mService } from '@sovereign/ad4m'

// After notificationsModule is created, before wireAgentBackend:
const ad4mService = process.env.AD4M_HOST
  ? createAd4mService(
      {
        host: process.env.AD4M_HOST,
        tokenFile: path.join(dataDir, 'ad4m-token.json'),
        mcpUrl: process.env.AD4M_MCP_URL, // optional override
        watchPerspectives: (process.env.AD4M_WATCH_PERSPECTIVES ?? '').split(',').filter(Boolean),
        watchNeighbourhoods: (process.env.AD4M_WATCH_NEIGHBOURHOODS ?? '').split(',').filter(Boolean),
        routeDmThreads: process.env.AD4M_ROUTE_DM_THREADS === 'true',
        routeSystemThread: process.env.AD4M_ROUTE_SYSTEM_THREAD === 'true'
      },
      bus,
      notificationsModule
    )
  : undefined

if (ad4mService) {
  app.use(ad4mService.router())
  ad4mService.registerChannel(wsHandler)
  ad4mService.mountMcp(app)
}

// After wireAgentBackend (routingBackend and threadManager are now available):
if (ad4mService) {
  bus.on('ad4m.thread.message', async (event) => {
    const { threadKey, threadLabel, text } = event.payload as {
      threadKey: string
      threadLabel: string
      text: string
    }
    threadManager.create({ label: threadLabel, orgId: '_global' })
    const sessionKey = `agent:main:thread:${threadKey}`
    try {
      await routingBackend.forSession(sessionKey).sendMessage(sessionKey, text)
    } catch (err: unknown) {
      console.error('[ad4m] thread message injection failed:', threadKey, (err as Error)?.message)
    }
  })
}

// shutdown():
ad4mService?.close()
```

`AD4M_HOST` absent → feature entirely disabled. No errors, no routes mounted.

---

## Environment configuration

```env
# Enable AD4M integration (required to activate any of the below)
AD4M_HOST=http://192.168.1.199:12000

# Optional: override the AD4M executor's MCP URL if it runs on a different port
# Default: <AD4M_HOST>/mcp
AD4M_MCP_URL=http://192.168.1.199:3001/mcp

# Perspective UUIDs to subscribe for link events AND route to ad4m/perspective/<uuid> threads
AD4M_WATCH_PERSPECTIVES=uuid-a,uuid-b

# Neighbourhood UUIDs to subscribe for signals AND route to ad4m/neighbourhood/<uuid> threads
AD4M_WATCH_NEIGHBOURHOODS=uuid-c,uuid-d

# Route incoming DMs to per-DID threads. Default: false.
AD4M_ROUTE_DM_THREADS=true

# Route agent status/app events to the ad4m/system thread. Default: false.
AD4M_ROUTE_SYSTEM_THREAD=true
```

---

## AI runtime registration (manual, one-time)

Sovereign exposes the MCP proxy endpoint — it does not register itself with any AI runtime. Registration is a **manual, one-time operator step**.

The proxy transparently injects the stored AD4M JWT token, so the AI runtime needs no knowledge of the token. Once the token is stored (via `POST /api/ad4m/auth/setup` + `/auth/complete`), the MCP endpoint is fully functional.

### Claude Code

**Option A — CLI (recommended):**

```bash
claude mcp add --transport http ad4m http://localhost:5801/api/ad4m/mcp
```

**Option B — `.mcp.json` in project root:**

```json
{
  "mcpServers": {
    "ad4m": {
      "url": "http://localhost:5801/api/ad4m/mcp"
    }
  }
}
```

After registration, restart the Claude Code session. The full native AD4M tool surface (agent, perspective, expression, language, neighbourhood, runtime, AI) is immediately available — provided the executor is running with `--enable-mcp`.

**Port note:** `5801` is the Sovereign dev server port (`PORT` in `.env.local`).

### Other MCP-compatible runtimes

Add `http://localhost:5801/api/ad4m/mcp` as a remote MCP server URL in the runtime's config. No Sovereign changes required.

---

## Setup after cloning

```bash
# 1. Init submodules
git submodule update --init --recursive

# 2. Build vendor declarations (one-time, not tracked in git)
pnpm run build:vendor

# 3. Install workspace packages
pnpm install

# 4. Build all packages
pnpm run build
```

---

## Changes summary

| File                               | Change                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `packages/ad4m/`                   | **New package** — full implementation                              |
| `packages/ad4m/src/client.ts`      | Types imported from `@coasys/ad4m` (submodule), not defined inline |
| `packages/ad4m/src/mcp/server.ts`  | **Transparent authenticated proxy** — no tool re-implementation    |
| `packages/server/src/bootstrap.ts` | Instantiate `Ad4mService`, mount routes + WS + MCP proxy           |
| `packages/server/src/index.ts`     | Data-dir drift guard + startup logging                             |
| `pnpm-workspace.yaml`              | Add `vendor/coasys/ad4m/core`                                      |
| `package.json` (root)              | Add `build:vendor` script                                          |
| `vendor/coasys/ad4m/`              | **Git submodule** tracking `https://github.com/coasys/ad4m`        |
| `.gitmodules`                      | Submodule declaration                                              |
| `.gitignore`                       | Ignore `vendor/coasys/ad4m/core/lib/` (generated)                  |
| **`packages/agent-backend/`**      | **Unchanged**                                                      |
| **Any AI runtime adapter**         | **Unchanged**                                                      |

---

## Requirements

### R1 — Sovereign → AD4M (Sovereign controls AD4M via WS-RPC client)

**Connection**

- R1.1 Sovereign must establish a persistent WebSocket connection to the AD4M executor at the URL in `AD4M_HOST` on startup.
- R1.2 Sovereign must reconnect automatically after connection loss, with exponential backoff starting at 500 ms and capped at 30 s.
- R1.3 On every reconnect, Sovereign must re-register all active AD4M event subscriptions without requiring a server restart.
- R1.4 When the AD4M executor is unreachable, all `/api/ad4m/*` routes must return immediately with a clear error — no hanging requests.
- R1.5 When `AD4M_HOST` is not set, no connection is attempted, no routes are mounted, and the server starts without error.

**Authentication**

- R1.6 Sovereign must implement the full AD4M JWT capability flow via REST routes: `POST /api/ad4m/auth/setup` → user approves in ADAM Launcher → `POST /api/ad4m/auth/complete` → token persisted to `dataDir/ad4m-token.json`.
- R1.7 The token file must be created with mode 600 and must never be committed to version control.
- R1.8 On startup, Sovereign must attempt to load a persisted token and use it for both the WS-RPC connection and the MCP proxy.
- R1.9 `GET /api/ad4m/auth/status` must return connection state, token presence, and agent DID without side effects.

### R2 — AD4M → Sovereign (AD4M notifies Sovereign via WS push events)

- R2.1–R2.8: See waker table above. All subscriptions re-established on reconnect.
- R2.9 All `ad4m.*` events emitted on the EventBus flow through Sovereign's event stream automatically.
- R2.10 Connected UI clients subscribing to the `ad4m` WS channel receive `ad4m.*` events in real time.
- R2.11 Any other Sovereign module can subscribe to `ad4m.*` events without depending on `@sovereign/ad4m`.
- R2.12–R2.14: Notification bridge — one-way, deduplicated, `source: 'ad4m'`.
- R2.15 `@sovereign/ad4m` must NOT call into the agent routing backend directly.
- R2.16–R2.20: Thread routing — `waker.ts` emits `ad4m.thread.message`; `bootstrap.ts` handles injection.

### R3 — Sovereign → AI Runtime (MCP proxy)

- R3.1 Sovereign must expose an MCP proxy at `/api/ad4m/mcp` that forwards all requests to the AD4M executor's native MCP server with the stored JWT injected as `Authorization: Bearer <token>`.
- R3.2 The proxy must handle all HTTP methods the MCP protocol uses: POST (requests), GET (SSE sessions), DELETE (session termination).
- R3.3 The proxy must stream SSE responses — not buffer them. Large or long-running tool calls must not time out due to buffering.
- R3.4 The endpoint must be absent (not mounted) when `AD4M_HOST` is not set.
- R3.5 `@sovereign/ad4m` must not import from or depend on any AI runtime adapter package.
- R3.6 Sovereign does not register, re-implement, or maintain any individual AD4M MCP tools. The executor's native tool surface is the source of truth.

### R4 — AI Runtime → AD4M via Sovereign (through MCP proxy)

- R4.1 Connecting an AI runtime is a manual, one-time operator step: add `http://<sovereign-host>/api/ad4m/mcp` as a remote MCP server in the runtime's config.
- R4.2 The AI runtime sees the full native AD4M tool surface — all domains (agent, perspective, expression, language, neighbourhood, runtime, AI) — without Sovereign maintaining any wrappers.
- R4.3 A new tool added to the AD4M executor is immediately available through the proxy with no Sovereign changes.
- R4.4 Auth is transparent: the AI runtime needs no knowledge of the JWT token. Once stored in Sovereign, the proxy handles it.

### R5 — Operational / cross-cutting

- R5.1 `@sovereign/ad4m` has no dependency on `@sovereign/agent-backend` or any package beneath it.
- R5.2 The Sovereign server starts, serves all existing routes, and accepts WS connections regardless of AD4M availability or token state.
- R5.3 `pnpm build:vendor && pnpm build` must complete cleanly.
- R5.4 `AD4M_HOST` absent → no `ad4m.*` routes, no WS channel, no MCP proxy, no errors, no changed behaviour for any existing feature.

---

## Open decisions

1. **Executor MCP port** — Default assumes MCP is on the same port as the WS-RPC (`AD4M_HOST/mcp`). If the executor runs MCP on a separate port (e.g., 3001), set `AD4M_MCP_URL` explicitly.

2. **MCP proxy auth** — The `/api/ad4m/mcp` proxy endpoint is currently unauthenticated (local-only by default). If exposed via Tailscale or a tunnel, add Bearer token auth to the proxy route itself (shared secret in env).

3. **Watched perspectives** — Configured via env vars. Future: Sovereign UI panel under Settings → AD4M.

4. **Social ↔ Sovereign identity** — Friends and online status in AD4M could map to Sovereign's people/identity layer. Deferred.

5. **Submodule pinning** — Currently pinned to whatever commit was checked out when the submodule was added. Should be explicitly pinned to the executor version in use (`853ba75208f3` as of 2026-05-25).

---

## What this enables

**In Sovereign's own layer (no AI required):**

- `ad4m.*` events flow through Sovereign's event stream — visible in the system events feed
- AD4M notifications appear in Sovereign's notification panel
- Sovereign UI can query and mutate perspectives via `/api/ad4m/*` REST routes
- Real-time link mutations push to connected UI clients via the WS channel

**For any MCP-compatible AI runtime (manual connect):**

- Full native AD4M tool surface — no wrapper drift, no maintenance overhead
- Auth transparent — token stored in Sovereign, injected by proxy
- New executor capabilities immediately available without Sovereign changes
- Social graph, semantic graph, language management, AI tasks — all through one MCP endpoint
