# Phase 1: Foundation — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-12

This document specifies the five foundation modules of Sovereign. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

---

## 0. Event Bus

The event bus is the integration surface for all modules (Principle 3). It is specified first because every other module depends on it.

### Requirements

- The bus MUST be an in-process typed event emitter with synchronous and asynchronous subscriber support.
- Every event MUST have a `type` string, a `timestamp` (ISO 8601), and a `source` string identifying the emitting module.
- The bus MUST support wildcard subscriptions (e.g. `scheduler.*`, `*`).
- The bus MUST support typed event definitions via TypeScript generics or a discriminated union — subscribers MUST receive correctly typed payloads.
- The bus MUST log every event to a rolling event log file (`{dataDir}/events/YYYY-MM-DD.jsonl`) for auditability (Principle 7).
- The bus MUST expose a `replay(filter, range)` function to replay historical events from the log.
- The bus MUST NOT silently swallow subscriber errors — errors MUST be caught, logged, and emitted as `bus.error` events.
- The bus SHOULD support backpressure: if a subscriber is slow, the bus SHOULD queue events for that subscriber rather than dropping them.
- The bus MAY support priority levels for subscribers (e.g. system-critical before UI updates).
- The bus MUST be the only mechanism for cross-module state communication. Direct imports of another module's internal state are forbidden.

### Interface

```typescript
interface BusEvent {
  type: string
  timestamp: string
  source: string
  payload: unknown
}

interface EventBus {
  emit(event: BusEvent): void
  on(pattern: string, handler: (event: BusEvent) => void | Promise<void>): Unsubscribe
  once(pattern: string, handler: (event: BusEvent) => void | Promise<void>): Unsubscribe
  replay(filter: { pattern?: string; after?: string; before?: string }): AsyncIterable<BusEvent>
  history(filter: { pattern?: string; limit?: number }): BusEvent[]
}
```

### Files

```
packages/core/src/bus/
├── bus.ts              # EventBus implementation
├── bus.test.ts         # Unit tests
├── types.ts            # Event type definitions & discriminated union
└── logger.ts           # File-backed event log writer/reader
```

---

## 1. Scheduler

Deterministic, code-driven job scheduling. Replaces OpenClaw's cron system with something that fires reliably every time (Principle 9).

### Requirements

- The scheduler MUST support three schedule types: **cron expression**, **fixed interval**, and **one-shot at timestamp**.
- The scheduler MUST persist all job definitions to disk (`{dataDir}/scheduler/jobs.json`) as the single source of truth (Principle 5, 6).
- The scheduler MUST recover all jobs from disk on startup — no job loss across restarts.
- The scheduler MUST emit `scheduler.job.due`, `scheduler.job.started`, `scheduler.job.completed`, and `scheduler.job.failed` events on the bus.
- The scheduler MUST NOT execute job logic itself — it MUST only emit `scheduler.job.due` with the job payload. Execution is the responsibility of the subscriber.
- The scheduler MUST support job CRUD at runtime without restart (Principle 4). Changes MUST be persisted to disk immediately.
- The scheduler MUST track run history per job (`{dataDir}/scheduler/runs/`) with start time, end time, status, and error if any.
- The scheduler MUST support `--delete-after-run` semantics for one-shot jobs.
- The scheduler MUST NOT depend on any LLM or agent system.
- The scheduler SHOULD support timezone-aware cron expressions.
- The scheduler SHOULD expose a `nextRun(jobId)` function returning the next scheduled fire time.
- The scheduler MAY support job tags/labels for filtering.
- The scheduler MUST NOT allow two instances of the same job to run concurrently by default. A `concurrency` option MAY override this.

### Interface

```typescript
interface Job {
  id: string
  name: string
  schedule: CronSchedule | IntervalSchedule | OneshotSchedule
  payload: Record<string, unknown>
  enabled: boolean
  tags?: string[]
  concurrency?: number // default 1
  deleteAfterRun?: boolean
  createdAt: string
  updatedAt: string
}

interface CronSchedule {
  kind: 'cron'
  expr: string
  tz?: string
}
interface IntervalSchedule {
  kind: 'interval'
  everyMs: number
  anchorMs?: number
}
interface OneshotSchedule {
  kind: 'oneshot'
  at: string
}

interface RunRecord {
  id: string
  jobId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
  error?: string
}

interface Scheduler {
  add(job: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job
  update(jobId: string, patch: Partial<Job>): Job
  remove(jobId: string): void
  get(jobId: string): Job | undefined
  list(filter?: { tags?: string[]; enabled?: boolean }): Job[]
  nextRun(jobId: string): string | null
  runs(jobId: string, limit?: number): RunRecord[]
  trigger(jobId: string): void // manually fire a job now
}
```

