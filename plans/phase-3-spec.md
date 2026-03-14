# Phase 3: Config & Protocol — Specification

**Status:** Draft **Revision:** 4 **Date:** 2026-03-12

This document specifies the two modules of Phase 3. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 3 depends on Phase 1 (event bus, auth, notifications, scheduler, status) and Phase 2 (orgs, projects, worktrees, files, git, terminal, IDE shell). All new modules communicate via the event bus.

Phase 3 builds the infrastructure layer while OpenClaw remains the agent runtime. Config management establishes the foundation all modules depend on. The typed WebSocket protocol replaces the raw status connection and enables real-time push for all existing server-side modules.

Memory & embeddings, session store, context compaction, and system prompt assembly are deferred to Phase 6 (Agent Core).

---

## Wave Strategy

**Wave 1 (parallel):** Config, WebSocket Protocol (core transport + channel registry) **Wave 2:** Module WS integrations (status, notifications, scheduler, files, git, terminal, worktrees, orgs) **Wave 3:** Client UI (WS store, reconnection, update StatusBar to use WS store) + integration tests

---

## 1. Config Management

A unified configuration system. Every other module reads its settings from here. Schema-validated, hot-reloadable, environment-overridable.

### Requirements

- The config store MUST maintain all Sovereign configuration in a single JSON file at `{dataDir}/config.json`.
- The config MUST be validated against a JSON Schema definition before every write. Invalid config writes MUST be rejected with detailed validation errors.
- The config store MUST support **hot-reload** — changes applied via the API update the in-memory config object and emit events. No process restarts, no connection drops, no interrupted in-flight work. Modules pick up new values on their next read or via bus subscription.
- The config store MUST support **namespaced access** using dot-path notation: `get('memory.ollama.url')`, `set('memory.ollama.url', 'http://...')`.
- The config store MUST support **patch** operations — partial updates deep-merged into existing config.
- The config store MUST support **defaults** — every config key has a default value. `get()` returns the merged result of defaults + user overrides.
- The config store MUST emit `config.changed` events on the bus with `{ path, oldValue, newValue }`.
- The config store MUST maintain a **change history** at `{dataDir}/config-history.jsonl` — each change logged with timestamp, key path, old value, new value, and source (`api` | `file` | `env` | `startup`).
- The config store MUST support **environment variable overrides** — env vars like `SOVEREIGN_TERMINAL__SHELL` (double underscore as path separator) override config file values. Env overrides take precedence over file values but are NOT written to disk.
- The config store MUST NOT apply invalid config — validation happens before write, failed validation returns the errors to the caller.
- The config store MUST load and validate on startup, applying defaults for any missing keys.
- The config store MUST expose a REST API:
  - `GET /api/config` — full resolved config (defaults + file + env)
  - `GET /api/config/:path` — namespaced read (dot-path in URL, e.g. `/api/config/memory.ollama.url`)
  - `PATCH /api/config` — partial update (validate, merge, write, emit)
  - `GET /api/config/schema` — JSON Schema definition
  - `GET /api/config/history` — change history with pagination
  - `POST /api/config/export` — download full config
  - `POST /api/config/import` — upload, validate, apply
- The config store SHOULD support config presets — named configurations (e.g. `"development"`, `"production"`) that can be applied as a batch.
- The config store MAY support config diffing — show differences between current and proposed config before applying.

### Default Config Schema

```typescript
interface SovereignConfig {
  server: {
    port: number // default: 3001
    host: string // default: 'localhost'
  }
  terminal: {
    shell: string // default: process.env.SHELL || '/bin/zsh'
    gracePeriodMs: number // default: 30000
    maxSessions: number // default: 10
  }
  worktrees: {
    staleDays: number // default: 14
    autoCleanupMerged: boolean // default: false
  }
  projects: {
    defaults: {
      // Per-project defaults — individual projects override via projects.{projectId}.*
      remotes: [] // default: [] (configured per project at creation)
    }
  }
}
```

### Interface

```typescript
interface ConfigStore {
  get<T = unknown>(path?: string): T
  set(path: string, value: unknown): void
  patch(partial: Record<string, unknown>): void
  getSchema(): object
  getHistory(opts?: { limit?: number; offset?: number }): ConfigChange[]
  exportConfig(): SovereignConfig
  importConfig(config: unknown): void // validates, then applies
  onChange(path: string, handler: (change: ConfigChange) => void): () => void
}

interface ConfigChange {
  timestamp: string
  path: string
  oldValue: unknown
  newValue: unknown
  source: 'api' | 'file' | 'env' | 'startup'
}
```

