# Phase 7: Observability — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-14

This document specifies the Observability phase. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 7 depends on Phase 1 (event bus, notifications, scheduler, status), Phase 3 (WebSocket protocol, config), Phase 4 (issues, review), and Phase 6 (chat, threads). It enhances the existing System view (Phase UI Refactor) and notification system (Phase 1) with real-time observability, entity-scoped grouping, and a live event viewer.

---

## What Exists

The following infrastructure is already in place — Phase 7 builds ON TOP of these, not replacing them:

**Server:**

- `system.ts` — `createSystemModule()` with `registerModule()`, `getArchitecture()`, `getHealth()`. 18 modules registered. Returns health metrics (connection, resources, jobs, errors). Routes at `/api/system/{architecture,health}`.
- `system/ws.ts` — `registerLogsChannel()` with `LogsChannel` that buffers up to 1000 entries, broadcasts via WS, and sends history on subscribe.
- `notifications/` — Full notification system: `NotificationStore` (JSONL persistence), `RuleEngine` (event pattern matching → notification generation), `PushManager`. Subscribes to `bus.on('*')`, matches events against rules, creates notifications. REST API exists but is NOT wired into `index.ts` yet.
- `notifications/ws.ts` — WS channel for notifications (registered in index.ts).
- `status/status.ts` — `StatusAggregator` with debounced status updates, module reporters.
- Event bus — 81+ `bus.emit` calls across all modules. All events flow through one bus.

**Client:**

- `SystemView.tsx` — 6-tab layout (Architecture, Logs, Health, Config, Devices, Jobs).
- `ArchitectureTab.tsx` — Card grid of modules with status badges, subscribes/publishes lists. Polls `/api/system/architecture` every 5s.
- `HealthTab.tsx` — 5 health cards (Connection, Resources, Jobs, Cache, Errors). Polls `/api/system/health` every 10s.
- `LogsTab.tsx` — Filterable log viewer with level badges, module filter, text search, auto-scroll. Has WS comment stub but not wired.
- `ConfigTab.tsx`, `DevicesTab.tsx`, `JobsTab.tsx` — functional shells.
- `NotificationFeed.tsx` — In dashboard, shows flat notification list with mark-all-read.
- `NotificationsPanel.tsx` — In workspace sidebar, flat notification list.

**What's missing (this phase delivers):**

1. Notifications not wired in `index.ts` (module created but not mounted)
2. LogsTab not connected to WS `logs` channel
3. No entity-scoped notification grouping
4. No live event viewer / event stream
5. Architecture tab is static polling — no WS live updates
6. Health tab is static polling — no WS live updates
7. No notification routes wired
8. Log entries not emitted from modules (LogsChannel exists but nothing calls `log()`)
9. Canvas view event flow visualization is a stub

---

## Wave Strategy

**Wave 1 (parallel):** Server-side wiring — notification routes, structured logging across modules, event stream service **Wave 2 (parallel):** Client-side wiring — LogsTab WS, entity-scoped notifications, live Architecture/Health via WS **Wave 3:** Event stream viewer + Canvas event flow **Wave 4:** Integration tests + polish

---

## 1. Server-Side Logging Infrastructure

A structured logging system that captures events from all modules and delivers them in real-time to the client.

### Requirements

- The `LogsChannel` returned by `registerLogsChannel()` MUST be injected into all modules that emit operational events. Modules MUST call `logsChannel.log({ level, module, message })` for significant operations.
- The following modules MUST emit log entries:
  - `orgs` — org created/updated/deleted
  - `files` — file created/deleted, watcher events
  - `git` — status changes, stage/unstage/commit/push operations
  - `terminal` — session created/closed, errors
  - `worktrees` — created/removed/stale
  - `config` — config changed (with path), validation errors
  - `diff` — changeset created/updated/closed
  - `issues` — issue created/updated/synced, sync errors
  - `review` — review created/updated/merged, comment added
  - `radicle` — repo operations, peer connections
  - `planning` — graph updated, cycle detected, sync completed
  - `chat` — session connected/disconnected, message sent/received
  - `threads` — thread created/switched, entity bound/unbound
  - `scheduler` — job started/completed/failed
  - `notifications` — notification generated, push delivered
  - `system` — health check, module status change