### Files

```
packages/server/src/scheduler/
├── scheduler.ts         # Core scheduler loop & job management
├── scheduler.test.ts    # Unit tests
├── types.ts             # Job, schedule, run record types
├── store.ts             # File-backed job persistence (read/write jobs.json)
└── cron.ts              # Cron expression parser/next-time calculator

data/scheduler/
├── jobs.json            # Job definitions (source of truth)
└── runs/                # Run history per job
    └── {jobId}.jsonl
```

---

## 2. Webhook Receiver

Receives external events (GitHub, Radicle, arbitrary) and routes them into the event bus with classification.

### Requirements

- The receiver MUST expose `POST /api/hooks/:source` endpoints, where `:source` identifies the sender (e.g. `github`, `radicle`, `custom`).
- The receiver MUST verify webhook signatures where applicable — GitHub webhooks MUST be verified via HMAC-SHA256. Unverified requests MUST be rejected with 401.
- The receiver MUST emit a `webhook.received` event on the bus with the raw payload, source, and headers.
- The receiver MUST classify incoming webhooks into categories configurable per source. Default categories: `void` (ignore), `notify` (inform user), `sync` (update local mirror), `agent` (trigger agent action).
- Classification rules MUST be defined in a config file (`{dataDir}/webhooks/rules.json`) and MUST be hot-reloadable (Principle 4).
- The receiver MUST persist every received webhook to disk (`{dataDir}/webhooks/events/`) before processing — no event loss (Principle 6).
- The receiver MUST respond to the sender with 200 immediately after persisting, before classification or bus emission — webhook senders MUST NOT be blocked by internal processing.
- The receiver MUST NOT execute any business logic — it classifies and emits. Subscribers handle the rest.
- The receiver SHOULD support a replay endpoint: `POST /api/hooks/:source/replay/:eventId` to re-emit a stored event.
- The receiver MAY support configurable rate limiting per source.

### Interface

```typescript
interface WebhookEvent {
  id: string
  source: string
  receivedAt: string
  headers: Record<string, string>
  body: unknown
  classification: 'void' | 'notify' | 'sync' | 'agent'
  signature?: { algorithm: string; verified: boolean }
}

interface ClassificationRule {
  source: string
  match: Record<string, unknown> // JSON path conditions on the body
  classification: WebhookEvent['classification']
  priority: number // higher wins on conflict
}

interface WebhookReceiver {
  rules(): ClassificationRule[]
  updateRules(rules: ClassificationRule[]): void
  events(filter?: { source?: string; classification?: string; limit?: number }): WebhookEvent[]
  replay(eventId: string): void
}
```

### Files

```
packages/server/src/webhooks/
├── receiver.ts          # Express router & signature verification
├── receiver.test.ts     # Unit tests
├── classify.ts          # Rule engine for classification
├── types.ts             # Event & rule types
└── store.ts             # File-backed event persistence

data/webhooks/
├── rules.json           # Classification rules (hot-reloadable)
└── events/
    └── YYYY-MM-DD.jsonl # Raw webhook events by date
```

---

## 3. Auth Layer

Server-side authentication and device identity verification. All API access MUST be authenticated.

### Requirements

