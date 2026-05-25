# Un-OpenClaw-ing — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-05-24

Refactor Sovereign so that all OpenClaw-specific logic lives only inside `agent-backend/openclaw/`, every other module talks to the agent runtime through the abstract `AgentBackend` interface, and **three backends — OpenClaw, Pi, Claude Code — can coexist in the same Sovereign instance, selected per-thread.**

This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

This spec is a **prerequisite** for both [pi-migration-spec.md](pi-migration-spec.md) and [claude-code-adapter-spec.md](claude-code-adapter-spec.md). It defines the seam; the other two specs are concrete implementations of that seam.

---

## 1. Goals

- **Single seam.** Every module outside `agent-backend/` MUST talk to the agent runtime only through `AgentBackend`. No module outside that directory reads `~/.openclaw/`, `~/.pi/`, `~/.claude/`, or any agent-runtime file directly.
- **Backend isolation.** Each backend MUST live in its own subdirectory with its own types, parsing, persistence, and tests. No cross-imports between `openclaw/`, `pi/`, and `claude-code/`.
- **Coexistence.** Sovereign MUST be able to run all three backends in the same process. Each thread MUST be bound to one backend at creation time and MUST NOT migrate. Different threads MAY use different backends.
- **OpenClaw stays working.** This refactor MUST NOT regress any currently working OpenClaw functionality. Existing OpenClaw deployments continue to work unchanged after the refactor.
- **Backend-agnostic plumbing.** Cron, subagents, registry, model enumeration, and context-budget reporting MUST be sovereign-owned and routed through the backend rather than implemented inside any specific backend.

## 2. Non-Goals

- Building new backends. This spec only defines the seam — Pi and Claude Code are landed in their own specs.
- Migrating existing OpenClaw sessions to other backends. Sessions stay on the backend they were created with.
- Removing OpenClaw. After this refactor lands, OpenClaw is still the default; removal is governed by `pi-migration-spec.md` Phase E and/or `claude-code-adapter-spec.md`.
- Changing the client. The SolidJS client and the WS protocol stay fixed.

---

## 3. Current OpenClaw Coupling Inventory