- Log entries MUST include: `timestamp` (ISO string), `level` (`debug` | `info` | `warn` | `error`), `module` (string), `message` (string).
- Log entries MAY include: `entityId` (string, optional — the issue/PR/branch this log relates to), `threadKey` (string, optional — the thread this log was generated in context of), `metadata` (Record<string, unknown>, optional — structured data).
- The implementation pattern MUST be lightweight: a `log` function passed to module factories, not a heavy logging framework. Modules MUST NOT import the system module directly.
- Log entries MUST be broadcast to WS `logs` channel subscribers in real-time.
- Log entries MUST be buffered in memory (existing 1000-entry ring buffer is sufficient).
- Log entries SHOULD be persisted to `{dataDir}/logs/` as daily JSONL files for historical access.
- Log persistence MUST NOT block module operations — writes SHOULD be batched or async.
- A REST endpoint `GET /api/system/logs` MUST return recent log entries with pagination and filtering (level, module, since, limit).

### Interface

```typescript
// Injected into modules
interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void
  info(message: string, metadata?: Record<string, unknown>): void
  warn(message: string, metadata?: Record<string, unknown>): void
  error(message: string, metadata?: Record<string, unknown>): void
}

// Factory to create module-scoped loggers
function createLogger(logsChannel: LogsChannel, moduleName: string): Logger
```

### Implementation

Create `packages/server/src/system/logger.ts`:

```typescript
export function createLogger(logsChannel: LogsChannel, moduleName: string): Logger {
  return {
    debug: (msg, meta) => logsChannel.log({ level: 'debug', module: moduleName, message: msg, metadata: meta }),
    info: (msg, meta) => logsChannel.log({ level: 'info', module: moduleName, message: msg, metadata: meta }),
    warn: (msg, meta) => logsChannel.log({ level: 'warn', module: moduleName, message: msg, metadata: meta }),
    error: (msg, meta) => logsChannel.log({ level: 'error', module: moduleName, message: msg, metadata: meta })
  }
}
```

Update `LogEntry` in `system/ws.ts` to add optional fields:

```typescript
export interface LogEntry {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  module: string
  message: string
  entityId?: string
  threadKey?: string
  metadata?: Record<string, unknown>
}
```

In `index.ts`, create loggers after `logsChannel` and pass to modules:

```typescript
const logsChannel = registerLogsChannel(wsHandler, bus)
const log = (module: string) => createLogger(logsChannel, module)

// Then inject into modules where possible, or use bus listener pattern:
bus.on('*', (event) => {
  logsChannel.log({
    level: 'debug',
    module: event.source,
    message: `${event.type}`,
    metadata: event.payload as Record<string, unknown>
  })
})
```

The bus wildcard listener provides automatic logging of ALL bus events at debug level. Module-specific loggers provide higher-level operational logging (info/warn/error).

---

## 2. Notification System Integration

Wire the existing notification module into the server and enhance with entity-scoped grouping.

### Requirements

- The `Notifications` module MUST be created in `index.ts` and its routes MUST be mounted.
- Notification routes MUST include:
  - `GET /api/notifications` — list notifications with filtering (severity, read, limit, offset)
  - `PATCH /api/notifications/read` — mark notifications as read (body: `{ ids: string[] }`)
  - `PATCH /api/notifications/dismiss` — dismiss notifications (body: `{ ids: string[] }`)
  - `GET /api/notifications/unread-count` — unread count
- The notification module MUST emit `notification.new` events on the bus when new notifications are created.
- The WS `notifications` channel MUST broadcast new notifications to all subscribers.
- Each notification MUST support optional entity binding: `entityId` (string, e.g. issue number, PR id, branch name) and `entityType` (`'issue' | 'pr' | 'branch' | 'thread' | 'system'`).
- The notification rule engine MUST be seeded with default rules for common events:
  - `issue.created` → info notification, entity = issue
  - `issue.updated` → info notification, entity = issue
  - `review.created` → info notification, entity = PR
  - `review.approved` → info notification, entity = PR
  - `review.changes_requested` → warning notification, entity = PR
  - `review.merged` → info notification, entity = PR
  - `scheduler.job.failed` → error notification
  - `git.status.changed` → debug (suppressed by default)
  - `planning.cycle.detected` → warning notification
  - `terminal.closed` → debug (suppressed by default)