- The auth layer MUST support Ed25519 device identity — each client generates a keypair, registers with the server, and signs requests or session tokens.
- The auth layer MUST maintain a device registry (`{dataDir}/auth/devices.json`) as the source of truth for known devices.
- New devices MUST require explicit approval before gaining access — the auth layer MUST emit `auth.device.pending` on the bus and MUST NOT grant access until approved.
- The auth layer MUST issue session tokens (JWT or similar) after device authentication. Tokens MUST have configurable expiry.
- The auth layer MUST expose Express middleware that rejects unauthenticated requests with 401.
- The auth layer MUST support Tailscale trusted proxy detection — requests from trusted proxies MAY bypass device auth if the Tailscale identity is verified.
- The auth layer MUST NOT store private keys server-side — private keys live only on the client device.
- The auth layer MUST emit `auth.device.approved`, `auth.device.rejected`, `auth.session.created`, `auth.session.expired` events on the bus.
- The auth layer SHOULD support device revocation — a revoked device's sessions MUST be invalidated immediately.
- The auth layer SHOULD support multiple concurrent sessions per device.
- The auth layer MAY support scoped permissions per device in future phases, but Phase 1 MUST treat all approved devices as fully trusted.
- The auth layer MUST NOT depend on any external auth provider (no OAuth, no third-party SSO). This is a sovereign system.

### Interface

```typescript
interface Device {
  id: string
  publicKey: string // Ed25519 public key, hex or base64
  name: string
  status: 'pending' | 'approved' | 'revoked'
  createdAt: string
  approvedAt?: string
  lastSeen?: string
}

interface Session {
  token: string
  deviceId: string
  createdAt: string
  expiresAt: string
}

interface Auth {
  registerDevice(publicKey: string, name: string): Device
  approveDevice(deviceId: string): Device
  rejectDevice(deviceId: string): void
  revokeDevice(deviceId: string): void
  devices(): Device[]
  authenticate(signature: string, challenge: string): Session
  validateToken(token: string): { valid: boolean; deviceId?: string }
  middleware(): express.RequestHandler
}
```

### Files

```
packages/server/src/auth/
├── auth.ts              # Core auth logic, token issuance
├── auth.test.ts         # Unit tests
├── middleware.ts         # Express middleware
├── devices.ts           # Device registry (file-backed)
├── types.ts             # Device, session types
└── crypto.ts            # Ed25519 verification utilities

data/auth/
├── devices.json         # Device registry (source of truth)
└── sessions/            # Active sessions (optional, can be memory-only with file backup)
```

---

## 4. Notifications

Server-side notification queue with real-time push to connected clients. The user MUST always know what's happening (Principle 7).

### Requirements

- The notification module MUST maintain an ordered notification queue persisted to disk (`{dataDir}/notifications/notifications.jsonl`).
- Each notification MUST have: `id`, `timestamp`, `severity` (info | warning | error | critical), `title`, `body`, `source` (module that created it), `read` status, and optional `action` (a structured payload describing what the user can do about it).
- The notification module MUST subscribe to the event bus and generate notifications from relevant events. The mapping from events to notifications MUST be configurable (`{dataDir}/notifications/rules.json`) and hot-reloadable.
- The notification module MUST push new notifications to connected clients in real-time via WebSocket.
- The notification module MUST support Web Push for background tab / offline alerts. Web Push subscription management MUST be per-device.
- The notification module MUST NOT generate notifications for `void`-classified webhook events.
- The notification module MUST support marking notifications as read, dismissing, and bulk operations.
- The notification module MUST expose a REST API for listing, filtering, and managing notifications.
- The notification module SHOULD support notification grouping — related notifications (e.g. multiple CI failures on the same project) SHOULD collapse into a group.
- The notification module SHOULD support notification TTL — old notifications MAY be auto-archived after a configurable period.
- The notification module MUST NOT block the event bus — notification generation MUST be asynchronous.

### Interface

```typescript
interface Notification {
  id: string
  timestamp: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  title: string
  body: string
  source: string
  read: boolean
  dismissed: boolean
  group?: string
  action?: { type: string; payload: Record<string, unknown> }
}

interface NotificationRule {
  eventPattern: string // bus event pattern to match
  severity: Notification['severity']
  titleTemplate: string // template with {{event.payload.x}} interpolation
  bodyTemplate: string
  group?: string
}

interface Notifications {
  list(filter?: { severity?: string; read?: boolean; limit?: number; offset?: number }): Notification[]
  unreadCount(): number
  markRead(ids: string[]): void
  dismiss(ids: string[]): void
  pushSubscribe(deviceId: string, subscription: PushSubscription): void
  pushUnsubscribe(deviceId: string): void
}
```

### Files