The 8 direct `sessions.json` reads, the `openclaw.json` model read, the `OPENCLAW_WORKSPACE` env, the `openclaw gateway restart` shell-out, and the gateway-poll context-budget endpoint are enumerated in [pi-migration-spec.md §6](pi-migration-spec.md#6-file-by-file-impact). This refactor MUST remove every one of them from outside `agent-backend/openclaw/`.

Additional coupling not yet enumerated:

| Location | Coupling | Action |
| --- | --- | --- |
| [chat/chat.ts:272](../packages/server/src/chat/chat.ts#L272) | `sessions_yield` tool-name special-case | Move to a generic "subagent yield" hook on the backend interface (§7). |
| [agent-backend/parse-turns.ts:53–145](../packages/server/src/agent-backend/parse-turns.ts#L53) | OpenClaw-specific noise filters (`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`, `[CronResult]`, `Sender (untrusted metadata):`, `HEARTBEAT_OK`, etc.) | Move into `agent-backend/openclaw/parse-turns.ts`. Shared `parse-turns.ts` only knows the generic structure. |
| [agent-backend/session-reader.ts:6](../packages/server/src/agent-backend/session-reader.ts#L6) | Hard-coded `~/.openclaw/agents/main/sessions` path. Also handles claude-cli format opportunistically. | Move OpenClaw path resolution into `openclaw/session-reader.ts`. Keep the claude-cli normalization helpers in `claude-code/session-reader.ts`. Shared utilities (e.g. JSONL tail-read) move to `agent-backend/shared/jsonl.ts`. |
| [agent-backend/openclaw.ts:975–1006](../packages/server/src/agent-backend/openclaw.ts#L975) | `listCronJobs`, `getCronRuns`, `updateCronJob`, `removeCronJob` on backend interface | Remove from `AgentBackend`. Move to a sovereign-owned `CronService` (§8). |
| [scheduler/cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) | Polls gateway, auto-fixes gateway-side cron jobs | Move OpenClaw-specific auto-fix to `agent-backend/openclaw/cron-bridge.ts`. The monitor talks to Sovereign's CronService only. |
| [system/routes.ts:55–69](../packages/server/src/system/routes.ts#L55) | `createGatewayRestartService` shells out to `openclaw gateway restart` | Becomes backend-specific. Add `AgentBackend.restart?()` optional method; OpenClaw implements; Pi/Claude-Code don't. Route returns 501 when backend.restart is undefined. |
| [system/routes.ts:34–51](../packages/server/src/system/routes.ts#L34) | `fetchContextBudgetFromGateway` HTTP to gateway | Replace with `backend.getContextBudget(sessionKey)` (already proposed in pi-migration-spec.md §7; promoted here to a hard requirement). |
| [system/routes.ts:106](../packages/server/src/system/routes.ts#L106) | `getDeviceInfo` reports gateway URL, device public key | Becomes `backend.getDeviceInfo?()` (optional). OpenClaw implements; others return `null` or `{ kind: 'local' }`. UI hides the panel when null. |
| [files/routes.ts:55–58](../packages/server/src/files/routes.ts#L55) | Reads `OPENCLAW_WORKSPACE` env | Renamed to `SOVEREIGN_WORKSPACE`. Independent of backend choice. |
| [threads/routes.ts:299](../packages/server/src/threads/routes.ts#L299) | Reads `~/.openclaw/openclaw.json` for models | `backend.listAvailableModels()` (per pi-migration-spec.md §7). |

---

## 4. Target Architecture

```
packages/server/src/agent-backend/
├── index.ts                       # createBackend(config) selector
├── factory.ts                     # backend registry, per-thread binding lookup
├── shared/
│   ├── jsonl.ts                   # tail-read, atomic append (used by openclaw + claude-code)
│   ├── parse-turns.ts             # generic ContentBlock → ParsedTurn (no backend-specific noise)
│   ├── thinking.ts                # generic thinking-block stripping
│   ├── work-items.ts              # WorkItem construction helpers
│   └── sessions-registry.ts       # SessionsRegistry interface + file-backed impl
├── openclaw/
│   ├── openclaw.ts                # current openclaw.ts moved here, no other changes initially
│   ├── session-reader.ts          # OpenClaw paths only
│   ├── parse-turns.ts             # OpenClaw-specific noise filters
│   ├── cron-bridge.ts             # talks to gateway cron RPC (OpenClaw-only)
│   ├── types.ts
│   └── openclaw.test.ts
├── pi/                            # populated by pi-migration-spec.md
└── claude-code/                   # populated by claude-code-adapter-spec.md

packages/server/src/scheduler/
├── cron-service.ts                # NEW — Sovereign-native cron orchestration
├── cron-monitor.ts                # MODIFIED — talks only to CronService
└── ...
```

`agent-backend/index.ts` exports:

```ts
export type { AgentBackend, AgentBackendKind, AgentBackendConfig } from './shared/types'
export { createBackend } from './factory'
export { SessionsRegistry } from './shared/sessions-registry'
```

Everything else (`openclaw/openclaw.ts`, `pi/pi.ts`, `claude-code/claude-code.ts`) is an internal implementation detail. **No file outside `agent-backend/` imports from a backend subdirectory.** Lint rule enforces this (§13).

---

## 5. The Seam — `AgentBackend` Interface

Existing methods stay (see [packages/core/src/agent-backend.ts](../packages/core/src/agent-backend.ts)). Add:

```ts
export type AgentBackendKind = 'openclaw' | 'pi' | 'claude-code'

export interface AgentBackend {
  /** Backend identity — for routing, UI, telemetry. */
  readonly kind: AgentBackendKind

  // ── existing ──
  connect(): Promise<void>
  disconnect(): Promise<void>
  status(): BackendConnectionStatus
  sendMessage(sessionKey: string, text: string, attachments?: Buffer[]): Promise<void>
  abort(sessionKey: string): Promise<void>
  switchSession(sessionKey: string): Promise<void>
  createSession(label?: string, opts?: CreateSessionOptions): Promise<string>
  getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }>
  getFullHistory(sessionKey: string): Promise<ParsedTurn[]>
  on<K extends keyof AgentBackendEvents>(event: K, handler: ...): void
  off<K extends keyof AgentBackendEvents>(event: K, handler: ...): void

  // ── new (replaces direct sessions.json reads) ──
  listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]>
  listSubagents(parentKey?: string): Promise<SubagentSummary[]>
  getSessionMeta(sessionKey: string): Promise<SessionMeta | null>
  setSessionModel(sessionKey: string, provider: string, model: string): Promise<void>
  listAvailableModels(): Promise<{ models: string[]; defaultModel: string | null }>
  getContextBudget(sessionKey: string): Promise<ContextBudget | null>

  // ── new (subagent orchestration — backend declares capability) ──
  spawnSubagent?(parentSessionKey: string, opts: SpawnSubagentOptions): Promise<string>
  /** Returns true if this backend supports subagents natively. */
  capabilities(): BackendCapabilities

  // ── new (optional, backend-specific) ──
  restart?(): Promise<{ message: string; command?: string }>  // OpenClaw only
  getDeviceInfo?(): DeviceInfo | null                          // OpenClaw only
}

export interface CreateSessionOptions {
  threadKey?: string                  // logical key Sovereign wants to use
  kind?: SessionKind
  parentSessionKey?: string           // for subagents
  cwd?: string
  model?: { provider: string; model: string }
  thinkingLevel?: string
  systemPromptOverride?: string
}

export interface BackendCapabilities {
  subagents: 'native' | 'sovereign-orchestrated' | 'unsupported'
  cron: 'backend-managed' | 'sovereign-managed'
  steering: boolean
  followUp: boolean
  compaction: 'on-demand' | 'automatic-only'
  toolStreaming: boolean
  deviceIdentity: boolean
  multiProvider: boolean
}
```

The interface is **additive** over today's `AgentBackend`. Existing call sites (`sendMessage`, `getHistory`, etc.) are unchanged. The new methods replace the 8 direct `sessions.json` reads and the 4 OpenClaw cron RPC methods.

**Capability negotiation** is the mechanism by which Sovereign routes work differently per backend. Examples:

- If `capabilities().subagents === 'native'`, Sovereign calls `spawnSubagent` and the backend handles it (OpenClaw, Claude Code).
- If `capabilities().subagents === 'sovereign-orchestrated'`, Sovereign uses the orchestrator from `pi-migration-spec.md §9` (Pi).
- If `capabilities().cron === 'sovereign-managed'`, Sovereign's CronService owns scheduling and uses `backend.sendMessage()` to deliver (Pi, Claude Code).
- If `capabilities().cron === 'backend-managed'`, Sovereign's CronService delegates to the backend's bridge (OpenClaw).

---

## 6. Sovereign-Owned Sessions Registry

Defined fully in [pi-migration-spec.md §6](pi-migration-spec.md#6-file-by-file-impact) (`ThreadSessionRecord`, `SessionsRegistry`). Promoted here to a hard requirement for **all** backends.

Additions to make it multi-backend:

```ts
export interface ThreadSessionRecord {
  // ... existing fields per pi-migration-spec ...
  backendKind: AgentBackendKind // NEW — which backend owns this session
  backendSessionId: string // NEW — backend-internal id (Pi UUID, Claude Code UUID, OpenClaw sessionId)
  backendSessionFile?: string // optional — path to the backend's JSONL, if any
}
```

**Where the registry lives:** `${SOVEREIGN_DATA_DIR}/agent-backend/sessions.json`. Atomic writes via tmp + rename. Debounced 250 ms (similar to existing Sovereign patterns).

**Backwards-compat with existing OpenClaw deployments:** on first boot after refactor, the registry is empty. The OpenClaw backend's `listSessions()` populates the registry by reading `~/.openclaw/agents/main/sessions/sessions.json` and projecting into `ThreadSessionRecord`s with `backendKind: 'openclaw'`. Subsequent reads hit the registry; the OpenClaw file becomes a one-way cache to migrate from.

---

## 7. Subagent Abstraction

Two requirements need to coexist:

- **OpenClaw** has subagents natively (`sessions_yield`, `spawnedBy` in `sessions.json`).
- **Pi** has no subagents — Sovereign orchestrates them on top (per pi-migration-spec.md §9).
- **Claude Code** has subagents natively (Task tool, `.claude/agents/` definitions).

The interface MUST cover both modes:

```ts
export interface SpawnSubagentOptions {
  task: string
  label?: string
  model?: { provider: string; model: string }
  thinkingLevel?: string
  toolAllowlist?: string[]
  timeoutMs?: number
}

// In AgentBackendEvents — NEW event:
'subagent.spawned': { parentKey: string; childKey: string; task: string; label?: string }
'subagent.completed': { parentKey: string; childKey: string; result: string; tokenUsage?: Usage }
'subagent.failed': { parentKey: string; childKey: string; error: string }
```

- **OpenClaw adapter** emits `subagent.spawned` when it observes `sessions_yield` in the gateway stream + a matching `spawnedBy` entry appearing in `sessions.json`. Translates today's behavior into the new event shape.
- **Pi adapter** registers a `spawn_subagent` tool with Pi, fires `subagent.spawned` from the tool's `execute`. (Per pi-migration-spec.md §9.)
- **Claude Code adapter** registers a hook on `SubagentStart`/`SubagentStop` and emits the events.

The chat module ([chat/chat.ts:272](../packages/server/src/chat/chat.ts#L272)) and the three subagent routes ([server/index.ts:386–514](../packages/server/src/index.ts#L386)) MUST stop reading `sessions.json` and instead consume `backend.listSubagents()` + the new events.

---

## 8. Cron Extraction

Today cron is half-OpenClaw, half-Sovereign:

- [agent-backend/openclaw.ts:975–1006](../packages/server/src/agent-backend/openclaw.ts#L975) — RPC to gateway.
- [scheduler/cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) — polls gateway, auto-fixes misconfigs.
- [scheduler/scheduler.ts, cron.ts, store.ts](../packages/server/src/scheduler/) — Sovereign's own scheduler using `croner` (only partially used).

Target: **Sovereign owns cron. Backends only deliver.**

New `CronService` (`scheduler/cron-service.ts`) owns the job table, persists to `${SOVEREIGN_DATA_DIR}/scheduler/jobs.json`, fires via Sovereign's existing croner-backed scheduler. On fire:

1. Resolve target session from job definition.
2. Call `backend.sendMessage(targetSessionKey, prompt)` — where `backend` is whichever backend owns that session.
3. Capture the next `chat.turn` event for the session as the result, persist to `${SOVEREIGN_DATA_DIR}/scheduler/runs/<jobId>/<ts>.json`.

OpenClaw-specific behavior (gateway cron, auto-fix `delivery:announce`) moves to `agent-backend/openclaw/cron-bridge.ts` and is invoked only when migrating an existing OpenClaw cron job into Sovereign's `CronService` (one-shot import). The gateway-side cron continues to exist in OpenClaw deployments but Sovereign no longer reads from it after import.

Removes 4 methods from `AgentBackend` (`listCronJobs`, `getCronRuns`, `updateCronJob`, `removeCronJob`). The cron-related routes in [scheduler/routes.ts](../packages/server/src/scheduler/routes.ts) talk to `CronService` only.

---

## 9. Per-Thread Backend Binding

Each thread MUST be bound to exactly one backend at creation. The binding is stored in `ThreadSessionRecord.backendKind` and is immutable.

**Default backend** is configured via env var:

```
SOVEREIGN_DEFAULT_BACKEND=openclaw|pi|claude-code
```

(default: `openclaw` until pi-migration or claude-code-adapter is ready to flip)

**Per-thread override** at creation:

```http
POST /api/threads
{ "label": "Coding work", "backend": "claude-code" }
```

The thread routes ([threads/routes.ts](../packages/server/src/threads/routes.ts)) MUST pass `backend` through to `createSession`. Existing routes default to the configured backend.

**Routing requests** to the right backend:

```ts
// packages/server/src/agent-backend/factory.ts
export function createBackend(config: MultiBackendConfig): RoutingBackend

interface RoutingBackend {
  // Returns the backend that owns this session
  forSession(sessionKey: string): AgentBackend
  // All registered backends
  all(): AgentBackend[]
  // Default backend for new sessions
  default(): AgentBackend
  // Pass-through for events — multiplexes all backend event streams
  on(...): void
  off(...): void
}
```

The chat module ([chat/chat.ts](../packages/server/src/chat/chat.ts)) takes `RoutingBackend` instead of a single `AgentBackend`. Every existing `backend.sendMessage(sessionKey, ...)` becomes `backend.forSession(sessionKey).sendMessage(sessionKey, ...)`. Same shape, just one indirection.

`RoutingBackend.on('chat.stream', handler)` fires the handler for any backend's stream — the chat module doesn't need to know there are multiple backends.

---

## 10. Configuration

### Environment Variables

```bash
# Default backend for new threads
SOVEREIGN_DEFAULT_BACKEND=openclaw

# Enable / disable backends (comma-separated)
SOVEREIGN_ENABLED_BACKENDS=openclaw,pi,claude-code

# Backend-specific config (only required if backend is enabled)
OPENCLAW_GATEWAY_URL=ws://localhost:3456/ws
OPENCLAW_GATEWAY_TOKEN=

PI_AGENT_DIR=~/.pi/agent
PI_CWD=~/workspaces

CLAUDE_CODE_AGENT_DIR=~/.claude
CLAUDE_CODE_CWD=~/workspaces

# Shared
SOVEREIGN_WORKSPACE=~/workspaces  # replaces OPENCLAW_WORKSPACE
```

Only backends listed in `SOVEREIGN_ENABLED_BACKENDS` are instantiated. Unlisted backends are not loaded (no module import cost, no startup latency).

### Runtime Config

`SOVEREIGN_DEFAULT_BACKEND` is hot-reloadable through the existing config bus. Switching the default only affects future sessions; existing sessions stay on their backend.

---

## 11. AgentBackendEvents Multiplexing

`AgentBackendEvents` (in `packages/core/src/agent-backend.ts`) gains a `backendKind` field on every event:

```ts
'chat.stream': { backendKind: AgentBackendKind; sessionKey: string; text: string }
'chat.turn':   { backendKind: AgentBackendKind; sessionKey: string; turn: ParsedTurn }
// ... etc
```

This is additive — existing consumers ignoring the field continue to work. New consumers (the system view) can render per-backend status.

The `backend.status()` and `backend.status` event become per-backend:

```ts
'backend.status': { backendKind: AgentBackendKind; status: BackendConnectionStatus; reason?: string }
```

The system view shows N status pills, one per enabled backend.

---

## 12. File-by-File Refactor

| File | Change |
| --- | --- |
| [packages/core/src/agent-backend.ts](../packages/core/src/agent-backend.ts) | Add `kind`, `listSessions`, `listSubagents`, `getSessionMeta`, `setSessionModel`, `listAvailableModels`, `getContextBudget`, `spawnSubagent?`, `capabilities()`, `restart?()`, `getDeviceInfo?()`. Add `backendKind` to all event payloads. Add `BackendCapabilities`, `SpawnSubagentOptions`, `ContextBudget`, `SubagentSummary`, `SessionMeta` types. |
| [packages/server/src/agent-backend/openclaw.ts](../packages/server/src/agent-backend/openclaw.ts) | Move to `agent-backend/openclaw/openclaw.ts`. Add `kind: 'openclaw'`, implement new methods using existing gateway RPC. `capabilities()` returns `{ subagents: 'native', cron: 'backend-managed', deviceIdentity: true, multiProvider: false, ... }`. |
| [packages/server/src/agent-backend/parse-turns.ts](../packages/server/src/agent-backend/parse-turns.ts) | Split: generic parsing → `agent-backend/shared/parse-turns.ts`; OpenClaw noise filters → `agent-backend/openclaw/parse-turns.ts`. OpenClaw adapter calls the generic parser then applies its filters. |
| [packages/server/src/agent-backend/session-reader.ts](../packages/server/src/agent-backend/session-reader.ts) | Split: `tail-read JSONL` → `agent-backend/shared/jsonl.ts`; OpenClaw path resolution → `agent-backend/openclaw/session-reader.ts`; claude-cli path resolution → `agent-backend/claude-code/session-reader.ts` (per claude-code-adapter-spec). |
| [packages/server/src/agent-backend/thinking.ts](../packages/server/src/agent-backend/thinking.ts) | Move to `agent-backend/shared/thinking.ts`. No changes. |
| [packages/server/src/agent-backend/types.ts](../packages/server/src/agent-backend/types.ts) | Move to `agent-backend/openclaw/types.ts` (it's OpenClaw-specific). |
| [packages/server/src/index.ts:74](../packages/server/src/index.ts#L74) | Import `createBackend` from `agent-backend/factory.ts`. Build `RoutingBackend` from `SOVEREIGN_ENABLED_BACKENDS`. |
| [packages/server/src/index.ts:360](../packages/server/src/index.ts#L360) | `const backend = createBackend({ enabled: [...], default: ..., openclaw: {...}, pi: {...}, claudeCode: {...} })`. |
| [packages/server/src/index.ts:386–514](../packages/server/src/index.ts#L386) | Three subagent routes — replace `sessions.json` reads with `backend.forSession(...).listSubagents(...)`. |
| [packages/server/src/index.ts:520–560](../packages/server/src/index.ts#L520) | `/api/threads/gateway-sessions` — replace with `backend.all().flatMap(b => b.listSessions())`. Rename route to `/api/threads/runtime-sessions` (backwards-compat alias for one release). |
| [packages/server/src/threads/routes.ts:220–263](../packages/server/src/threads/routes.ts#L220) | `/api/threads/:key/agent-status` — use `backend.forSession(key).getSessionMeta(key)`. |
| [packages/server/src/threads/routes.ts:286–318](../packages/server/src/threads/routes.ts#L286) | `/api/models` — `backend.default().listAvailableModels()`. Optional: aggregate from all backends when `?backend=all`. |
| [packages/server/src/threads/routes.ts:320–382](../packages/server/src/threads/routes.ts#L320) | Model switch routes — `backend.forSession(key).setSessionModel(key, provider, model)`. |
| [packages/server/src/threads/parse-gateway-sessions.ts](../packages/server/src/threads/parse-gateway-sessions.ts) | Move to `agent-backend/openclaw/parse-gateway-sessions.ts`. Used only by the OpenClaw adapter. |
| [packages/server/src/chat/chat.ts:272](../packages/server/src/chat/chat.ts#L272) | Replace `sessions_yield` hack with `backend.on('subagent.spawned', ...)`. |
| [packages/server/src/chat/chat.ts:139](../packages/server/src/chat/chat.ts#L139) | `backend.on(...)` becomes `routingBackend.on(...)` — multiplexes across backends. |
| [packages/server/src/chat/chat.ts:362–370](../packages/server/src/chat/chat.ts#L362) | `backend.status` event — gains `backendKind`. |
| [packages/server/src/chat/derive-session-key.ts](../packages/server/src/chat/derive-session-key.ts) | Take a `backendKind` parameter. OpenClaw → `agent:main:thread:<x>`. Pi → `agent:main:thread:<x>` (canonical, registry-mapped). Claude Code → `agent:main:thread:<x>` (canonical, registry-mapped). The logical key is backend-agnostic; the registry maps to backend-internal ids. |
| [packages/server/src/system/routes.ts:34–91](../packages/server/src/system/routes.ts#L34) | `fetchContextBudgetFromGateway` → `backend.forSession(key).getContextBudget(key)`. Drop the HTTP mock fallback. |
| [packages/server/src/system/routes.ts:55–69](../packages/server/src/system/routes.ts#L55) | `createGatewayRestartService` — moves into `agent-backend/openclaw/restart-service.ts`. Hooked up only if `backend.restart` is defined. |
| [packages/server/src/system/routes.ts:106](../packages/server/src/system/routes.ts#L106), [165–184](../packages/server/src/system/routes.ts#L165) | `getDeviceInfo` route — calls `backend.getDeviceInfo?()` for each enabled backend; returns array. |
| [packages/server/src/files/routes.ts:55–58](../packages/server/src/files/routes.ts#L55) | Rename `OPENCLAW_WORKSPACE` → `SOVEREIGN_WORKSPACE`. |
| [packages/server/src/scheduler/cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) | Rewrite — talks to new `CronService`, not the backend. OpenClaw-specific auto-fix moves to `agent-backend/openclaw/cron-bridge.ts`. |
| [packages/server/src/scheduler/cron-service.ts](../packages/server/src/scheduler/cron-service.ts) | NEW — Sovereign-native cron orchestration. Uses existing `cron.ts`/`scheduler.ts`/`store.ts`. |
| `.env.example`, [README.md](../README.md) | Add `SOVEREIGN_DEFAULT_BACKEND`, `SOVEREIGN_ENABLED_BACKENDS`, `SOVEREIGN_WORKSPACE`. Keep `OPENCLAW_*` (now backend-specific). |

---

## 13. Lint Rule

Add to `.oxfmtrc.json` or as a new check:

> Files outside `packages/server/src/agent-backend/<backend>/` MUST NOT import from `packages/server/src/agent-backend/<backend>/`. Files outside `agent-backend/` MUST NOT import paths matching `~/.openclaw`, `~/.pi/`, or `~/.claude/`.

Enforced via `pnpm check` and CI. Initial run shows the existing violations; the refactor's done-criterion is "lint passes."

---

## 14. Tests

| File | Change |
| --- | --- |
| [agent-backend/openclaw.test.ts](../packages/server/src/agent-backend/openclaw.test.ts) | Move to `agent-backend/openclaw/openclaw.test.ts`. |
| [agent-backend/parse-turns.test.ts](../packages/server/src/agent-backend/parse-turns.test.ts) | Split: generic tests stay; OpenClaw-noise tests move to `agent-backend/openclaw/parse-turns.test.ts`. |
| `agent-backend/factory.test.ts` (NEW) | `RoutingBackend` routes by session; events multiplex; capability negotiation; per-thread binding. |
| `agent-backend/shared/sessions-registry.test.ts` (NEW) | Atomic writes, debounce, restart-survives. |
| `agent-backend/shared/parse-turns.test.ts` (NEW) | Generic parsing — no backend-specific assertions. |
| [scheduler/cron-service.test.ts] (NEW) | Sovereign-native cron orchestration. |
| [threads/routes.test.ts](../packages/server/src/threads/routes.test.ts) | Update fixtures to use the new registry/interface instead of fake `sessions.json` files. |
| [server-wiring.test.ts](../packages/server/src/server-wiring.test.ts) | Update wire-up for `RoutingBackend`. |

CI MUST run the full suite with each `SOVEREIGN_DEFAULT_BACKEND` value (`openclaw`, `pi`, `claude-code`) once each adapter is landed.

---

## 15. Phasing

### Phase 0 — Refactor without behavior change (3–4 days)

- Move existing `openclaw.ts`, `parse-turns.ts` OpenClaw-noise filters, `session-reader.ts` OpenClaw paths, and `parse-gateway-sessions.ts` into `agent-backend/openclaw/`.
- Extract shared utilities into `agent-backend/shared/`.
- Build `RoutingBackend` factory; only OpenClaw is enabled. Sovereign behaves identically to today.
- Add new `AgentBackend` methods on OpenClaw adapter; refactor all 8 `sessions.json` callsites to use them.
- Add `SessionsRegistry`; populate from `~/.openclaw/agents/main/sessions/sessions.json` on first boot.
- Add `CronService`; OpenClaw cron RPC moves to `cron-bridge.ts`, called by service.
- Lint rule added; all violations fixed.

**Acceptance:** all existing tests pass; sovereign behaves indistinguishably with `SOVEREIGN_DEFAULT_BACKEND=openclaw`; lint passes; `git grep '\.openclaw'` shows zero hits outside `agent-backend/openclaw/`.

### Phase 1 — Land Pi backend (per pi-migration-spec.md Phase A)

Drops into `agent-backend/pi/`. No further refactor needed.

### Phase 2 — Land Claude Code backend (per claude-code-adapter-spec.md)

Drops into `agent-backend/claude-code/`. No further refactor needed.

### Phase 3 — Multi-backend operation

- `SOVEREIGN_ENABLED_BACKENDS=openclaw,pi,claude-code`.
- UI: thread creation modal gains a "Backend" dropdown.
- System view: shows per-backend status pills.

### Phase 4 — Optional deprecations

Per pi-migration-spec.md and claude-code-adapter-spec.md, OpenClaw may be removed later. Until then it remains the default and a first-class option.

---

## 16. Acceptance Criteria for Phase 0

- [ ] `git grep -E '\.openclaw|OPENCLAW_' packages/server/src/ packages/core/src/ packages/client/src/` returns hits only inside `packages/server/src/agent-backend/openclaw/`.
- [ ] `git grep -E 'sessions_yield|spawnedBy|<<<BEGIN_OPENCLAW' packages/server/src/` returns hits only inside `packages/server/src/agent-backend/openclaw/`.
- [ ] The 8 sites that previously read `sessions.json` now call `backend.listSessions / listSubagents / getSessionMeta`.
- [ ] `bin/sovereign build` succeeds with no warnings.
- [ ] Full Vitest suite passes.
- [ ] Manual smoke test: open a thread, send a message, get a streamed response, switch model, abort, switch thread, view history — all unchanged from pre-refactor.
- [ ] Subagent spawn (via existing OpenClaw `sessions_yield` flow) still shows in the drawer.
- [ ] Cron job still fires and delivers into its thread.
- [ ] Gateway-restart button still works.
- [ ] `/api/system/devices` still returns OpenClaw device info.

---

## 17. Notes on Coexistence

Running OpenClaw + Pi + Claude Code in one Sovereign instance is the explicit design target, not a side-effect. Use cases:

- **Migration safety net.** Existing OpenClaw threads keep working while new threads use Pi or Claude Code. No big-bang.
- **Capability routing.** Coding-heavy threads → Claude Code (CLAUDE.md, subagents, skills). Voice/companion threads → Pi (tight latency, custom message types). Legacy cron jobs → OpenClaw until ported.
- **A/B comparison.** Same prompt on two backends in parallel via the thread-fork primitive. Useful for evaluating model quality and tool ergonomics.
- **Cost arbitrage.** Cheap fast model via Pi for triage; escalate to Claude Code (Anthropic premium) for hard cases. Sovereign can implement automatic routing later.

The seam designed here makes all of these work without any further architectural change.