- The default rules MUST be written to `{dataDir}/notifications/rules.json` on first startup if the file does not exist.
- Notification grouping MUST be available via query parameter: `GET /api/notifications?groupBy=entity` groups notifications by `entityId`, returning `{ groups: Array<{ entityId, entityType, notifications: Notification[], unreadCount }> }`.

### Interface Addition

```typescript
// Extended Notification type (backwards compatible)
interface Notification {
  // ... existing fields ...
  entityId?: string
  entityType?: 'issue' | 'pr' | 'branch' | 'thread' | 'system'
}
```

### Notification Routes

Create `packages/server/src/notifications/routes.ts`:

```typescript
export function createNotificationRoutes(notifications: Notifications): Router
```

---

## 3. Event Stream Service

A real-time event stream that captures all bus events and makes them available for the holonic event viewer and canvas event flow.

### Requirements

- An `EventStream` service MUST capture all bus events in a time-ordered ring buffer (configurable size, default 5000 entries).
- Each captured event MUST include: original bus event fields + `id` (auto-incrementing), `capturedAt` (ISO timestamp).
- The event stream MUST support filtering by: event type pattern (glob), source module, time range, entity association.
- The event stream MUST be accessible via:
  - `GET /api/system/events` — query recent events with filtering and pagination
  - `GET /api/system/events/stats` — event rate statistics: events/sec, events by type (last 1m, 5m, 1h), top sources
- A WS channel `events` MUST broadcast events in real-time to subscribers.
- The WS `events` channel MUST support scoped subscriptions: clients can subscribe with a filter (e.g. `{ scope: { module: 'git' } }` or `{ scope: { type: 'issue.*' } }`) and only receive matching events.
- Event stream persistence is NOT required — it is a real-time-only view. The ring buffer is sufficient.
- The event stream MUST NOT create backpressure on the bus — capture MUST be async (queueMicrotask or similar).

### Interface

```typescript
interface EventStreamEntry {
  id: number
  capturedAt: string
  type: string
  source: string
  timestamp: string
  payload: unknown
  entityId?: string
  threadKey?: string
}

interface EventStreamStats {
  totalCaptured: number
  rate: { last1m: number; last5m: number; last1h: number }
  byType: Record<string, number> // last 5 minutes
  bySource: Record<string, number> // last 5 minutes
}

interface EventStream {
  query(filter?: EventStreamFilter): EventStreamEntry[]
  stats(): EventStreamStats
  subscribe(filter?: EventStreamFilter, handler: (entry: EventStreamEntry) => void): () => void
}
```

---

## 4. Live System Updates via WS

Replace polling in client Architecture/Health tabs with WS push.

### Requirements

- The system module MUST emit `system.architecture.updated` events on the bus when modules register or change status.
- The system module MUST emit `system.health.updated` events on the bus periodically (every 10s) or when significant metrics change (connection count changes, error count increases).
- A WS channel `system` MUST broadcast architecture and health updates.
- The `ArchitectureTab` client MUST subscribe to the `system` WS channel and update its module list reactively instead of polling.
- The `HealthTab` client MUST subscribe to the `system` WS channel and update its health data reactively instead of polling.
- The client MUST fall back to REST polling if WS is disconnected (degrade gracefully).
- The polling interval for fallback MUST be configurable but default to 10s (architecture) and 5s (health).

### WS Messages

```typescript
// Server → Client
{ type: 'system.architecture', modules: ModuleInfo[] }
{ type: 'system.health', ...HealthData }
{ type: 'system.event', ...EventStreamEntry }  // for events channel
```

---

## 5. Client: LogsTab WS Integration

Wire the existing LogsTab component to the WS `logs` channel for real-time log streaming.

### Requirements

- The `LogsTab` MUST connect to the WS `logs` channel via the global `wsStore`.
- On subscription, the client MUST receive `log.history` (buffered entries) and display them immediately.
- New `log.entry` messages MUST be appended to the log list in real-time.
- The existing filter UI (level toggles, module dropdown, text search) MUST work on the live stream.
- Auto-scroll MUST be active by default — new entries scroll into view. If the user scrolls up, auto-scroll MUST pause. If the user scrolls to the bottom, auto-scroll MUST resume.
- The LogsTab MUST display a "Live" indicator when receiving real-time entries.
- A pause button MUST allow the user to pause the live stream (entries still accumulate but the UI freezes, with a count badge showing queued entries).
- The maximum client-side log buffer MUST be 5000 entries. Older entries are discarded.
- The `LogEntry` display MUST show: timestamp (HH:MM:SS.mmm), level badge (colored), module name, message text. If `entityId` is present, show it as a clickable link.

