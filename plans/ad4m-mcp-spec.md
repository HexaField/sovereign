# Plan: AD4M Integration for Sovereign

**Date:** 2026-05-25  
**Status:** Draft  
**Scope:** `@sovereign/ad4m` native package, Sovereign service/route/WS layer, HTTP+SSE MCP endpoint

---

## Goal

Deeply integrate AD4M into Sovereign as a first-class native module — event bus waker, REST routes, WS channel, and notification bridge — and expose AD4M's full capability surface as a standard HTTP+SSE MCP endpoint that any MCP-compatible AI runtime can connect to via manual configuration.

The AI runtime layer is deliberately kept out of this design. Sovereign does not need to know which AI runtime is in use, and the AI runtime does not need to know it is talking to AD4M. The integration surface is:

```
Sovereign ↔ AD4M     (deep, native — this spec)
AI Runtime ↔ Sovereign MCP endpoint     (thin, manual, runtime-agnostic)
```

AD4M is currently running on `field@192.168.1.199:12000` (WebSocket RPC, multi-user mode, confirmed initialized and live).

---

## Non-Goals

- Modifying any AI runtime adapter code (`agent-backend`, `SovereignToolDeps`, etc.)
- stdio MCP transport — HTTP+SSE is standard and runtime-agnostic
- Replacing the ADAM Launcher UI
- Direct Holochain DHT operations (use AD4M's language layer)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   field@192.168.1.199                             │
│                                                                    │
│  AD4M Executor  ws://localhost:12000/api/v1/ws                    │
│  agent · perspective · expression · language                       │
│  neighbourhood · runtime · ai                                      │
└──────────────────────────────┬────────────────────────────────────┘
               WS RPC (JWT)    │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Sovereign Server                               │
│                                                                    │
│  packages/ad4m/  (@sovereign/ad4m)                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Ad4mService                                                 │ │
│  │  ├── Ad4mClient (WS, JWT, auto-reconnect)                   │ │
│  │  ├── waker — AD4M subscriptions → EventBus (ad4m.*)         │ │
│  │  ├── notification bridge — AD4M notifs → Sovereign notifs   │ │
│  │  ├── REST routes  /api/ad4m/*                               │ │
│  │  ├── WS channel   ad4m.* events → connected UI clients      │ │
│  │  └── MCP endpoint /api/ad4m/mcp  (HTTP+SSE)                │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                    │                   │                           │
│                    ▼                   ▼                           │
│            Sovereign EventBus    Sovereign UI                      │
│            (ad4m.* events,       (perspectives, social,            │
│             other modules        notifications, events feed)       │
│             can subscribe)                                         │
│                                                                    │
│  AI runtime adapters — UNCHANGED                                   │
└──────────────────────────────────────────────────────────────────┘
                               │
                    /api/ad4m/mcp (HTTP+SSE)
                               │
               ┌───────────────┴───────────────┐
               │  Any MCP-compatible AI runtime │
               │  (manual config, runtime-agnostic) │
               └───────────────────────────────┘
```

---

## Component 1: `@sovereign/ad4m` package

**Location:** `packages/ad4m/`  
**Pattern:** Sovereign module convention — factory function, typed service interface, no framework coupling. No dependency on any AI runtime adapter.

### File structure

```
packages/ad4m/
├── package.json          # name: @sovereign/ad4m, type: module
├── tsconfig.json
├── src/
│   ├── index.ts          # public surface
│   ├── service.ts        # createAd4mService() — composition root
│   ├── client.ts         # Ad4mClient singleton, auto-reconnect, token load
│   ├── auth.ts           # JWT token read/write, capability flow helpers
│   ├── waker.ts          # AD4M WS subscriptions → EventBus
│   ├── notifications.ts  # AD4M notification bridge → Sovereign notifs
│   ├── routes.ts         # Express router — /api/ad4m/*
│   ├── ws.ts             # registerAd4mChannel(wsHandler, bus)
│   └── mcp/
│       ├── server.ts     # createAd4mMcpServer() — HTTP+SSE MCP endpoint
│       └── tools/
│           ├── agent.ts
│           ├── perspective.ts
│           ├── expression.ts
│           ├── language.ts
│           ├── neighbourhood.ts
│           ├── runtime.ts
│           └── ai.ts
└── dist/
```

### `createAd4mService(config, bus, notifications)`

```typescript
export interface Ad4mConfig {
  /** Base URL without path, e.g. "ws://192.168.1.199:12000" */
  host: string
  /** Absolute path to JWT token file. e.g. dataDir/ad4m-token.json */
  tokenFile: string
  /**
   * Perspective UUIDs to subscribe for link events AND route to
   * ad4m/perspective/<uuid> threads. Default: []
   */
  watchPerspectives?: string[]
  /**
   * Neighbourhood perspective UUIDs to subscribe for signals AND route
   * to ad4m/neighbourhood/<uuid> threads. Default: []
   */
  watchNeighbourhoods?: string[]
  /**
   * Route incoming DMs to ad4m/dm/<senderDID> threads. Default: false.
   * DM events are always subscribed regardless; this flag controls injection.
   */
  routeDmThreads?: boolean
  /**
   * Route agent status/exception/app events to the ad4m/system thread.
   * Default: false.
   */
  routeSystemThread?: boolean
}