### Files

```
packages/server/src/config/
├── config.ts            # Core config store (get/set/patch, hot-reload)
├── config.test.ts       # Unit tests
├── types.ts             # SovereignConfig, ConfigChange types
├── schema.ts            # JSON Schema definition + validation
├── schema.test.ts       # Schema validation tests
├── defaults.ts          # Default values
├── env.ts               # Environment variable override resolution
├── env.test.ts          # Env override tests
├── history.ts           # Change history (JSONL append)
└── routes.ts            # Express REST API router
```

---

## 2. WebSocket Protocol

A typed, multiplexed WebSocket transport layer. Like the event bus, this is **infrastructure** — it provides connection management, auth, subscriptions, and multiplexing. Individual modules register their own channels and message types. The WS module does NOT hardcode knowledge of any specific module's messages.

### Requirements

#### Core Transport

- The server MUST expose a single WebSocket endpoint at `/ws`, replacing the current raw status-only WS from Phase 2.
- All WebSocket messages MUST be JSON objects with a `type` string discriminator.
- The server MUST support **multiplexing** — a single WS connection carries all event types. Events are scoped by optional `orgId`, `projectId`, or `sessionId` fields.
- The server MUST track **subscriptions** per connection — only send events the client has subscribed to. Default subscriptions on connect: `['status']`.
- The server MUST authenticate WebSocket connections using the auth module (token as query parameter `?token=...` or in the first message).
- The server MUST gracefully handle disconnections — clean up subscriptions, invoke channel `onDisconnect` callbacks, emit `ws.disconnected` on the bus.
- The server MUST emit `ws.connected` and `ws.disconnected` events on the bus with the device ID.
- Binary frames MUST be supported — binary frames use a 1-byte channel ID prefix followed by payload. Channel IDs are assigned during channel registration.

#### Built-in Messages (transport-level only)

- `subscribe` (client → server) — subscribe to channels for a scope (`{ channels: string[], scope?: { orgId?, projectId?, sessionId? } }`)
- `unsubscribe` (client → server) — unsubscribe from channels
- `ping` (client → server) / `pong` (server → client) — keepalive
- `error` (server → client) — transport/auth error with code and message
- `ack` (server → client) — optional acknowledgement (`{ ackId }`)

#### Channel Registration API

- The WS module MUST expose a `registerChannel()` API that other modules call during init to declare their channels and message types.
- `registerChannel(name, options)` where options include:
  - `serverMessages: string[]` — message types this channel can push to clients
  - `clientMessages: string[]` — message types this channel accepts from clients
  - `binary?: boolean` — whether this channel supports binary frames (assigns a binary channel ID)
  - `onSubscribe?: (deviceId, scope) => void` — called when a client subscribes to this channel
  - `onUnsubscribe?: (deviceId, scope) => void` — called when a client unsubscribes
  - `onDisconnect?: (deviceId) => void` — called on client disconnect (for resource cleanup)
  - `onMessage?: (type, payload, deviceId) => void` — handler for client → server messages on this channel
- Modules MUST register channels before the server starts accepting connections.
- The WS module MUST reject `subscribe` requests for unregistered channels.
- The WS module MUST reject incoming client messages with types not registered to any channel.
- `GET /ws/channels` SHOULD return the list of registered channels and their message types (for debugging/introspection).

#### Client

- The client MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- The client MUST provide a **reactive SolidJS store** that components subscribe to for specific event types. Components MUST NOT manage their own WebSocket connections.
- The client MUST re-subscribe to all active channels on reconnection.
- The protocol SHOULD support message acknowledgement — optional `ackId` field on critical messages, server responds with `{ type: 'ack', ackId }`.
- The protocol MAY support per-message compression (permessage-deflate).

### Interface