---

## 6. Client: Entity-Scoped Notifications

Enhance the existing notification UI with entity grouping and navigation.

### Requirements

- The `NotificationFeed` (dashboard) and `NotificationsPanel` (workspace sidebar) MUST fetch from `GET /api/notifications`.
- Notifications MUST be groupable by entity — the UI MUST show a toggle between "All" (flat list) and "By Entity" (grouped view).
- In grouped view, each entity group MUST show: entity identifier (e.g. "Issue #42", "PR #17"), entity type badge, notification count (with unread highlight), latest notification timestamp.
- Clicking an entity group MUST expand to show its notifications.
- Clicking a notification with an `entityId` MUST navigate to the associated thread (if one exists for that entity) or show an entity detail view.
- The notification feed MUST subscribe to the WS `notifications` channel for real-time new notification delivery.
- New notifications MUST appear at the top with a brief highlight animation.
- Mark-as-read MUST be available per-notification and per-entity-group.
- Dismiss MUST be available per-notification and per-entity-group.
- An unread badge count MUST appear on the Notifications sidebar tab icon.

---

## 7. Client: Event Stream Viewer

A new component for viewing the live event bus.

### Requirements

- An `EventStreamTab` MUST be added to the System view (7th tab: "Events").
- The event stream MUST subscribe to the WS `events` channel.
- Events MUST be displayed in a scrollable, reverse-chronological list (newest at top).
- Each event entry MUST show: timestamp, event type (with color coding by category — e.g. green for git, blue for issues, red for errors), source module, and a collapsible payload preview.
- The event stream MUST support filtering by:
  - Event type (text input with autocomplete from seen types)
  - Source module (dropdown populated from seen sources)
  - Level/severity (if derivable from event type — e.g. `*.failed` = error)
- A rate indicator MUST show current events/second.
- A pause/resume button MUST be available (same pattern as LogsTab).
- Maximum client buffer: 2000 events.
- The event stream viewer MUST support "spotlight" mode — clicking an event highlights related events (same entity, same event chain) in the list.

---

## 8. Canvas Event Flow Enhancement

Wire the existing Canvas view's event flow visualization with real data.

### Requirements

- The `CanvasView` MUST subscribe to the WS `events` channel.
- When an event fires, the canvas MUST show a brief animated pulse/particle flowing from the source module's workspace node to any related workspace node.
- Event flow animations MUST decay after 2 seconds.
- The canvas event sidebar/overlay (referenced in views spec) MUST show the event stream filtered to the currently selected workspace.
- If no workspace is selected, the sidebar MUST show all events.
- The implementation SHOULD be lightweight — SVG animations or CSS transitions, not a heavy canvas library.
- Event flow visualization MAY be disabled via a toggle for performance.

---

## Implementation Plan

### Wave 1: Server-Side (parallel tasks)

**Task 1.1 — Logger factory + bus event logging**

- Create `packages/server/src/system/logger.ts`
- Update `LogEntry` interface to include optional `entityId`, `threadKey`, `metadata`
- Add bus wildcard listener in `index.ts` to auto-log all events at debug level
- Add log persistence (daily JSONL files)
- Add `GET /api/system/logs` route
- Tests: logger factory, log persistence, REST endpoint

**Task 1.2 — Notification module wiring**

- Create `packages/server/src/notifications/routes.ts`
- Wire `createNotifications()` in `index.ts`
- Mount notification routes
- Seed default notification rules on first startup
- Add entity fields to `Notification` type
- Update rule engine to populate entity fields from event data
- Wire WS notification channel to emit on `notification.new`
- Tests: notification routes, entity grouping query, default rules

**Task 1.3 — Event stream service**

