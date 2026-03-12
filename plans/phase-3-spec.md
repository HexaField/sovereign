# Phase 3: Config & Protocol — Specification

**Status:** Draft **Revision:** 4 **Date:** 2026-03-12

This document specifies the two modules of Phase 3. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 3 depends on Phase 1 (event bus, auth, notifications, scheduler, status) and Phase 2 (orgs, projects, worktrees, files, git, terminal, IDE shell). All new modules communicate via the event bus.

Phase 3 builds the infrastructure layer while OpenClaw remains the agent runtime. Config management establishes the foundation all modules depend on. The typed WebSocket protocol replaces the raw status connection and enables real-time push for all existing server-side modules.

Memory & embeddings, session store, context compaction, and system prompt assembly are deferred to Phase 6 (Agent Core).

---

## Wave Strategy

**Wave 1 (parallel):** Config, WebSocket Protocol **Wave 2:** Client UI components + integration tests

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
- The config store MUST support **environment variable overrides** — env vars like `SOVEREIGN_MEMORY__OLLAMA__URL` (double underscore as path separator) override config file values. Env overrides take precedence over file values but are NOT written to disk.
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
  memory: {
    enabled: boolean // default: true
    ollama: {
      url: string // default: 'http://localhost:11434'
      model: string // default: 'nomic-embed-text'
    }
    chunkSize: number // default: 512
    chunkOverlap: number // default: 64
    watchDirs: string[] // default: []
    watchDebounceMs: number // default: 2000
    excludePatterns: string[] // default: ['node_modules', '.git', 'dist', 'build']
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
  git: {
    protectedBranches: string[] // default: ['main', 'master', 'dev']
  }
  review: {
    autoAssign: boolean // default: false
    requireApproval: boolean // default: true
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

A typed, multiplexed WebSocket protocol replacing the raw status connection. All real-time communication between client and server flows through this single connection.

### Requirements

- The server MUST expose a single WebSocket endpoint at `/ws`, replacing the current raw status-only WS from Phase 2.
- All WebSocket messages MUST be JSON objects with a `type` string discriminator.
- The protocol MUST support these server → client message types:
  - `status.update` — system status (connection state, active jobs, unread notifications)
  - `session.message` — new message in a subscribed session
  - `notification.new` — new notification
  - `file.changed` — file change event (path, kind: created/modified/deleted)
  - `terminal.data` — terminal output (sessionId + base64-encoded data)
  - `git.status` — git status changed for a project
  - `worktree.update` — worktree state change
  - `review.update` — review status change
  - `error` — server-side error with code and message
  - `pong` — keepalive response
- The protocol MUST support these client → server message types:
  - `subscribe` — subscribe to event channels for a scope (`{ channels: ['terminal', 'files', 'git'], scope?: { orgId, projectId, sessionId } }`)
  - `unsubscribe` — unsubscribe from channels
  - `terminal.input` — terminal input data (sessionId + base64 data)
  - `terminal.resize` — terminal resize (sessionId + cols + rows)
  - `ping` — keepalive
- The server MUST support **multiplexing** — a single WS connection carries all event types. Events are scoped by optional `orgId`, `projectId`, or `sessionId` fields.
- The server MUST track **subscriptions** per connection — only send events the client has subscribed to. Default subscriptions on connect: `['status']`.
- The server MUST respond to `ping` with `pong`.
- The server MUST authenticate WebSocket connections using the auth module (token as query parameter `?token=...` or in the first message).
- The server MUST bridge existing bus events to WebSocket messages — when `file.created` fires on the bus, connected clients subscribed to `files` receive a `file.changed` message.
- The server MUST gracefully handle disconnections — clean up subscriptions, detach terminal sessions, emit `ws.disconnected` on the bus.
- The server MUST emit `ws.connected` and `ws.disconnected` events on the bus with the device ID.
- Binary frames MUST be supported for terminal data — binary frames use a 1-byte channel ID prefix followed by payload. Channel 0 = terminal.
- The client MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- The client MUST provide a **reactive SolidJS store** that components subscribe to for specific event types. Components MUST NOT manage their own WebSocket connections.
- The client MUST re-subscribe to all active channels on reconnection.
- The protocol SHOULD support message acknowledgement — optional `ackId` field on critical messages, server responds with `{ type: 'ack', ackId }`.
- The protocol MAY support per-message compression (permessage-deflate).

### Interface

```typescript
// Shared types (in @template/core)
interface WsMessage {
  type: string
  timestamp?: string
  ackId?: string
}

interface WsStatusUpdate extends WsMessage {
  type: 'status.update'
  status: { connected: boolean; activeJobs: number; unreadNotifications: number }
}

interface WsFileChanged extends WsMessage {
  type: 'file.changed'
  orgId: string
  projectId: string
  path: string
  kind: 'created' | 'modified' | 'deleted'
}

interface WsTerminalData extends WsMessage {
  type: 'terminal.data'
  sessionId: string
  data: string // base64
}

interface WsTerminalInput extends WsMessage {
  type: 'terminal.input'
  sessionId: string
  data: string // base64
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

// Server-side
interface WsHandler {
  handleConnection(ws: WebSocket, deviceId: string): void
  broadcast(msg: WsMessage): void
  broadcastToChannel(channel: string, msg: WsMessage, scope?: object): void
  sendTo(deviceId: string, msg: WsMessage): void
  getConnectedDevices(): string[]
}

// Client-side
interface WsStore {
  connected: Accessor<boolean>
  subscribe(channels: string[], scope?: object): void
  unsubscribe(channels: string[]): void
  on<T extends WsMessage>(type: string, handler: (msg: T) => void): () => void
  send(msg: WsMessage): void
}
```

### Files

```
packages/core/src/ws/
├── types.ts             # All WsMessage types (shared client + server)
├── protocol.ts          # Message validation, type guards, channel constants
└── protocol.test.ts     # Protocol validation tests

packages/server/src/ws/
├── handler.ts           # WebSocket connection handler + auth
├── handler.test.ts      # Handler tests
├── subscriptions.ts     # Per-connection subscription tracking
├── subscriptions.test.ts
├── bridge.ts            # Bus event → WS message bridging
├── bridge.test.ts       # Bridge tests
└── binary.ts            # Binary frame encoding/decoding

packages/client/src/ws/
├── ws-store.ts          # Reactive SolidJS WebSocket store
├── ws-store.test.ts     # Store tests
├── reconnect.ts         # Exponential backoff reconnection
└── reconnect.test.ts    # Reconnection tests
```

## Cross-Cutting Concerns

### Integration Tests

Phase 3 MUST include integration tests covering:

- Config change via API → module picks up new value (e.g. change `terminal.shell` → terminal module uses new shell on next session)
- WebSocket subscribe to channel → bus event fires → client receives typed message
- WebSocket auth — reject connection without valid token
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
- Communicate only via event bus and shared types from `@template/core`
- Express routers mounted by the main server, not self-mounting
- Read configuration from the config module, not from environment directly (except config module itself, which reads env for bootstrapping)

### Testing

- Unit tests per module following established patterns (Vitest, temp directories, injectable bus).
- Integration tests in `packages/server/src/__integration__/phase3.test.ts`.
- Client WebSocket store tests using a mock WebSocket.