```typescript
// Shared types (in @sovereign/core)
interface WsMessage {
  type: string
  timestamp?: string
  ackId?: string
}

interface WsSubscribe extends WsMessage {
  type: 'subscribe'
  channels: string[]
  scope?: { orgId?: string; projectId?: string; sessionId?: string }
}

interface WsError extends WsMessage {
  type: 'error'
  code: string
  message: string
}

// Channel registration (server-side)
interface WsChannelOptions {
  serverMessages: string[]
  clientMessages: string[]
  binary?: boolean
  onSubscribe?: (deviceId: string, scope?: Record<string, string>) => void
  onUnsubscribe?: (deviceId: string, scope?: Record<string, string>) => void
  onDisconnect?: (deviceId: string) => void
  onMessage?: (type: string, payload: unknown, deviceId: string) => void
}

// Server-side
interface WsHandler {
  registerChannel(name: string, options: WsChannelOptions): void
  handleConnection(ws: WebSocket, deviceId: string): void
  broadcast(msg: WsMessage): void
  broadcastToChannel(channel: string, msg: WsMessage, scope?: Record<string, string>): void
  sendTo(deviceId: string, msg: WsMessage): void
  sendBinary(channel: string, data: Buffer, scope?: Record<string, string>): void
  getConnectedDevices(): string[]
  getChannels(): string[]
}

// Client-side
interface WsStore {
  connected: Accessor<boolean>
  subscribe(channels: string[], scope?: Record<string, string>): void
  unsubscribe(channels: string[]): void
  on<T extends WsMessage>(type: string, handler: (msg: T) => void): () => void
  send(msg: WsMessage): void
}
```

### Files

```
packages/core/src/ws/
├── types.ts             # WsMessage, WsSubscribe, WsError, WsChannelOptions
├── protocol.ts          # Message validation, type guards
└── protocol.test.ts     # Protocol validation tests

packages/server/src/ws/
├── handler.ts           # WebSocket connection handler, auth, channel registry
├── handler.test.ts      # Handler tests
├── subscriptions.ts     # Per-connection subscription tracking
├── subscriptions.test.ts
├── binary.ts            # Binary frame encoding/decoding (channel ID prefix)
└── binary.test.ts       # Binary frame tests

packages/client/src/ws/
├── ws-store.ts          # Reactive SolidJS WebSocket store
├── ws-store.test.ts     # Store tests
├── reconnect.ts         # Exponential backoff reconnection
└── reconnect.test.ts    # Reconnection tests
```

---

## 3. Module WebSocket Integrations

When the WebSocket protocol lands, the following **existing modules** from Phases 1 and 2 MUST be updated to register their WS channels. Each module defines its own message types, registers its channel, bridges bus events to WS messages, and handles client→server messages where applicable.

This work is part of Phase 3 — the WS module is useless without at least the core modules wired up.

### 3.1 Status (Phase 1)

Already has a raw WS connection — replace with proper channel registration.

**Channel:** `status` **Server → client:**

- `status.update` — `{ connected: boolean, activeJobs: number, unreadNotifications: number }`

**Bus → WS bridge:** `status.update` bus event → `status.update` WS message

**Files to update:** `packages/server/src/status/`, `packages/client/src/components/status-bar/` **Tests:** Verify status channel registration, subscription delivers status updates, auto-subscribed on connect.

### 3.2 Notifications (Phase 1)

**Channel:** `notifications` **Server → client:**

- `notification.new` — `{ id, title, body, level, timestamp }`
- `notification.read` — `{ id }`

**Bus → WS bridge:** `notification.created` → `notification.new`, `notification.read` → `notification.read`

**Files to update:** `packages/server/src/notifications/` **Tests:** Subscribe to notifications channel, bus event fires, client receives message.

### 3.3 Scheduler (Phase 1)

**Channel:** `scheduler` **Server → client:**

- `scheduler.job.started` — `{ jobId, name }`
- `scheduler.job.completed` — `{ jobId, name, result }`
- `scheduler.job.failed` — `{ jobId, name, error }`

**Bus → WS bridge:** `scheduler.job.*` bus events → matching WS messages

**Files to update:** `packages/server/src/scheduler/` **Tests:** Subscribe to scheduler channel, job lifecycle events pushed to client.

### 3.4 Files (Phase 2)

**Channel:** `files` **Server → client:**

- `file.changed` — `{ orgId, projectId, path, kind: 'created' | 'modified' | 'deleted' }`

**Bus → WS bridge:** `file.created`, `file.deleted` → `file.changed`

**Files to update:** `packages/server/src/files/` **Tests:** Subscribe to files channel with project scope, file bus event delivered to subscribed clients only.

### 3.5 Git (Phase 2)

**Channel:** `git` **Server → client:**

- `git.status` — `{ orgId, projectId, branch, ahead, behind, staged, modified, untracked }`

**Bus → WS bridge:** `git.status.changed` → `git.status` (if the git module emits this — may need to add the bus event)

**Files to update:** `packages/server/src/git/` **Tests:** Subscribe to git channel with project scope, status change pushed to client.