- Create `packages/server/src/system/event-stream.ts`
- Ring buffer with configurable capacity
- Filtering by type pattern, source, time range
- Rate statistics calculation
- Register WS `events` channel with scoped subscription support
- Add `GET /api/system/events` and `GET /api/system/events/stats` routes
- Tests: ring buffer, filtering, stats, WS channel

**Task 1.4 — Live system WS updates**

- Update `system.ts` to emit architecture/health events
- Register WS `system` channel for push updates
- Periodic health broadcast (10s interval)
- Architecture broadcast on module registration
- Tests: WS broadcasts, event emission

### Wave 2: Client-Side (parallel tasks)

**Task 2.1 — LogsTab WS wiring**

- Import global `wsStore`, subscribe to `logs` channel
- Handle `log.history` and `log.entry` messages
- Auto-scroll with pause detection
- "Live" indicator and pause button
- 5000-entry client buffer with eviction
- Tests: message handling, filtering, auto-scroll logic

**Task 2.2 — Entity-scoped notifications**

- Update `NotificationFeed` and `NotificationsPanel` to fetch from `/api/notifications`
- Add "All" / "By Entity" toggle
- Entity group rendering with expand/collapse
- WS subscription for real-time notifications
- Mark-read and dismiss per entity group
- Unread badge on sidebar tab
- Tests: grouping logic, WS updates, badge count

**Task 2.3 — Architecture/Health WS migration**

- Update `ArchitectureTab` to subscribe to `system` WS channel
- Update `HealthTab` to subscribe to `system` WS channel
- Remove polling, add REST fallback on WS disconnect
- Tests: WS handler, fallback logic

### Wave 3: Event Viewer + Canvas

**Task 3.1 — Event stream viewer**

- Create `packages/client/src/features/system/EventStreamTab.tsx`
- Add "Events" tab to SystemView
- WS subscription to `events` channel
- Filterable event list with type coloring
- Rate indicator, pause button
- Spotlight mode for related events
- Tests: component logic, filtering, buffer management

**Task 3.2 — Canvas event flow**

- Wire `CanvasView` to WS `events` channel
- SVG animation for event flow between workspace nodes
- Event sidebar overlay
- Performance toggle
- Tests: event mapping, animation triggers

### Wave 4: Integration + Polish

**Task 4.1 — End-to-end integration tests**

- Server: emit events → verify log entries appear in WS, notifications created, event stream captured
- Client: verify LogsTab shows real-time entries, notifications update, architecture/health are live
- Performance: verify no backpressure from logging on bus operations

**Task 4.2 — Module-specific logging**

- Add targeted info/warn/error log calls to key module operations (beyond the bus wildcard debug logging)
- Focus on: git operations, issue sync, review status changes, scheduler job lifecycle, config changes

---

## Testing Strategy

- **Unit tests** for: logger factory, event stream ring buffer, notification routes, entity grouping, rate statistics, client-side buffer management, filter logic
- **Integration tests** for: bus event → log entry → WS broadcast → client display, bus event → notification rule match → notification created → WS broadcast
- **Component tests** for: LogsTab message handling, EventStreamTab filtering, NotificationFeed grouping, ArchitectureTab WS updates
- All tests MUST run in the existing vitest environment (node for client, node for server)
- All tests MUST NOT require a running server

---

## Config Additions

```typescript
// Added to SovereignConfig
interface SovereignConfig {
  // ... existing ...
  observability: {
    logs: {
      bufferSize: number // default: 1000 (in-memory ring buffer)
      persistDays: number // default: 7 (daily JSONL retention)
      defaultLevel: LogLevel // default: 'info' (minimum level to capture)
    }
    events: {
      bufferSize: number // default: 5000 (in-memory ring buffer)
      broadcastThrottle: number // default: 0 (ms, 0 = no throttle)
    }
    health: {
      broadcastIntervalMs: number // default: 10000
    }
  }
}
```

---

## Success Criteria

1. All bus events visible in real-time via System > Events tab
2. Logs tab shows structured, filterable, live-streaming log entries from all modules
3. Notifications are entity-scoped — grouped by issue/PR/branch with navigation to associated threads
4. Architecture and Health tabs update in real-time without polling (WS-driven)
5. Canvas view shows event flow animations between workspace nodes
6. Zero impact on bus throughput from observability instrumentation
7. All existing 1838 tests continue to pass
8. New tests cover all observability features