export interface Ad4mService {
  client(): Ad4mClient
  isConnected(): boolean
  /** Express router mounting /api/ad4m/* routes */
  router(): Router
  /** Register the ad4m WS channel with Sovereign's WS handler */
  registerChannel(wsHandler: WsHandler): void
  /** Mount the HTTP+SSE MCP endpoint on an Express app */
  mountMcp(app: Express, path?: string): void
  close(): void
}
```

### Auth / token management

AD4M uses a JWT capability system:

```
1. agent.requestCapability(authInfo) → requestId
2. User approves in ADAM Launcher (Settings → Authorized Apps)
3. agent.generateJwt(requestId, rand) → JWT
4. Stored at dataDir/ad4m-token.json (mode 600)
```

`auth.ts` exposes helpers used by the MCP `ad4m_auth_*` tools (see tool inventory). No separate CLI — the capability flow is driven through the MCP tools themselves, from within a connected AI session.

On startup, `createAd4mService` attempts to load the token and connect. If missing, `isConnected()` returns `false` and all MCP tools return a clear error pointing to `ad4m_auth_setup`.

### Waker (`waker.ts`)

Subscribes to AD4M real-time WS events. For each event, it:

1. Always emits a typed `ad4m.*` event on Sovereign's `EventBus` (flows to event stream, WS channel, notification bridge, and any other bus subscribers).
2. If thread routing is configured for that namespace, additionally emits an `ad4m.thread.message` event on the bus (handled by `bootstrap.ts` — see R2.16–R2.17).

All subscriptions are real-time push — no polling. `waker.ts` has no dependency on the agent routing backend.

| AD4M subscription | Bus event type | Thread key (if routing enabled) |
| --- | --- | --- |
| `agent.subscribeAgentStatusChanged` | `ad4m.agent.status_changed` | `ad4m/system` |
| `agent.subscribeAgentUpdated` | `ad4m.agent.updated` | `ad4m/system` |
| `agent.subscribeAppsChanged` | `ad4m.apps.changed` | `ad4m/system` |
| `runtime.subscribeMessageReceived` | `ad4m.dm.received` | `ad4m/dm/<senderDID>` |
| `runtime.subscribeNotificationTriggered` | `ad4m.notification.triggered` | — (notification bridge only) |
| `perspective.addPerspectiveLinkAddedListener` (watched UUIDs) | `ad4m.perspective.link_added` | `ad4m/perspective/<uuid>` |
| `perspective.addPerspectiveLinkRemovedListener` (watched UUIDs) | `ad4m.perspective.link_removed` | `ad4m/perspective/<uuid>` |
| `neighbourhood.subscribeToSignals` + `addSignalHandler` (watched neighbourhood UUIDs) | `ad4m.neighbourhood.signal` | `ad4m/neighbourhood/<uuid>` |

On WS reconnect, `waker.ts` re-registers all subscriptions automatically.

### Notification bridge (`notifications.ts`)

AD4M surfaces notifications via `runtime.notifications()` and a WS subscription. The bridge polls or subscribes and calls `notifications._store.append(...)` on Sovereign's notification module — AD4M alerts appear in the Sovereign notification feed with `source: 'ad4m'`.

### REST routes (`routes.ts`) — `/api/ad4m/*`

Thin REST surface for the Sovereign UI. Not a general-purpose proxy — only what the UI needs to render meaningful AD4M data.

| Route                                       | Description                                                        |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `GET  /api/ad4m/status`                     | Connection state, agent DID, executor version                      |
| `GET  /api/ad4m/perspectives`               | List all perspectives (UUID, name, neighbourhood URL)              |
| `GET  /api/ad4m/perspectives/:uuid/links`   | Query links (accepts `source`, `predicate`, `target` query params) |
| `POST /api/ad4m/perspectives/:uuid/links`   | Add a link                                                         |
| `DELETE /api/ad4m/perspectives/:uuid/links` | Remove a link                                                      |
| `GET  /api/ad4m/agent`                      | Own agent (DID, public perspective)                                |
| `GET  /api/ad4m/social/friends`             | Friend list                                                        |
| `GET  /api/ad4m/social/inbox`               | Direct message inbox                                               |
| `POST /api/ad4m/social/message`             | Send a direct message                                              |
| `GET  /api/ad4m/runtime/info`               | Executor runtime info                                              |
| `GET  /api/ad4m/auth/status`                | Token presence and connection health                               |

### WS channel (`ws.ts`)

`registerAd4mChannel(wsHandler, bus)` subscribes to `ad4m.*` events on the bus and forwards them to connected WS clients that have subscribed to the `ad4m` channel. Follows the same pattern as `registerNotificationsChannel`, `registerGitChannel`, etc.

### HTTP+SSE MCP endpoint (`mcp/server.ts`)

An MCP server using the standard HTTP+SSE transport (from `@modelcontextprotocol/sdk`), mounted by `Ad4mService.mountMcp(app)` at `/api/ad4m/mcp`.

Any MCP-compatible AI runtime connects to this endpoint by adding it to its MCP client configuration. No code changes in Sovereign's AI runtime adapters.

**Manual connection (example for any MCP client):**

```json
{
  "mcpServers": {
    "ad4m": {
      "url": "http://localhost:3001/api/ad4m/mcp"
    }
  }
}
```

The endpoint is local by default. Expose via Tailscale or a Sovereign tunnel if needed for remote access.

---

## Component 2: `bootstrap.ts` changes

One new block — all other server modules unchanged:

```typescript
import { createAd4mService } from '@sovereign/ad4m'

// After notificationsModule is created, before wireAgentBackend:
const ad4mService = process.env.AD4M_HOST
  ? createAd4mService(
      {
        host: process.env.AD4M_HOST,
        tokenFile: path.join(dataDir, 'ad4m-token.json'),
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
    threadManager.create({ label: threadKey, orgId: '_global' }) // idempotent
    const sessionKey = `agent:main:thread:${threadKey}`
    try {
      await routingBackend.forSession(sessionKey).sendMessage(sessionKey, text)
    } catch (err: any) {
      console.error('[ad4m] thread message injection failed:', threadKey, err?.message)
    }
  })
}

// shutdown():
ad4mService?.close()
```

`AD4M_HOST` absent → feature entirely disabled. No errors, no routes mounted.  
The `ad4m.thread.message` listener is the only place `@sovereign/ad4m` touches the agent routing backend — and it doesn't: the listener lives in `bootstrap.ts`, not in the package.

---

## Environment configuration

```env
# Enable AD4M integration (required to activate any of the below)
AD4M_HOST=ws://192.168.1.199:12000

# Perspective UUIDs to subscribe for link events AND route to ad4m/perspective/<uuid> threads
AD4M_WATCH_PERSPECTIVES=uuid-a,uuid-b

# Neighbourhood perspective UUIDs to subscribe for signals AND route to ad4m/neighbourhood/<uuid> threads
AD4M_WATCH_NEIGHBOURHOODS=uuid-c,uuid-d

# Route incoming DMs to per-DID threads (ad4m/dm/<senderDID>). Default: false.
AD4M_ROUTE_DM_THREADS=true

# Route agent status / exception / app events to the ad4m/system thread. Default: false.
AD4M_ROUTE_SYSTEM_THREAD=true
```

All vars are optional except `AD4M_HOST`. `WATCH_*` vars both subscribe the events and enable thread routing for that namespace. `ROUTE_*` flags only control thread injection — the underlying events are always subscribed and always appear on the EventBus.

Add to `packages/server/.env.local` (gitignored).

---

## AI runtime registration (manual, one-time)

Sovereign exposes the MCP endpoint — it does not register itself with any AI runtime. Registration is a **manual, one-time operator step** performed per developer machine. This is intentional: Sovereign has no knowledge of which AI runtime is in use, and different runtimes have different config mechanisms. No automation of this step is planned.

### Claude Code

Add the server to the project's `.mcp.json` (project-scoped, committed) or to the global Claude Code config (machine-scoped, not committed):

**Option A — CLI (recommended, writes `.mcp.json` in the current project):**

```bash
claude mcp add --transport http ad4m http://localhost:3001/api/ad4m/mcp
```

**Option B — Manual `.mcp.json` edit (project root):**

```json
{
  "mcpServers": {
    "ad4m": {
      "url": "http://localhost:3001/api/ad4m/mcp"
    }
  }
}
```

**Option C — Global config (`~/.config/claude/claude_desktop_config.json` on Linux / `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):** Same JSON shape as Option B, applied machine-wide rather than per-project.

After registration, restart the Claude Code session. Run `ad4m_auth_status` to confirm the endpoint is reachable and the token is valid. If the token is absent, run `ad4m_auth_setup` and follow the returned instructions to approve in the ADAM Launcher.

**Port note:** `3001` is the default Sovereign dev server port. Adjust if the server runs on a different port or if the MCP endpoint is exposed via Tailscale/tunnel.

### Other MCP-compatible runtimes

Any runtime that supports HTTP+SSE MCP transport (Cursor, Cline, Continue, etc.) connects by adding `http://localhost:3001/api/ad4m/mcp` as a remote MCP server URL in its own config. The exact config key varies by runtime — consult that runtime's MCP documentation. No changes to Sovereign are required.

---

## MCP tool inventory (~42 tools)

All tools return JSON. On error (disconnected, locked, invalid args): `{ "error": "<message>" }`. Tools are defined against `Ad4mService.client()` — they have no knowledge of any AI runtime.

### Auth (2 tools)

| Tool | Description |
| --- | --- |
| `ad4m_auth_setup` | Begin capability flow — calls `requestCapability`, returns the requestId and instructions to approve in ADAM Launcher |
| `ad4m_auth_complete` | Complete capability flow — calls `generateJwt(requestId, rand)`, saves token, reconnects client. Returns own DID on success. |
| `ad4m_auth_status` | Connection state, token presence, agent DID if connected |

### Agent (10 tools)

| Tool                                   | Description                            |
| -------------------------------------- | -------------------------------------- |
| `ad4m_agent_me`                        | Own DID and public perspective         |
| `ad4m_agent_status`                    | Lock / unlock / initialization status  |
| `ad4m_agent_unlock`                    | Unlock the keystore                    |
| `ad4m_agent_lock`                      | Lock the keystore                      |
| `ad4m_agent_by_did`                    | Resolve another agent's profile by DID |
| `ad4m_agent_update_public_perspective` | Set own public perspective             |
| `ad4m_agent_sign_message`              | Sign a string with the agent key       |
| `ad4m_agent_get_apps`                  | List authorized apps                   |
| `ad4m_agent_remove_app`                | Revoke an app's access                 |
| `ad4m_agent_is_locked`                 | Check keystore lock state              |

### Perspective (18 tools)

| Tool                                | Description                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `ad4m_perspective_all`              | List all perspectives (UUID, name, neighbourhood URL) |
| `ad4m_perspective_by_uuid`          | Get one perspective                                   |
| `ad4m_perspective_snapshot`         | Full snapshot — all links                             |
| `ad4m_perspective_add`              | Create a new perspective                              |
| `ad4m_perspective_update`           | Rename a perspective                                  |
| `ad4m_perspective_remove`           | Delete a perspective                                  |
| `ad4m_perspective_query_links`      | Query links with source / predicate / target filter   |
| `ad4m_perspective_add_link`         | Add a single triple link                              |
| `ad4m_perspective_add_links`        | Batch add links                                       |
| `ad4m_perspective_remove_link`      | Remove a link                                         |
| `ad4m_perspective_update_link`      | Replace a link                                        |
| `ad4m_perspective_query_prolog`     | Run a Prolog query                                    |
| `ad4m_perspective_query_sparql`     | Run a SPARQL query                                    |
| `ad4m_perspective_list_sdna`        | List installed SDNA schemas (subject classes, flows)  |
| `ad4m_perspective_add_sdna`         | Install an SDNA schema                                |
| `ad4m_perspective_model_query`      | Query subject class instances                         |
| `ad4m_perspective_create_subject`   | Instantiate a subject class                           |
| `ad4m_perspective_get_subject_data` | Read a subject instance                               |

### Expression (2 tools)

| Tool                     | Description                           |
| ------------------------ | ------------------------------------- |
| `ad4m_expression_get`    | Fetch an expression by URI            |
| `ad4m_expression_create` | Create a new expression in a language |

### Language (7 tools)

| Tool                           | Description                                |
| ------------------------------ | ------------------------------------------ |
| `ad4m_language_all`            | List installed languages                   |
| `ad4m_language_by_address`     | Get a language by address                  |
| `ad4m_language_by_filter`      | Search languages                           |
| `ad4m_language_meta`           | Get language metadata                      |
| `ad4m_language_source`         | Get language source code                   |
| `ad4m_language_write_settings` | Update language settings                   |
| `ad4m_language_apply_template` | Clone + publish a language from a template |

### Neighbourhood (6 tools)

| Tool                                | Description                              |
| ----------------------------------- | ---------------------------------------- |
| `ad4m_neighbourhood_join`           | Join a neighbourhood from a URL          |
| `ad4m_neighbourhood_publish`        | Publish a perspective as a neighbourhood |
| `ad4m_neighbourhood_other_agents`   | List all agents                          |
| `ad4m_neighbourhood_online_agents`  | List currently online agents             |
| `ad4m_neighbourhood_send_signal`    | Send a direct signal to a specific agent |
| `ad4m_neighbourhood_send_broadcast` | Broadcast to all agents                  |

### Runtime (13 tools)

| Tool                               | Description                        |
| ---------------------------------- | ---------------------------------- |
| `ad4m_runtime_info`                | Executor version and runtime info  |
| `ad4m_runtime_friends`             | List trusted friends (DIDs)        |
| `ad4m_runtime_add_friends`         | Add trusted friends                |
| `ad4m_runtime_remove_friends`      | Remove friends                     |
| `ad4m_runtime_trusted_agents`      | List trusted agent DIDs            |
| `ad4m_runtime_set_status`          | Set own online status              |
| `ad4m_runtime_friend_status`       | Get a friend's status              |
| `ad4m_runtime_friend_send_message` | Send a DM to a friend              |
| `ad4m_runtime_message_inbox`       | Read received DMs                  |
| `ad4m_runtime_message_outbox`      | Read sent DMs                      |
| `ad4m_runtime_notifications`       | List pending AD4M notifications    |
| `ad4m_runtime_network_metrics`     | Holochain network metrics          |
| `ad4m_runtime_export_db`           | Export the AD4M database to a file |

### AI (9 tools)

| Tool                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `ad4m_ai_models`            | List configured AI models                            |
| `ad4m_ai_add_model`         | Add an AI model configuration                        |
| `ad4m_ai_remove_model`      | Remove a model                                       |
| `ad4m_ai_set_default_model` | Set default model for a type                         |
| `ad4m_ai_tasks`             | List AI tasks                                        |
| `ad4m_ai_add_task`          | Create a task (name, model, system prompt, examples) |
| `ad4m_ai_remove_task`       | Delete a task                                        |
| `ad4m_ai_prompt`            | Run a prompt through a task                          |
| `ad4m_ai_embed`             | Get embeddings from a model                          |

---

## Changes summary

| File                               | Change                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| `packages/ad4m/`                   | **New package** — full implementation                       |
| `packages/server/src/bootstrap.ts` | Instantiate `Ad4mService`, mount routes + WS + MCP endpoint |
| `pnpm-workspace.yaml`              | Add `packages/ad4m`                                         |
| `tsconfig.json` (root)             | Add `@sovereign/ad4m` path alias                            |
| **`packages/agent-backend/`**      | **Unchanged**                                               |
| **Any AI runtime adapter**         | **Unchanged**                                               |

---

## Requirements

Grouped by relationship edge. Every requirement names a direction — who initiates, who receives. Nothing is implied; every behaviour is stated explicitly.

---

### R1 — Sovereign → AD4M (Sovereign controls AD4M)

**Connection**

- R1.1 Sovereign must establish a persistent WebSocket connection to the AD4M executor at the URL in `AD4M_HOST` on startup.
- R1.2 Sovereign must reconnect automatically after connection loss, with exponential backoff starting at 500 ms and capped at 30 s.
- R1.3 On every reconnect, Sovereign must re-register all active AD4M event subscriptions without requiring a server restart.
- R1.4 Connection failure must not crash the Sovereign server or produce unhandled promise rejections.
- R1.5 When `AD4M_HOST` is not set, no connection is attempted, no routes are mounted, and the server starts without error.

**Authentication**

- R1.6 Sovereign must implement the full AD4M JWT capability flow: `agent.requestCapability` → user approves in ADAM Launcher → `agent.generateJwt(requestId, rand)` → token persisted to `dataDir/ad4m-token.json`.
- R1.7 The token file must be created with mode 600 and must never be committed to version control.
- R1.8 On startup, Sovereign must attempt to load a persisted token and use it to authenticate the WebSocket connection. If the file is absent, the service starts in a disconnected state.
- R1.9 A stale or rejected token must produce a clear error in `GET /api/ad4m/auth/status` and in all MCP tool responses, not a silent failure.

**Reading AD4M state**

- R1.10 Sovereign must be able to list all perspectives (UUID, name, neighbourhood URL).
- R1.11 Sovereign must be able to fetch a single perspective by UUID and retrieve its full link snapshot.
- R1.12 Sovereign must be able to query links in any perspective with source, predicate, and target filters.
- R1.13 Sovereign must be able to run Prolog queries and SPARQL queries over any perspective.
- R1.14 Sovereign must be able to list SDNA schemas (subject classes and flows) installed in a perspective.
- R1.15 Sovereign must be able to query subject class instances and read subject instance data from any perspective.
- R1.16 Sovereign must be able to read own agent identity (DID, public perspective, lock status) and resolve other agents by DID.
- R1.17 Sovereign must be able to fetch any expression by URI and read its content.
- R1.18 Sovereign must be able to list all installed languages, read their metadata and source.
- R1.19 Sovereign must be able to read neighbourhood state: member agents, online agents.
- R1.20 Sovereign must be able to read the social graph: trusted friends (DIDs), message inbox, message outbox.
- R1.21 Sovereign must be able to read runtime state: executor version, Holochain network metrics, list of authorized apps.
- R1.22 Sovereign must be able to read AD4M AI configuration: models, tasks, default model per type.

**Writing to AD4M**

- R1.23 Sovereign must be able to create, rename, and delete perspectives.
- R1.24 Sovereign must be able to add, update, and remove individual links in any perspective, and add links in batch.
- R1.25 Sovereign must be able to install SDNA schemas into any perspective.
- R1.26 Sovereign must be able to instantiate subject classes and mutate subject instance state in any perspective.
- R1.27 Sovereign must be able to create expressions in any installed language.
- R1.28 Sovereign must be able to publish a perspective as a neighbourhood.
- R1.29 Sovereign must be able to join an existing neighbourhood from a URL.
- R1.30 Sovereign must be able to send signals to individual agents and broadcasts to all agents in a neighbourhood.
- R1.31 Sovereign must be able to manage social connections: add and remove trusted friends.
- R1.32 Sovereign must be able to send direct messages to friends.
- R1.33 Sovereign must be able to set own online status.
- R1.34 Sovereign must be able to add, remove, and configure AI models and tasks.
- R1.35 Sovereign must be able to run prompts through AD4M AI tasks and request embeddings.
- R1.36 Sovereign must be able to write language settings for any installed language.
- R1.37 Sovereign must be able to publish a new language from a template.
- R1.38 Sovereign must be able to revoke authorized app access.
- R1.39 Sovereign must be able to lock and unlock the AD4M keystore.

---

### R2 — AD4M → Sovereign (AD4M notifies Sovereign)

**Event subscriptions**

- R2.1 Sovereign must subscribe to `agentStatusChanged` events and emit `ad4m.agent.status_changed` on the Sovereign EventBus for every state transition (locked, unlocked, initializing).
- R2.2 Sovereign must subscribe to `agentUpdated` events and emit `ad4m.agent.updated` on the EventBus when the agent's public perspective or profile changes.
- R2.3 Sovereign must subscribe to `appsChanged` events and emit `ad4m.apps.changed` on the EventBus when the set of authorized apps changes.
- R2.4 Sovereign must subscribe to `runtime.subscribeMessageReceived` — the real-time push event for incoming direct messages — and emit `ad4m.dm.received` on the EventBus with the full `PerspectiveExpression` payload and the sender DID.
- R2.5 For each perspective UUID in `AD4M_WATCH_PERSPECTIVES`, Sovereign must subscribe to `perspectiveLinkAdded` and emit `ad4m.perspective.link_added` on the EventBus, including the full link payload.
- R2.6 For each perspective UUID in `AD4M_WATCH_PERSPECTIVES`, Sovereign must subscribe to `perspectiveLinkRemoved` and emit `ad4m.perspective.link_removed` on the EventBus.
- R2.7 For each neighbourhood perspective UUID in `AD4M_WATCH_NEIGHBOURHOODS`, Sovereign must call `neighbourhood.subscribeToSignals(uuid)` and `neighbourhood.addSignalHandler` to receive real-time telepresence signals, emitting `ad4m.neighbourhood.signal` on the EventBus with the sender DID and signal payload.
- R2.8 All subscriptions must be re-established after a reconnect without duplicating events.

**EventBus propagation within Sovereign**

- R2.9 All `ad4m.*` events emitted on the EventBus must appear in Sovereign's existing event stream (no new code required — they flow through `EventStream` automatically).
- R2.10 Connected Sovereign UI clients that subscribe to the `ad4m` WS channel must receive `ad4m.*` bus events in real time via the existing WS infrastructure.
- R2.11 Any other Sovereign module (notifications, planning, etc.) must be able to subscribe to `ad4m.*` events on the EventBus without depending on `@sovereign/ad4m` directly — the bus is the decoupling boundary.

**Notification bridge**

- R2.12 AD4M notifications (surfaced via `runtime.subscribeNotificationTriggered`) must be mirrored into Sovereign's notification module with `source: 'ad4m'`.
- R2.13 The bridge must deduplicate: a notification already present in Sovereign must not be re-created on reconnect.
- R2.14 AD4M notification dismissal does not need to be reflected back to AD4M in this version (one-way bridge).

**Thread routing — AD4M event namespaces**

AD4M events route into per-namespace Sovereign threads rather than flooding a single thread. This is a deliberate divergence from how OpenClaw's cron bridge works: OpenClaw gateway jobs default to `sessionTarget: main` (the main thread) unless a specific session key is configured. Sovereign's AD4M integration assigns a structured thread key to each AD4M event namespace so conversations, link mutations, and signals land in their own context.

Thread key convention:

| AD4M event source                                      | Thread key                  | Populated by     |
| ------------------------------------------------------ | --------------------------- | ---------------- |
| Agent status / exceptions / app changes                | `ad4m/system`               | R2.1, R2.2, R2.3 |
| Incoming DM from friend DID `<did>`                    | `ad4m/dm/<did>`             | R2.4             |
| Signal/broadcast in neighbourhood perspective `<uuid>` | `ad4m/neighbourhood/<uuid>` | R2.7             |
| Link mutation in watched perspective `<uuid>`          | `ad4m/perspective/<uuid>`   | R2.5, R2.6       |

- R2.15 `@sovereign/ad4m` must NOT call into the agent routing backend directly. It has no dependency on `agent-backend`. Thread injection is decoupled via a dedicated bus event type.
- R2.16 When an AD4M event is configured to route to a thread (see R2.19), `waker.ts` must emit an `ad4m.thread.message` event on the EventBus with the shape:
  ```typescript
  {
    type: 'ad4m.thread.message',
    source: 'ad4m',
    timestamp: string,
    payload: {
      threadKey: string,   // e.g. 'ad4m/dm/did:key:z6Mk...'
      threadLabel: string, // human-readable, used only for auto-creation
      text: string         // the message to inject into the thread
    }
  }
  ```
- R2.17 `bootstrap.ts` must subscribe to `ad4m.thread.message` after `wireAgentBackend` returns and, for each event:
  1. Call `threadManager.create({ label: payload.threadKey, orgId: '_global' })` to ensure the thread exists (idempotent — returns existing thread if key already used).
  2. Derive `sessionKey = 'agent:main:thread:' + payload.threadKey`.
  3. Call `routingBackend.forSession(sessionKey).sendMessage(sessionKey, payload.text)`.
  4. Log and swallow errors — a failed injection must not crash the server.
- R2.18 Thread auto-creation must be idempotent. Calling `threadManager.create` with the same `label` twice must return the existing thread without emitting a second `thread.created` event.
- R2.19 Thread routing must be opt-in per namespace. The default configuration must not inject any messages into any thread. Routing is enabled by setting the relevant env vars:

  | Env var                                   | Enables routing for                             |
  | ----------------------------------------- | ----------------------------------------------- |
  | `AD4M_ROUTE_SYSTEM_THREAD=true`           | Agent status / exception events → `ad4m/system` |
  | `AD4M_ROUTE_DM_THREADS=true`              | Incoming DMs → `ad4m/dm/<did>`                  |
  | `AD4M_WATCH_NEIGHBOURHOODS=<uuid>,<uuid>` | Signals → `ad4m/neighbourhood/<uuid>`           |
  | `AD4M_WATCH_PERSPECTIVES=<uuid>,<uuid>`   | Link events → `ad4m/perspective/<uuid>`         |

  `AD4M_WATCH_PERSPECTIVES` and `AD4M_WATCH_NEIGHBOURHOODS` imply routing: listing a UUID subscribes the events AND routes them to a thread. `AD4M_ROUTE_*` flags are separate because status/DM events are always subscribed regardless (R2.1, R2.4) — the flag only controls whether they also trigger thread injection.

- R2.20 Message text injected into threads must identify the AD4M event source clearly so the context is unambiguous. Format examples:
  - DM: `[AD4M DM from did:key:z6Mk...] "Hello, want to collaborate?"`
  - Neighbourhood signal: `[AD4M Signal in neighbourhood <uuid> from did:key:z6Mk...] <payload>`
  - Link added: `[AD4M Link added in <perspective name>] <source> --[<predicate>]--> <target>`
  - System: `[AD4M] Agent status changed: unlocked`

**What AD4M cannot do to Sovereign**

- R2.21 AD4M events must not modify Sovereign's own data (git, issues, orgs, etc.) directly. They surface as bus events; `bootstrap.ts` decides what to do with them.
- R2.22 AD4M events must not be able to create threads in arbitrary namespaces. All thread keys emitted by `waker.ts` must match the `ad4m/*` prefix convention. Thread creation outside that namespace is not triggered by AD4M events.

---

### R3 — Sovereign → AI Runtime (Sovereign exposes AD4M to AI)

**MCP endpoint**

- R3.1 Sovereign must expose a standard HTTP+SSE MCP endpoint at `/api/ad4m/mcp`.
- R3.2 The endpoint must implement the MCP HTTP+SSE transport spec via `@modelcontextprotocol/sdk`. No proprietary transport; any compliant MCP client must be able to connect.
- R3.3 The endpoint must be absent (not mounted) when `AD4M_HOST` is not set. A request to `/api/ad4m/mcp` in that state must return 404.
- R3.4 The endpoint must be local-only by default. Remote access requires explicit network exposure (Tailscale, tunnel) and is the operator's responsibility, not a Sovereign feature.
- R3.5 The `@sovereign/ad4m` package must not import from or depend on any AI runtime adapter package. The MCP endpoint is a generic HTTP server — it has no knowledge of which client is connected.

**Tool availability**

- R3.6 All tools listed in the MCP tool inventory (~42 tools across auth, agent, perspective, expression, language, neighbourhood, runtime, ai domains) must be registered on the endpoint.
- R3.7 Tools must be available immediately after server startup; no deferred registration.
- R3.8 Tool descriptions must describe what they do in terms of the data and operations, not in terms of internal implementation (no references to `Ad4mClient` method names or Sovereign internals).
- R3.9 Every tool must return a valid JSON response in both success and failure cases. Failure must set `{ "error": "<human-readable message>" }` — no unhandled throws reaching the MCP transport.
- R3.10 Tools that perform destructive or irreversible operations (`ad4m_perspective_remove`, `ad4m_runtime_quit`) must require an explicit `{ "confirm": true }` parameter.

**Auth tools**

- R3.11 `ad4m_auth_setup` must initiate the AD4M capability flow and return the `requestId` plus human-readable instructions for the ADAM Launcher approval step.
- R3.12 `ad4m_auth_complete` must accept the `requestId`, call `generateJwt`, persist the token, reinitialise the `Ad4mClient` with the new token, and return the agent's DID on success.
- R3.13 `ad4m_auth_status` must return connection state, token presence, and agent DID (if connected) without side effects.
- R3.14 Once a token is persisted, subsequent server restarts must not require re-authentication through the MCP tools.

---

### R4 — AI Runtime → AD4M via Sovereign (AI reads and writes the graph)

- R4.1 Connecting an AI runtime to the MCP endpoint is a **manual, one-time operator step**: add `http://<sovereign-host>/api/ad4m/mcp` as a remote MCP server URL in the runtime's own config. For Claude Code this is `claude mcp add --transport http ad4m <url>` or a `.mcp.json` entry. Sovereign does not auto-register with any AI runtime and has no knowledge of which runtime is in use. No Sovereign-side setup is required beyond the server running with `AD4M_HOST` set.
- R4.2 Through the MCP tools, the AI runtime must have equivalent read access to AD4M as Sovereign's own REST routes provide — perspectives, links, agent, expressions, languages, neighbourhoods, runtime state, AI configuration.
- R4.3 Through the MCP tools, the AI runtime must have equivalent write access — add and remove links, create perspectives, create expressions, install SDNA, publish languages, join neighbourhoods, send social messages, manage AI models and tasks.
- R4.4 The AI runtime must be able to discover what perspectives exist before querying them (`ad4m_perspective_all`).
- R4.5 The AI runtime must be able to discover what SDNA schemas are installed in a perspective before querying subject classes (`ad4m_perspective_list_sdna`).
- R4.6 The AI runtime must be able to authenticate AD4M from scratch through MCP tools alone (R3.11–R3.14) without needing filesystem or server access.
- R4.7 All AI runtime calls to AD4M pass through `Ad4mService.client()` — the AI runtime has no direct connection to the AD4M executor. Sovereign's connection is the only connection.

**AD4M events reaching the AI runtime via thread injection**

- R4.8 AD4M events reach the AI runtime indirectly: configured event namespaces inject a user-turn message into the appropriate Sovereign thread (R2.16–R2.17). The AI runtime sees this as a regular incoming message in that thread — it requires no knowledge of AD4M, no MCP endpoint changes, and no changes to any AI runtime adapter.
- R4.9 The AI runtime has no direct push channel from AD4M. Events not configured for thread routing (R2.19) are invisible to the AI runtime unless it polls via MCP tools.
- R4.10 Adding a new AD4M event namespace to thread routing must require only an env var change — no code changes to the MCP endpoint, `@sovereign/ad4m`, or any AI runtime adapter. The `ad4m.thread.message` bus event + `bootstrap.ts` listener is the complete extension point.

---

### R5 — Operational / cross-cutting

- R5.1 `@sovereign/ad4m` must have no dependency on `@sovereign/agent-backend` or any package beneath it. The agent-backend and all AI runtime adapter code remain unchanged.
- R5.2 The Sovereign server must start, serve all existing routes, and accept WS connections regardless of AD4M availability or token state.
- R5.3 If the AD4M executor is unreachable at startup, Sovereign must log a warning and enter disconnected state, not fail to start.
- R5.4 `pnpm build` must complete cleanly with `@sovereign/ad4m` present in the workspace.
- R5.5 `pnpm test` must pass. The `@sovereign/ad4m` package must have unit tests for at least: token read/write, reconnect logic, event subscription/re-registration, and MCP tool error handling.
- R5.6 `AD4M_HOST` absent → no `ad4m.*` routes, no WS channel, no MCP endpoint, no errors, no changed behaviour for any existing feature.

---

## Open decisions

1. **`@coasys/ad4m` version** — Must match the running executor (`0.13.0-test-6`). Initial approach: `"@coasys/ad4m": "file:///home/field/ad4m/core"` via SSH-mounted path, or copy the compiled `core/dist/` into `packages/ad4m/vendor/`. Switch to published npm version once upstream stabilises.

2. **MCP auth** — The `/api/ad4m/mcp` endpoint is currently unauthenticated (local-only by default). If exposed via Tailscale or a tunnel, add Bearer token auth to the MCP route (shared secret in env, passed in `Authorization` header by the client config).

3. **Watched perspectives** — Configured via env for now. Future: expose a Sovereign UI panel (under Settings → AD4M) where Josh can toggle which perspectives emit link events.

4. **`ad4m_runtime_quit`** — Require `{ confirm: true }` parameter to prevent accidental executor shutdown from an AI session.

5. **Social ↔ Sovereign identity** — Friends and online status in AD4M could map to Sovereign's people/identity layer. Defer to a follow-on spec; for now, AD4M social data is available via MCP tools and `/api/ad4m/social/*` routes but is not joined with Sovereign user records.

---

## What this enables

**In Sovereign's own layer (no AI required):**

- `ad4m.*` events flow through Sovereign's event stream — visible in the system events feed
- AD4M notifications appear in Sovereign's notification panel
- Sovereign UI can query and mutate perspectives via `/api/ad4m/*` REST routes
- Real-time link mutations push to connected UI clients via the WS channel

**For any MCP-compatible AI runtime (manual connect):**

- Full read/write access to the agent's semantic graph
- Social graph operations (friends, DMs, online status, neighbourhood signals)
- Language and expression management
- AD4M's local AI layer (models, tasks, embeddings)
- All capability surfaced through a single standard MCP endpoint — runtime-agnostic, no Sovereign internals exposed to the AI adapter layer