### 3.6 Terminal (Phase 2)

**Channel:** `terminal` **Server → client:**

- `terminal.data` — binary frame (terminal output)
- `terminal.created` — `{ sessionId, shell, cwd }`
- `terminal.closed` — `{ sessionId, exitCode }`

**Client → server:**

- `terminal.input` — binary frame (terminal input)
- `terminal.resize` — `{ sessionId, cols, rows }`

**Binary:** Yes (channel ID assigned at registration). Binary frames carry raw PTY data.

**Callbacks:**

- `onSubscribe` — attach client to terminal session
- `onUnsubscribe` / `onDisconnect` — detach client, optionally grace-period close

**Bus → WS bridge:** `terminal.created`, `terminal.closed` bus events → matching WS messages. Terminal data bypasses the bus (direct binary push for performance).

**Files to update:** `packages/server/src/terminal/` **Tests:** Subscribe to terminal channel with sessionId scope, input/output round-trip, resize, disconnect cleanup.

### 3.7 Worktrees (Phase 2)

**Channel:** `worktrees` **Server → client:**

- `worktree.update` — `{ orgId, projectId, worktreeId, status, branch }`
- `worktree.stale` — `{ orgId, projectId, worktreeId, staleDays }`

**Bus → WS bridge:** `worktree.created`, `worktree.removed`, `worktree.stale` → matching WS messages

**Files to update:** `packages/server/src/worktrees/` **Tests:** Subscribe to worktrees channel, worktree lifecycle events pushed to client.

### 3.8 Orgs (Phase 2)

**Channel:** `orgs` **Server → client:**

- `org.created` — `{ orgId, name }`
- `org.updated` — `{ orgId, changes }`
- `org.deleted` — `{ orgId }`

**Bus → WS bridge:** `org.*` bus events → matching WS messages

**Files to update:** `packages/server/src/orgs/` **Tests:** Subscribe to orgs channel, org lifecycle events pushed to client.

### Summary

| Module | Channel | Server→Client | Client→Server | Binary | Phase |
| --- | --- | --- | --- | --- | --- |
| Status | `status` | `status.update` | — | No | 1 |
| Notifications | `notifications` | `notification.new`, `notification.read` | — | No | 1 |
| Scheduler | `scheduler` | `scheduler.job.*` | — | No | 1 |
| Files | `files` | `file.changed` | — | No | 2 |
| Git | `git` | `git.status` | — | No | 2 |
| Terminal | `terminal` | `terminal.data`, `terminal.created`, `terminal.closed` | `terminal.input`, `terminal.resize` | Yes | 2 |
| Worktrees | `worktrees` | `worktree.update`, `worktree.stale` | — | No | 2 |
| Orgs | `orgs` | `org.created`, `org.updated`, `org.deleted` | — | No | 2 |

Future modules (Phase 4: issues, reviews, radicle; Phase 6: sessions, agents) will register their own channels following the same pattern.

## Cross-Cutting Concerns

### Integration Tests

Phase 3 MUST include integration tests covering:

- Config change via API → module picks up new value (e.g. change `terminal.shell` → terminal module uses new shell on next session)
- WebSocket channel registration → subscribe → bus event fires → client receives typed message
- WebSocket auth — reject connection without valid token
- WebSocket subscribe to unregistered channel → error
- WebSocket client message with unregistered type → error
- Terminal binary round-trip: client sends binary input → terminal processes → binary output received
- Module disconnect callback: terminal client disconnects → onDisconnect fires → terminal grace period starts
- All new REST endpoints protected by auth middleware

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1 + 2 directories)
├── config.json              # Unified configuration
└── config-history.jsonl     # Config change log
```

### Dependencies (New)

**Server:**

- `ajv` — JSON Schema validation for config

**Core:**

- WebSocket protocol types (shared between client and server)

**Client:**

- No new external dependencies (SolidJS stores + existing infrastructure)

### Module Registration

All Phase 3 server modules MUST follow the established pattern:

- Export `create*(bus: EventBus, dataDir: string, ...deps)` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@sovereign/core`
- Express routers mounted by the main server, not self-mounting
- Read configuration from the config module, not from environment directly (except config module itself, which reads env for bootstrapping)

### Testing

- Unit tests per module following established patterns (Vitest, temp directories, injectable bus).
- Integration tests in `packages/server/src/__integration__/phase3.test.ts`.
- Client WebSocket store tests using a mock WebSocket.