```
packages/server/src/notifications/
├── notifications.ts     # Core notification logic & bus subscription
├── notifications.test.ts
├── types.ts             # Notification & rule types
├── push.ts              # Web Push integration
├── store.ts             # File-backed notification persistence
└── rules.ts             # Event-to-notification rule engine

data/notifications/
├── notifications.jsonl  # Notification log (append-only)
├── rules.json           # Event-to-notification mapping (hot-reloadable)
└── push/                # Web Push subscriptions per device
```

---

## 5. Status Bar

A persistent UI element presencing system state to the user at all times (Principle 7, 8).

### Requirements

- The status bar MUST be rendered at the bottom of the viewport on all screen sizes.
- The status bar MUST display: connection status (WS connected/disconnected/reconnecting), active module indicators, and notification badge (unread count).
- The status bar MUST update in real-time — connection state changes MUST reflect within 1 second.
- The status bar MUST show a persistent indicator when any background job is running (scheduler jobs, webhook processing, etc.), with a count of active jobs.
- The status bar MUST NOT hide or obscure information — if the system is busy, the user sees it.
- The status bar SHOULD be collapsible on mobile to a single-line summary, expandable on tap (Principle 8).
- The status bar SHOULD show the current org and project context when one is selected.
- The status bar MAY show additional indicators in later phases (active agent, model, branch, etc.) — the design MUST accommodate future extension without layout changes.
- The status bar MUST NOT poll for state — it MUST receive updates via WebSocket events pushed from the server.
- The status bar MUST indicate when the server is unreachable and MUST auto-reconnect with exponential backoff.

### Interface

```typescript
// Server → Client WS event
interface StatusUpdate {
  type: 'status.update'
  payload: {
    connection: 'connected' | 'disconnected' | 'reconnecting'
    activeJobs: number
    unreadNotifications: number
    org?: string
    project?: string
    modules: { name: string; status: 'ok' | 'degraded' | 'error' }[]
  }
}
```

### Client Component

```typescript
// SolidJS component
interface StatusBarProps {
  // Receives reactive state from WS connection
}
```

### Files

```
packages/client/src/components/status-bar/
├── StatusBar.tsx         # SolidJS component
├── StatusBar.stories.tsx # Storybook stories
├── StatusBar.test.tsx    # Component tests
└── status-bar.css        # Styles (if not pure Tailwind)

packages/server/src/status/
├── status.ts             # Aggregates module states, emits StatusUpdate via WS
├── status.test.ts
└── types.ts
```

---

## Cross-Cutting Concerns

### Data Directory

All runtime data lives under a configurable data directory. The default MUST be `~/.sovereign/`. The path MUST be configurable via the `SOVEREIGN_DATA_DIR` environment variable. The data directory MUST NOT live inside the repo — it is user data, not project data. The structure is:

```
~/.sovereign/
├── events/              # Bus event log (YYYY-MM-DD.jsonl)
├── scheduler/
│   ├── jobs.json
│   └── runs/
├── webhooks/
│   ├── rules.json
│   └── events/
├── auth/
│   ├── devices.json
│   └── sessions/
├── notifications/
│   ├── notifications.jsonl
│   ├── rules.json
│   └── push/
└── config/              # Runtime config (Phase 1 minimal, expanded in Phase 3)
```

### Module Registration

- Every module MUST export an `init(bus: EventBus): void` function that subscribes to relevant events and starts its work.
- Every module MUST export a `status(): ModuleStatus` function returning its current health and key metrics.
- Modules MUST NOT import from other modules' internal files — only from the bus and from `packages/core` shared types.

### WebSocket Protocol (Phase 1 Minimal)

- The server MUST expose a WebSocket endpoint for real-time client communication.
- Phase 1 events: `status.update`, `notification.new`, `notification.read`.
- The protocol MUST be typed — every WS message MUST have a `type` discriminator.
- The protocol MUST support reconnection with missed-event replay from the event log.

### Testing

- Every module MUST have unit tests covering core logic.
- Tests MUST NOT require a running server — test the module functions directly.
- Integration tests MAY use a test server instance for HTTP/WS endpoint testing.
- The event bus MUST be injectable — tests MUST use a test bus, not the singleton.
