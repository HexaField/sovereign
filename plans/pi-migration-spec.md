# Pi Migration — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-05-23

Replace Sovereign's binding to the OpenClaw gateway with a direct embedding of [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) + [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) — the agent runtime that powers OpenClaw. This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

**Depends on:** [un-openclawing-spec.md](un-openclawing-spec.md) Phase 0 — the multi-backend seam. Pi is one of three concurrent backends (alongside OpenClaw and [claude-code-adapter-spec.md](claude-code-adapter-spec.md)) selectable per-thread. This spec assumes the `AgentBackend` interface additions, `SessionsRegistry`, `CronService`, and capability negotiation are already in place.

---

## 1. Goals and Non-Goals

### Goals

- **Single-process operation.** No external gateway daemon, no WebSocket handshake, no device pairing. The agent runtime runs inside the Sovereign server process.
- **Identical client UX.** The SolidJS client MUST NOT change. All chat/threads/voice events still flow through Sovereign's WS protocol; only the server-side backend changes.
- **Behavioural parity.** Chat send/abort, history (live + paginated), session switching, model selection, streaming text, tool calls, tool results, thinking blocks, compaction events, and turn boundaries MUST behave indistinguishably from today's OpenClaw binding.
- **Same `AgentBackend` interface.** [packages/core/src/agent-backend.ts](../packages/core/src/agent-backend.ts) is the contract. No additions to the interface; missing OpenClaw features are either dropped, moved to Sovereign-native modules, or implemented as in-process equivalents.
- **Move source-of-truth in-house.** Sovereign owns its session registry; no module outside `agent-backend/` reads agent-runtime files directly.

### Non-Goals

- Re-implementing OpenClaw's multi-tenant gateway, device pairing, or remote operator model.
- Designing a new client-side protocol.
- Migrating existing OpenClaw session history into Pi sessions. Historic JSONL is read-only via an opt-in importer (see §10).

---

## 2. Design Philosophy

- **Pi is a library, not a service.** Treat it like `express` or `ws`: instantiate in `index.ts`, hold references, dispose on shutdown.
- **One `AgentSession` per Sovereign thread.** The mapping `logicalSessionKey → AgentSession` is owned by the new backend. Pi's UUID session ids stay private.
- **Sovereign owns the registry.** `~/.openclaw/agents/main/sessions/sessions.json` (read by 8 callsites) is replaced by a Sovereign-managed registry file inside `SOVEREIGN_DATA_DIR`. All file-driven (PRINCIPLES.md §1) — human-readable, diffable, recoverable.
- **Features OpenClaw provided that Pi does not (subagents, cron, gateway restart) move into Sovereign or are dropped.** Pi explicitly does not ship sub-agents or scheduling — this is documented in its README. Sovereign already has a scheduler module; subagents are the only net-new feature work.
- **Strangler-fig migration.** Add `PiBackend` alongside `OpenClawBackend`, gate on `SOVEREIGN_AGENT_BACKEND=pi|openclaw` (default `pi` once parity is reached), then delete OpenClaw.

---

## 3. Pi Surface Recap

For implementers unfamiliar with Pi. Verified against the agent-core and coding-agent READMEs and `docs/sdk.md`, `docs/rpc.md`, `docs/session-format.md` in `earendil-works/pi`.

| Pi Surface | Sovereign Equivalent |
| --- | --- |
| `createAgentSession({ sessionManager, authStorage, modelRegistry, cwd, agentDir, model, thinkingLevel, tools })` | Constructs one session. Backend holds a `Map<sessionKey, AgentSession>`. |
| `AgentSessionRuntime` (`newSession / switchSession / fork / importFromJsonl`) | Used for session lifecycle. Backend wraps it. |
| `session.prompt(text, { images, streamingBehavior })` | `AgentBackend.sendMessage` |
| `session.steer(text)` / `session.followUp(text)` | Optional new features (not in current interface). |
| `session.abort()` | `AgentBackend.abort` |
| `session.agent.state.messages: AgentMessage[]` | History source; replaces JSONL reads. |
| `session.subscribe((event) => …)` | Event translator. |
| Session JSONL at `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` | Pi's persistence. Sovereign treats it as opaque. |
| `AuthStorage`, `ModelRegistry` at `~/.pi/agent/auth.json`, `~/.pi/agent/models.json` | Replaces `~/.openclaw/openclaw.json` model enumeration. |
| RPC mode (`pi --mode rpc`) | **Not used.** We embed the SDK directly. RPC is for non-Node hosts. |

Pi event types (from `docs/sdk.md`):

```
agent_start | agent_end | turn_start | turn_end
message_start | message_update | message_end
tool_execution_start | tool_execution_update | tool_execution_end
queue_update | compaction_start | compaction_end | auto_retry_start | auto_retry_end
```

`message_update` carries `assistantMessageEvent` with `text_delta | thinking_delta | ...`. `turn_end` carries the final assistant message and tool results.

---

## 4. Event Translation Matrix

The new backend MUST translate Pi events to the existing `AgentBackendEvents` (defined in [packages/core/src/agent-backend.ts](../packages/core/src/agent-backend.ts#L45)) so that [chat/chat.ts](../packages/server/src/chat/chat.ts) and all downstream consumers see the same shapes they do today.

| Pi event | Emitted Sovereign event | Notes |
| --- | --- | --- |
| `agent_start` | `chat.status { status: 'working' }` | Sovereign currently derives this from the gateway's `agent.lifecycle.start`. |
| `agent_end` | `chat.status { status: 'idle' }` | Final barrier per Pi docs — awaited subscribers settle before `prompt()` resolves. |
| `turn_start` | _(none)_ | Internal to Pi. |
| `turn_end` | `chat.turn { sessionKey, turn: ParsedTurn }` | Build `ParsedTurn` directly from `event.message` + `event.toolResults`. **No JSONL re-read required** — Pi gives us the structured turn in-memory. This is a simplification over today's path. |
| `message_update` (`text_delta`) | `chat.stream { sessionKey, text: delta }` | Pi already emits true deltas; no need for the cumulative-length bookkeeping currently in [openclaw.ts:240](../packages/server/src/agent-backend/openclaw.ts#L240) (`lastStreamLengths`). |
| `message_update` (`thinking_delta`) | `chat.work { type: 'thinking', output: accumulated }` | Accumulate per session; flush at next `tool_execution_start` or `turn_end`. Matches current OpenClaw behaviour. |
| `tool_execution_start` | `chat.work { type: 'tool_call', name, input, toolCallId }` | Flush pending thinking first. |
| `tool_execution_update` | _(swallow or expose as new event)_ | Pi streams tool progress; current Sovereign UI has no surface for it. **MAY** add later. |
| `tool_execution_end` | `chat.work { type: 'tool_result', name, output, toolCallId }` | `output` rendered via existing `contentToOutputStr` (string \| ContentBlock[] including base64 images as `<img>`). |
| `compaction_start` / `compaction_end` | `chat.compacting { active: true/false }` | 1:1 mapping. |
| `auto_retry_start` / `auto_retry_end` | _(log only)_ | Optional `chat.error { retryAfterMs }` on retry start if `event` carries a delay. |
| _(stream/connection error)_ | `chat.error { sessionKey, error }` | Catch thrown errors out of `prompt()`. |
| `AuthStorage` / boot success | `backend.status { status: 'connected' }` | Emitted once at startup (no network handshake). |
| `dispose()` / shutdown | `backend.status { status: 'disconnected' }` | Local. |

**Consequence:** the entire `lastStreamLengths`, `seenToolCallIds`, `seenToolResultIds`, and the "re-read JSONL at turn end to capture tool calls missed by stream events" logic in [openclaw.ts:240–428](../packages/server/src/agent-backend/openclaw.ts#L240) can be deleted. Pi's event stream is authoritative and complete.

---

## 5. New Module Layout

```
packages/server/src/agent-backend/
├── index.ts                 # backend factory selector (NEW)
├── pi.ts                    # createPiBackend (NEW)
├── pi-events.ts             # event translator: Pi → AgentBackendEvents (NEW)
├── pi-registry.ts           # Sovereign-owned session registry (NEW)
├── pi-history.ts            # turn extraction from Pi state + JSONL (NEW)
├── openclaw.ts              # KEEP for one release, behind feature flag
├── openclaw.test.ts         # KEEP until openclaw.ts is deleted
├── session-reader.ts        # MODIFIED: paths abstracted via registry
├── parse-turns.ts           # MODIFIED: drop OpenClaw-specific noise filters
├── thinking.ts              # KEEP unchanged (string heuristics still useful)
└── types.ts                 # MODIFIED: add PiBackendConfig

packages/server/src/registry/  # NEW (or inside agent-backend/)
└── sessions-registry.ts     # logical-key ↔ pi-session-id + per-thread metadata
```

`createPiBackend` MUST return the existing `AgentBackend` interface (no additions) plus the same extras the OpenClaw backend exposes today (`getDeviceInfo`, `listGatewaySessions`, `listCronJobs`, `getCronRuns`, `updateCronJob`, `removeCronJob`) — see §8 for how those become local operations or no-ops.

---

## 6. File-by-File Impact

### Authoritative driver swap

| File | Change | Notes |
| --- | --- | --- |
| [packages/server/src/index.ts:74](../packages/server/src/index.ts#L74) | Replace `import { createOpenClawBackend }` with backend selector. | `const backend = createBackend({ kind: process.env.SOVEREIGN_AGENT_BACKEND ?? 'pi', ... })`. |
| [packages/server/src/index.ts:360](../packages/server/src/index.ts#L360) | Construct `PiBackend` config. | New env: `PI_AGENT_DIR` (default `~/.pi/agent`), `PI_DEFAULT_MODEL` (e.g. `anthropic/claude-sonnet-4-6`), `PI_DEFAULT_THINKING` (off/minimal/.../xhigh), `PI_CWD` (workspace root). Drop `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`. |
| [packages/server/src/agent-backend/openclaw.ts](../packages/server/src/agent-backend/openclaw.ts) | **No edits required** during cutover. Delete after one release with `SOVEREIGN_AGENT_BACKEND=pi` as default. | The whole device-identity / handshake / RPC layer (lines 1–800) goes away with it. |

### Registry replacement (the biggest mechanical change)

These 8 sites read `~/.openclaw/agents/main/sessions/sessions.json` directly. They MUST be routed through a new `SessionsRegistry` interface so that the backend can serve the same shape under Pi:

| Site | Current read | Replacement |
| --- | --- | --- |
| [server/index.ts:388](../packages/server/src/index.ts#L388) | `/api/threads/active-subagents` enumerates `:subagent:` keys with `spawnedBy`. | `backend.listSubagents(parentKey?)` (new method on backend interface, or via registry directly). |
| [server/index.ts:454](../packages/server/src/index.ts#L454) | `/api/threads/:key/subagents` same. | Same. |
| [server/index.ts:522](../packages/server/src/index.ts#L522) | `/api/threads/gateway-sessions` parses all sessions for the drawer. | `registry.listSessions()` returns the merged structure. |
| [threads/routes.ts:227](../packages/server/src/threads/routes.ts#L227) | `/api/threads/:key/agent-status` reads `model`, `contextTokens`, etc. | Compute from `AgentSession` in-memory (`session.agent.state`, plus `Usage` accumulation). Registry caches last-known values per logical key. |
| [threads/routes.ts:332](../packages/server/src/threads/routes.ts#L332) | `PATCH /api/threads/:key/model` writes `modelProvider` + `model`. | `registry.setSessionModel(logicalKey, { provider, model })` → also calls `session.setModel(modelRegistry.find(provider, model))`. |
| [threads/routes.ts:363](../packages/server/src/threads/routes.ts#L363) | `POST /api/threads/switch-model` same. | Same. |
| [threads/parse-gateway-sessions.ts:77](../packages/server/src/threads/parse-gateway-sessions.ts#L77) | `getGatewayActivityMap()` cached 60MB JSON parse. | Registry is in-process; activity map is O(1) lookup. The whole 60MB-file-parsing performance hack disappears. |
| [agent-backend/session-reader.ts:6](../packages/server/src/agent-backend/session-reader.ts#L6) | Walks `~/.openclaw/agents/main/sessions/`. | Walks `~/.pi/agent/sessions/--<cwd>--/`. Pi's directory naming is deterministic per `cwd`. |

**Registry shape (new):**

```ts
// packages/server/src/agent-backend/pi-registry.ts
export interface ThreadSessionRecord {
  logicalKey: string // e.g. 'agent:main:thread:upgrades'
  piSessionId: string // Pi's internal UUID
  piSessionFile: string // absolute path to Pi's JSONL
  label?: string
  kind: 'main' | 'thread' | 'subagent' | 'cron' | 'event-agent'
  parentLogicalKey?: string // for subagents
  spawnedBy?: string // human-readable origin
  task?: string // subagent task description
  model?: string
  modelProvider?: string
  thinkingLevel?: string
  contextTokens?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  compactionCount?: number
  status: 'idle' | 'working' | 'thinking' | 'done' | 'error'
  agentStatus?: string
  createdAt: number
  updatedAt: number
  lastActivity: number
}

export interface SessionsRegistry {
  get(logicalKey: string): ThreadSessionRecord | undefined
  list(filter?: { kind?: string; parentLogicalKey?: string }): ThreadSessionRecord[]
  upsert(record: Partial<ThreadSessionRecord> & { logicalKey: string }): ThreadSessionRecord
  remove(logicalKey: string): void
  // Triggered by backend on every relevant Pi event
  recordTurn(logicalKey: string, usage: Usage, model: string, provider: string): void
}
```

Persistence: a single JSON file at `${SOVEREIGN_DATA_DIR}/agent-backend/sessions.json`, debounced atomic writes (tmp + rename), same pattern Sovereign already uses elsewhere.

### Module-by-module touch list

| File | Change |
| --- | --- |
| [files/routes.ts:56](../packages/server/src/files/routes.ts#L56) | Rename `OPENCLAW_WORKSPACE` → `SOVEREIGN_WORKSPACE`. Default to first registered org's project root, or `PI_CWD`. |
| [system/routes.ts:35](../packages/server/src/system/routes.ts#L35) | `fetchContextBudgetFromGateway` — delete. Replace with `backend.getContextBudget(sessionKey)` computed from `session.agent.state.messages` Usage fields. |
| [system/routes.ts:55](../packages/server/src/system/routes.ts#L55) | `createGatewayRestartService` — delete. `POST /api/system/gateway/restart` returns 410 Gone (or 404). UI removes the button (see §11). |
| [system/routes.ts:165](../packages/server/src/system/routes.ts#L165) | `/api/system/devices` — the device-identity concept goes away. Either remove the endpoint or make it report only the current Sovereign instance (no public key, no gateway URL). |
| [chat/chat.ts:272](../packages/server/src/chat/chat.ts#L272) | `sessions_yield` tool-call special-case — Pi has no equivalent. Remove (subagents handled differently per §9). |
| [chat/derive-session-key.ts:8](../packages/server/src/chat/derive-session-key.ts#L8) | Comment "OpenClaw uses lowercase thread keys" — update. Logical key format stays for backward compat with stored thread state. |
| [agent-backend/parse-turns.ts:60–106](../packages/server/src/agent-backend/parse-turns.ts#L60) | Drop OpenClaw-specific noise: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`, `Heartbeat prompt:`, `HEARTBEAT_OK`, `Sender (untrusted metadata):`, `OpenClaw runtime context (internal):`, `[CronResult]`, `Supervisor`, `Agent-to-agent announce step`. None of these are emitted by Pi. Keep the structure of `parseTurns` — it's still used by §10 importer and by the in-memory turn builder. |
| [scheduler/cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) | Replace `backend.listCronJobs / getCronRuns / updateCronJob / removeCronJob` calls with Sovereign's own scheduler ([scheduler/scheduler.ts](../packages/server/src/scheduler/scheduler.ts)). The "auto-fix misconfigured crons" logic (delivery:announce → none) is OpenClaw-specific and can be deleted. |
| [agent-backend/openclaw.ts:975–1006](../packages/server/src/agent-backend/openclaw.ts#L975) | `listCronJobs / updateCronJob / removeCronJob / getCronRuns` — implement as no-ops or thin pass-throughs to the local scheduler in the Pi backend, then delete the methods from the interface in the cleanup phase. |
| `.env.example`, `README.md` | Replace `OPENCLAW_GATEWAY_*` with `PI_*` env vars and update Quick Start. |

### Tests

| File | Change |
| --- | --- |
| [agent-backend/openclaw.test.ts](../packages/server/src/agent-backend/openclaw.test.ts) | Keep until OpenClaw is deleted. |
| `agent-backend/pi.test.ts` (NEW) | Mirror openclaw.test.ts: connect, sendMessage, abort, switchSession, createSession, getHistory, error paths. Drive with a fake `AgentSession` that exposes `subscribe` and `prompt`. |
| `agent-backend/pi-events.test.ts` (NEW) | Pure translator tests — given a sequence of Pi events, assert the emitted `AgentBackendEvents`. |
| `agent-backend/pi-registry.test.ts` (NEW) | upsert/list/persistence/atomic write. |
| [agent-backend/parse-turns.test.ts](../packages/server/src/agent-backend/parse-turns.test.ts) | Delete tests that assert OpenClaw-specific stripping. Add Pi-format fixtures (v3 JSONL with `id`/`parentId`). |
| [threads/routes.test.ts](../packages/server/src/threads/routes.test.ts) | Replace fixture paths (`dataDir/.openclaw/...`) with the new registry shape. The tests already construct fake sessions.json — just point them at the new registry interface. |
| [server-wiring.test.ts](../packages/server/src/server-wiring.test.ts) | Update wire-up assertions for the new factory selector. |
| [**integration**/phase6.test.ts](../packages/server/src/__integration__/phase6.test.ts) | Update — drive Pi backend in-process; no WS handshake to mock. |

---

## 7. New AgentBackend Methods (or registry-on-the-side)

Two routes that currently read sessions.json directly need a backend surface. Adding to `AgentBackend` is preferred because it keeps the seam clean for any future runtime swap:

```ts
// packages/core/src/agent-backend.ts — ADDITIONS (proposal)
interface AgentBackend {
  // ...existing...

  /** List all sessions known to the backend, optionally filtered. */
  listSessions(filter?: { kind?: string; parentKey?: string }): Promise<SessionSummary[]>

  /** List subagent sessions, optionally for a specific parent. */
  listSubagents(parentKey?: string): Promise<SubagentSummary[]>

  /** Per-session metadata for the agent-status panel. */
  getSessionMeta(sessionKey: string): Promise<SessionMeta | null>

  /** Update model on a live session. */
  setSessionModel(sessionKey: string, provider: string, model: string): Promise<void>

  /** List models available to this backend. */
  listAvailableModels(): Promise<{ models: string[]; defaultModel: string | null }>
}
```

This deletes ~150 lines of duplicated JSON-parsing across [server/index.ts](../packages/server/src/index.ts), [threads/routes.ts](../packages/server/src/threads/routes.ts), and [threads/parse-gateway-sessions.ts](../packages/server/src/threads/parse-gateway-sessions.ts). OpenClaw backend implements these by reading sessions.json (current behaviour, moved behind the seam). Pi backend implements these from the in-process registry.

**Alternative:** keep `AgentBackend` minimal and pass `SessionsRegistry` separately to the routes. Marginally less coupling, but every caller already has `backend` in scope. Lead with adding to `AgentBackend`.

---

## 8. Feature-for-feature Mapping of OpenClaw-only Surfaces

| Feature | Today via OpenClaw | Replacement |
| --- | --- | --- |
| Device pairing (ed25519, `connect.challenge`, deviceToken persistence) | [openclaw.ts:34–743](../packages/server/src/agent-backend/openclaw.ts#L34) | **Dropped.** No remote. `getDeviceInfo()` returns `{ deviceId: 'local', connectionStatus: 'connected', gatewayUrl: 'in-process', ... }` or the endpoint is removed. |
| Reconnect with exponential backoff | [openclaw.ts:745–762](../packages/server/src/agent-backend/openclaw.ts#L745) | **Dropped.** |
| Gateway restart (`openclaw gateway restart`) | [system/routes.ts:55](../packages/server/src/system/routes.ts#L55) | **Dropped.** UI button removed. |
| Context-budget JSON over HTTP | [system/routes.ts:34](../packages/server/src/system/routes.ts#L34) | Compute locally from `session.agent.state.messages` + `Usage` fields per turn. New `backend.getContextBudget(sessionKey)`. |
| Cron (`cron.list / runs / update / remove`) | [openclaw.ts:975](../packages/server/src/agent-backend/openclaw.ts#L975), [cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) | **Sovereign-native.** [scheduler/scheduler.ts](../packages/server/src/scheduler/scheduler.ts) already exists (uses `croner`). Cron jobs invoke `backend.sendMessage(sessionKey, prompt)` to deliver into a thread. Auto-fix logic for `delivery:announce` deleted. |
| Subagents (`sessions_yield`, `spawnedBy`, cross-session continuation) | Throughout [chat/chat.ts](../packages/server/src/chat/chat.ts), [server/index.ts:386–514](../packages/server/src/index.ts#L386), [parse-turns.ts:167](../packages/server/src/agent-backend/parse-turns.ts#L167) | **Re-implemented** — see §9. |
| Model enumeration from `~/.openclaw/openclaw.json` | [threads/routes.ts:299](../packages/server/src/threads/routes.ts#L299) | Pi's `ModelRegistry.getAvailable()` → filtered by `AuthStorage`. |
| `sessions.json` — global session registry | 8 callsites listed in §6 | Sovereign-owned registry; see §6 + §7. |

---

## 9. Subagents — Detailed Requirements

**Subagents MUST be implemented natively in Sovereign.** Pi does not ship them; OpenClaw's `sessions_yield` mechanism does not translate. Sovereign owns the orchestration on top of Pi's per-session primitive.

Subagents are used today across the UI and MUST keep working:

- `/api/threads/active-subagents` — drawer badges for in-flight child work.
- `/api/threads/:key/subagents` — per-thread child list.
- `/api/threads/:key/history` — child session transcript.
- [chat/chat.ts:272](../packages/server/src/chat/chat.ts#L272) — work-item placeholder during yield (replaced by tool-call card under Pi).

### Implementation

Implement a `spawn_subagent` `AgentTool` registered with Pi. When the LLM invokes it:

**Tool contract:**

```ts
{
  name: 'spawn_subagent',
  description: 'Spawn an autonomous subagent to perform a focused task...',
  parameters: Type.Object({
    task: Type.String({ description: 'What the subagent should accomplish' }),
    label: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(Type.String()),
    timeout_ms: Type.Optional(Type.Number())
  }),
  executionMode: 'parallel', // subagents can run concurrently
  execute: async (toolCallId, params, signal, onUpdate) => {
    const childKey = `agent:main:subagent:${crypto.randomUUID()}`
    const child = await runtime.newSession({
      parentSession: parentSession.sessionFile,
      systemPrompt: params.task,
      model: resolveModel(params.model),
      tools: defaultSubagentTools(),
    })
    registry.upsert({
      logicalKey: childKey,
      piSessionId: child.sessionId,
      piSessionFile: child.sessionFile!,
      kind: 'subagent',
      parentLogicalKey: parentLogicalKey,
      spawnedBy: parentLogicalKey,
      task: params.task,
      label: params.label,
      status: 'working',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
    })
    // Stream child events into the registry; surface progress via onUpdate
    const unsub = child.subscribe((ev) => {
      if (ev.type === 'turn_end') {
        onUpdate?.({ content: [{ type: 'text', text: extractSummary(ev.message) }], details: { childKey } })
      }
    })
    try {
      await child.prompt(params.task)
      const summary = collectFinalAssistantText(child.agent.state.messages)
      registry.upsert({ logicalKey: childKey, status: 'done', updatedAt: Date.now() })
      return {
        content: [{ type: 'text', text: summary }],
        details: { childKey, sessionFile: child.sessionFile, totalTokens: sumUsage(child) }
      }
    } finally {
      unsub()
    }
  }
}
```

**Requirements (MUST):**

- **R-SA-1.** Subagents MUST be first-class entries in `SessionsRegistry` (`kind: 'subagent'`, `parentLogicalKey` set).
- **R-SA-2.** Subagent events MUST be exposed via the same `AgentBackendEvents` event bus, keyed by the subagent's logical key, so the existing client subscribes once.
- **R-SA-3.** Active subagent status MUST update on every `turn_end` (working → idle) and `agent_end` (final → done).
- **R-SA-4.** `/api/threads/active-subagents` MUST return subagents in `status ∈ {working, thinking}` grouped by `parentLogicalKey`.
- **R-SA-5.** `/api/threads/:key/subagents` MUST resolve children via `parentLogicalKey`, not pattern-matching on session-key prefixes.
- **R-SA-6.** Subagent transcripts MUST be readable through `backend.getHistory(childKey)`.
- **R-SA-7.** Cancelling the parent MUST cancel running children. The tool's `signal` parameter wires this for free.
- **R-SA-8.** Subagent tool MUST NOT recurse infinitely — depth limit (default 3) enforced from the registry.
- **R-SA-9.** Pi's `terminate: true` return value MUST be supported so a successful subagent can short-circuit the parent's next LLM call when appropriate.

**Requirements (SHOULD):**

- **R-SA-10.** The subagent tool SHOULD stream a brief progress line via `onUpdate` after each child `turn_end` so the parent's tool-call card updates in real time.
- **R-SA-11.** Default subagent toolset SHOULD be a read-mostly subset (`read`, `grep`, `find`, `ls`, optionally `bash`) — configurable per spawn.
- **R-SA-12.** Subagent JSONL files SHOULD live in a `subagents/` subdirectory of the parent's Pi session directory so they're co-located on disk (file-driven principle).
- **R-SA-13.** Cleanup policy SHOULD be: subagent JSONL retained as long as the parent session exists; deleted when the parent is deleted.

Effort: ~2–3 days including tests. Subagents are a Phase B blocker for default-flip (Phase D).

---

## 10. History Migration (Opt-in)

Existing OpenClaw sessions live in `~/.openclaw/agents/main/sessions/*.jsonl`. Migrating them is not required for Sovereign to function — Pi starts with empty sessions — but users will lose chat history without it.

**Approach:** one-shot importer behind a CLI flag.

```
bin/sovereign import-openclaw-history [--dry-run]
```

Behaviour (MUST):

- **R-IM-1.** For each session under `~/.openclaw/agents/main/sessions/sessions.json`, create a corresponding Pi session via `AgentSessionRuntime.importFromJsonl()`, mapping OpenClaw's JSONL into Pi's v3 tree format. `parse-turns.ts` already handles both shapes for the read path; the write path needs a small `openclaw-to-pi-jsonl` mapper.
- **R-IM-2.** Populate `SessionsRegistry` with `logicalKey` (preserved from OpenClaw), `piSessionId` (new), `piSessionFile` (path), `label`, `kind`, `parentLogicalKey`, `task`, model metadata.
- **R-IM-3.** Importer MUST be idempotent — re-running skips already-imported sessions (tracked via a `.imported` marker per session id).
- **R-IM-4.** `--dry-run` reports what would be imported without writing.
- **R-IM-5.** Importer leaves `~/.openclaw/` untouched. User deletes manually after verification.

**Out of scope:** importing cron jobs (manually re-create), device tokens (no longer relevant), `OPENCLAW_WORKSPACE` symlinks (env rename).

---

## 11. Client Impact

The plan in §2 is "client doesn't change." Two minor exceptions:

1. **System view's gateway-restart button** — remove. The whole notion of an out-of-process agent runtime to restart disappears.
2. **System view's device panel** — depends on whether `/api/system/devices` is kept (showing the local Sovereign device) or removed. If kept, the public-key field becomes `null`. Recommend hiding the panel when `deviceId === 'local'`.

No other client changes. The WS protocol, all of [packages/client/src/features/chat/\*](../packages/client/src/features/chat/), threads, voice, recordings — all untouched.

---

## 12. Configuration

### New environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOVEREIGN_AGENT_BACKEND` | `pi` | `pi` or `openclaw`. Removed after deprecation period. |
| `PI_AGENT_DIR` | `~/.pi/agent` | Pi's storage root (auth, models, sessions). |
| `PI_CWD` | `$SOVEREIGN_DATA_DIR/workspace` or first org project | Working directory for Pi's tools (`bash`, `read`, etc.) and `DefaultResourceLoader` discovery. |
| `PI_DEFAULT_PROVIDER` | `anthropic` | Initial model provider when creating new sessions. |
| `PI_DEFAULT_MODEL` | (unset) | Initial model id. Falls back to Pi's resolution rules. |
| `PI_DEFAULT_THINKING` | `off` | One of off/minimal/low/medium/high/xhigh. |
| `ANTHROPIC_API_KEY` etc. | (unset) | Same env-var pattern Pi already honours. |
| `SOVEREIGN_WORKSPACE` | (was `OPENCLAW_WORKSPACE`) | File picker root. |

### Removed environment variables

| Variable                 | Reason                         |
| ------------------------ | ------------------------------ |
| `OPENCLAW_GATEWAY_URL`   | No remote gateway.             |
| `OPENCLAW_GATEWAY_TOKEN` | No remote auth.                |
| `OPENCLAW_WORKSPACE`     | Renamed `SOVEREIGN_WORKSPACE`. |

`.env.example` and `README.md` MUST be updated. The `bin/sovereign` script's health-check messaging should reference Pi rather than OpenClaw.

### Hot-reload

OpenClaw config supported hot-reload (`onConfigChange` re-handshakes). Pi doesn't need a connection, but it does need to handle:

- Model changes — call `session.setModel()` on each open session, or just on the next prompt.
- API key changes — `authStorage.setRuntimeApiKey()` (non-persistent) or reload `auth.json`.
- `cwd` changes — require restart (Pi's tools bind to cwd at session creation). Document this.

---

## 13. Phasing

### Phase A — Land Pi backend behind a flag (~3–4 days)

- New `pi.ts`, `pi-events.ts`, `pi-registry.ts`.
- Backend selector in `index.ts`.
- `AgentBackend` additions (§7).
- `getHistory`/`getFullHistory` reading Pi JSONL.
- All routes refactored to call `backend.listSessions / listSubagents / getSessionMeta / setSessionModel / listAvailableModels`.
- Pi backend stubs subagent methods as empty arrays; cron methods as no-ops.
- `SOVEREIGN_AGENT_BACKEND=openclaw` still default; CI runs both.

**Acceptance:** with `SOVEREIGN_AGENT_BACKEND=pi`, a user can open the Main thread, send a message, get a streamed response with tool calls, abort, switch model, see history, switch threads — all working. Subagents and cron are non-functional but don't crash.

### Phase B — Subagents (~2–3 days)

- Implement `spawn_subagent` tool per §9.
- Restore `/api/threads/active-subagents`, `/api/threads/:key/subagents`, `/api/threads/:key/history` on the Pi backend.

**Acceptance:** parent thread spawns subagent via tool call; child appears in the drawer; child completes; result returns to parent; UI behaves the same as today's OpenClaw flow.

### Phase C — Cron (~1 day)

- Wire Sovereign scheduler to `backend.sendMessage()`.
- Delete `cron-monitor.ts`'s gateway-poll path.
- Delete `cron.list / runs / update / remove` from the OpenClaw backend (or leave for the deprecation release).

**Acceptance:** existing cron UI continues to work, fired by Sovereign's scheduler.

### Phase D — Flip default, deprecate OpenClaw (~0.5 day)

- `SOVEREIGN_AGENT_BACKEND=pi` becomes default.
- Add deprecation log when `openclaw` is selected.
- Add `bin/sovereign import-openclaw-history` (§10) if pursued.

### Phase E — Delete OpenClaw (~0.5 day, after one release)

- Delete `agent-backend/openclaw.ts`, `agent-backend/openclaw.test.ts`, `session-reader.ts` OpenClaw paths.
- Delete OpenClaw env vars from `.env.example`.
- Remove backend selector (Pi is the only option).
- Remove device-identity persistence files at startup (one-time cleanup with logging).

**Total estimate:** 1 week minimum (drop subagents); 2 weeks for full parity.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
| --- | --- | --- |
| Pi's session-id is a UUID; existing thread state references OpenClaw-style `agent:main:thread:<x>` keys. | Logical key remains canonical in Sovereign. Registry maps logical → Pi UUID. Persisted thread state needs no migration. |
| Pi runs in-process — heavy LLM calls block the event loop less than gateway IPC, but tool executions (e.g. `bash`) now share the server's process. | Pi's `AgentTool.execute` accepts `AbortSignal`; long-running tools should be implemented to cooperate. Most heavy work (LLM streaming, file I/O) is already async. |
| `bash` tool now runs in the Sovereign server's process, not OpenClaw's sandbox. | Document. Optionally disable `bash` for non-developer deployments via `tools: ['read', 'grep', 'find', 'ls', 'edit', 'write']`. |
| Pi's default `cwd` is process cwd; Sovereign needs explicit `PI_CWD` per spawn. | Pass `cwd` explicitly to `createAgentSession` for every session. Document in §12. |
| Model availability differs by configured API keys; UI must reflect this. | `backend.listAvailableModels()` already returns the filtered list — keep `/api/models` cached as today. |
| History format change (Pi v3 tree JSONL vs OpenClaw linear JSONL) breaks `getFullHistory` paging. | `parse-turns.ts` already supports two formats. Add Pi's `id`/`parentId` linearisation (depth-first from root to active leaf). |
| Sovereign's existing tests assert OpenClaw text shapes (`Sender (untrusted metadata):` etc.) | Delete those assertions when removing the corresponding noise filters. Add Pi-format fixtures. |
| Concurrent prompts during streaming. | Pi requires explicit `streamingBehavior: 'steer' | 'followUp'`. Map Sovereign's "send while busy" to `'steer'` by default (matches today's UX where messages interrupt the current turn). |
| `tool_execution_update` (Pi streams partial tool output) has no current UI surface. | Swallow for now. Optional follow-up: extend `WorkItem` with a streaming-update channel. |

---

## 15. Verification Checklist

Before flipping the default in Phase D, the following MUST pass on a fresh dev environment:

- [ ] `pnpm dev` boots without `OPENCLAW_GATEWAY_URL` set.
- [ ] Send a message on Main thread; observe streamed text and tool calls in real time.
- [ ] Abort mid-stream; status returns to idle.
- [ ] Switch to a different thread; load history (paginated and full).
- [ ] Change model via the thread header dropdown; next prompt uses new model.
- [ ] Trigger a cron job; result delivered into target thread.
- [ ] Spawn a subagent via tool call; appears in drawer; result returns to parent (Phase B).
- [ ] Restart Sovereign; all open threads reattach to their Pi sessions; history intact.
- [ ] Kill the process during streaming; on restart, no zombie state, no lock files held.
- [ ] `/api/system/health` reports `agentBackend: 'connected'`.
- [ ] `bin/sovereign status` reports green.
- [ ] No references to `~/.openclaw/` in `git grep` (outside `openclaw.ts` and its test).
- [ ] All Vitest suites pass with `SOVEREIGN_AGENT_BACKEND=pi`.

---

## 16. Resolved Design Decisions

1. **Expose Pi's `steer()` and `followUp()` to the client — nice-to-have, follow-up phase.** Migration default: "send while streaming" maps to `steer` (matches today's implicit behaviour). After Phase D, surface explicit "steer" vs "queue for after" affordances in the composer UI as a follow-up feature. New WS messages `chat.steer` and `chat.followUp` MAY be added; existing `chat.send` keeps its current semantics.
2. **`AGENTS.md` discovery — defer.** Pi's `DefaultResourceLoader` walks up from `cwd` looking for `AGENTS.md`. For migration we MUST pass an explicit `cwd` to each session but do not rely on `AGENTS.md` injection. Coding-specific workflows that benefit from `AGENTS.md` are a later concern; revisit when adding per-thread `cwd` (decision 4).
3. **Pi extensions — closed runtime.** Sovereign does NOT load Pi extensions, skills, prompt templates, or themes during migration. Pass a minimal `ResourceLoader` that returns empty sets, or use `DefaultResourceLoader` with discovery roots pointed at a Sovereign-owned empty directory. Sovereign's own modules remain the only extension mechanism. Re-evaluate after the migration ships.
4. **Per-thread `cwd` — out of scope.** All sessions share a single `PI_CWD` for this migration. Design the registry shape to allow `ThreadSessionRecord.cwd?` so future work can split by org/project without a schema change, but do not implement the routing. Document as a known limitation.
5. **Richer token accounting — defer.** Migration keeps the current shape (`totalTokens`, `inputTokens`, `outputTokens`, `contextTokens`, `compactionCount`). Pi's per-message `Usage` with `cost` is captured into the registry but only the legacy fields are surfaced. A richer system-view dashboard is a follow-up.

---

## 17. Capabilities Pi Unlocks

These are improvements Sovereign gets from Pi over OpenClaw — either as a side-effect of the migration, as a planned next step that becomes much cheaper, or as an architectural capability that wasn't possible before. None of these are required for migration to ship; they're documented so we don't lose track of what's now feasible.

### 17.1 Architecture & Operational Wins (free, immediate)

- **No external daemon.** `bin/sovereign` no longer needs to coordinate with a separate `openclaw gateway` process. One launchd service, not two. Simpler health model, simpler crash recovery, simpler logs.
- **No IPC tax.** Sub-millisecond in-process method calls replace per-message JSON round-trips over WebSocket. Eliminates the 30s `REQUEST_TIMEOUT` ([openclaw.ts:15](../packages/server/src/agent-backend/openclaw.ts#L15)) entirely.
- **No reconnect/backoff/jitter logic.** ~80 lines deleted ([openclaw.ts:70–79, 745–762](../packages/server/src/agent-backend/openclaw.ts#L70)).
- **No device-pairing/ed25519/deviceToken state.** ~150 lines deleted ([openclaw.ts:34–68, 559–743](../packages/server/src/agent-backend/openclaw.ts#L34)). Files at `~/.sovereign/agent-backend/device-identity.json` and `device-token.json` become irrelevant.
- **No 60MB-sessions.json parsing.** The cached-map hack in [parse-gateway-sessions.ts:62–105](../packages/server/src/threads/parse-gateway-sessions.ts#L62) goes away. Registry lookups are O(1) in-memory.
- **No "re-read JSONL at turn end to recover missed tool calls" hack.** The `getSessionFilePath → readRecentMessages → parseTurns` path in [openclaw.ts:394–413](../packages/server/src/agent-backend/openclaw.ts#L394) deletes; Pi gives us the complete turn structure in `turn_end`.
- **No streaming-delta accumulation hack.** `lastStreamLengths`, `seenToolCallIds`, `seenToolResultIds` maps in [openclaw.ts:240–243](../packages/server/src/agent-backend/openclaw.ts#L240) all delete. Pi emits true deltas.
- **AbortSignal flows end-to-end into tools.** Sovereign can finally cancel an in-flight `bash` cleanly. Today abort is a best-effort RPC to OpenClaw which may or may not honour it. Pi's `tool.execute(toolCallId, args, signal, onUpdate)` makes cancellation a first-class capability.
- **Awaited subscriber settlement (`agent_end` barrier).** Pi guarantees `await session.prompt()` resolves only after every event subscriber finishes processing `agent_end`. This lets Sovereign reliably flush registry updates, notify the bus, and persist state without races. Today this is impossible — gateway events fire async and Sovereign has no settlement signal.
- **Supply-chain hardening.** Pi's package itself pins exact versions, uses `min-release-age=2`, ships an `npm-shrinkwrap.json`, and runs scheduled `npm audit`. Sovereign benefits transitively.

### 17.2 Streaming & Event-Model Improvements

- **Tool execution updates (`tool_execution_update`).** Pi streams partial tool output. Today Sovereign sees tool results only on completion. Possible UI improvements: live `bash` output, live file-read progress, live subagent transcript snippets — all within the same `WorkItem` model with a small extension for streaming text.
- **Thinking deltas are first-class.** `message_update.thinking_delta` is a typed event, not a string heuristic. The thinking-block stripping logic in [thinking.ts](../packages/server/src/agent-backend/thinking.ts) and the `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` cleanup in [parse-turns.ts:58](../packages/server/src/agent-backend/parse-turns.ts#L58) go away.
- **`queue_update` events.** Pi emits when steering/follow-up queues change. Drives a queue indicator in the composer ("1 steer queued") without polling.
- **`compaction_start` / `compaction_end` are explicit.** Sovereign's [chat.compacting](../packages/core/src/agent-backend.ts#L55) event becomes a clean 1:1 mapping. Currently inferred from gateway `stream: 'compaction'` payloads.
- **`auto_retry_start` / `auto_retry_end` events.** Pi exposes retry state explicitly (rate limits, transient provider errors). Sovereign can surface "Retrying in Xs…" in the UI instead of a generic stall.

### 17.3 Session Model Improvements

- **Tree-structured sessions (v3 JSONL with `id`/`parentId`).** Pi sessions are trees, not lines. Every entry has a parent. This unlocks:
  - **Branching.** "What if I had said X instead at this point?" `runtime.fork(entryId, { position: "at" })` creates a new active branch without copying the file.
  - **In-place navigation.** `session.navigateTree(targetId)` rewinds the active leaf, optionally summarising the discarded branch as a system message. Matches Sovereign's planning DAG philosophy.
  - **Multiple alternative explorations from the same prompt.** Useful for the planning module (DAG-based planning per [README.md](../README.md)) — alternate plan branches as session forks.
- **Compaction is an explicit API.** `session.compact(customInstructions?)`, `session.abortCompaction()`, `transformContext` hook. Sovereign can:
  - Trigger compaction on demand from the UI ("compact this thread now").
  - Pass thread-specific instructions ("focus on the issue we're tracking, drop the bash output").
  - Set thresholds per-thread (e.g., compact at 80% of context for chat threads, 95% for long-running automations).
- **`shouldStopAfterTurn` hook.** Stop gracefully after the current turn. Useful for compaction-on-demand, scheduled session pauses, and clean "park this agent" UX.
- **`importFromJsonl`.** Import any JSONL — Pi's own format, claude-cli, anything we can map. Makes the OpenClaw history migration (§10) a thin mapper, not a rewrite. Also enables future "import this conversation as the starting context" flows.
- **Per-cwd session directories.** `~/.pi/agent/sessions/--<cwd>--/` — natural fit for Sovereign's multi-org, multi-project workspace. Pre-bakes the future per-thread-`cwd` capability.
- **Explicit `sessionId` for provider prompt caching.** Pi takes a `sessionId` config that's passed to the LLM provider's cache-control headers. Sovereign can cache-key by thread, by org, by user — fine-grained cost control.

### 17.4 Tool Runtime Improvements

- **First-class tool registration with schema validation.** `AgentTool` uses `typebox` parameter schemas. Sovereign can register typed tools (e.g., `create_issue`, `update_planning_node`, `start_recording`, `play_tts`) that the agent invokes directly, with arguments validated before execution. Today this requires either OpenClaw-side tool configuration or gateway-mediated tool relay.
- **Parallel tool execution (`toolExecution: "parallel"`).** Pi runs independent tool calls concurrently with a sequential preflight phase. Single-shot speedup for read-heavy turns ("read these 5 files in parallel"). Per-tool override (`executionMode: "sequential"`) for mutating tools.
- **`beforeToolCall` hook for policy enforcement.** Audit and block tool calls before execution. Sovereign can implement:
  - Per-thread/per-org tool allowlists.
  - Confirmation prompts ("LLM wants to run `git push --force` — approve?").
  - Rate limits on expensive tools.
  - Tool-call logging tied to thread + user identity (multi-org audit).
- **`afterToolCall` hook.** Post-process every tool result. Inject metadata (`details.audited = true`), redact sensitive output, surface as additional `WorkItem`s.
- **`terminate: true` from tools.** Tools can hint that the agent should stop after the current batch. Enables clean "task completed" signals without injecting fake user messages — the current OpenClaw pattern of `[Internal task completion event]` and `NO_REPLY` heuristics in [parse-turns.ts:91–106](../packages/server/src/agent-backend/parse-turns.ts#L91) goes away.
- **Streaming tool progress (`onUpdate`).** Tools can stream partial results back through the event bus. Long-running tools (file scans, large file reads, multi-step bash) no longer appear stuck.
- **Sovereign-native tools as Pi tools.** The chat module can register tools that bridge to Sovereign's event bus directly — `bus.emit('issues.create', ...)`, `bus.emit('terminal.execute', ...)`. Removes the need for any external tool registry. Cleanest possible integration of LLM with Sovereign's existing module surface.
- **Built-in tools ship for free.** `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Production-tested. Sovereign can opt into any subset, or replace any of them with org-policy-aware versions.

### 17.5 Multi-Provider & Auth Improvements

- **Many providers out of the box.** Anthropic (API + Claude Pro/Max subscription), OpenAI (API + ChatGPT Plus/Pro Codex subscription), GitHub Copilot subscription, Google Gemini, Google Vertex, Amazon Bedrock, Azure OpenAI, Mistral, DeepSeek, Groq. OpenClaw bound Sovereign to whatever OpenClaw supported.
- **Subscription auth, not just API keys.** A user with a Claude Pro/Max account can sign in via `/login` instead of provisioning API keys — substantial UX win for non-developer Sovereign users.
- **OAuth refresh built-in.** `getApiKey: async (provider) => refreshToken()` config hook handles expiring subscription tokens transparently.
- **Custom models via `models.json`.** Register any OpenAI-compatible endpoint — local LLMs (llama.cpp, ollama), proxies (LiteLLM, OpenRouter), private deployments. Removes any "we only work with these vendors" ceiling.
- **`scopedModels`** for fast cycling. Maps cleanly to a per-thread model dropdown with a curated set.
- **Runtime API-key overrides.** `authStorage.setRuntimeApiKey(provider, key)` (non-persistent). Per-thread, per-org credentials become feasible without touching disk.
- **Per-thinking-level token budgets.** `thinkingBudgets: { minimal: 128, low: 512, medium: 1024, high: 2048 }`. Sovereign can tune thinking spend per-thread or per-org policy.

### 17.6 Steering & Follow-up

- **`steer()`** — interrupt mid-turn. Today Sovereign's "send while streaming" is undefined behaviour from the gateway's perspective. Pi formalises it: steering messages inject between the current turn's tool calls and the next LLM call. Predictable interruption, no race.
- **`followUp()`** — queue work for after the agent stops. Today this requires user re-engagement; with `followUp` the user can preload "after you finish the refactor, run the tests" and walk away.
- **`steeringMode: "all"`** — process every queued steer instead of one-at-a-time. Useful for voice mode where the user dictates several corrections rapidly.
- **`clearSteeringQueue()` / `clearFollowUpQueue()`** — explicit queue management. UI affordance: "X messages queued — clear?"

### 17.7 Custom Message Types (Declaration Merging)

Pi supports extending `AgentMessage` with custom types via TypeScript declaration merging:

```ts
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    sovereign_notification: { role: "sovereign_notification"; entityKey: string; text: string; timestamp: number }
    sovereign_forwarded: { role: "sovereign_forwarded"; sourceThread: string; originalContent: string; ... }
    sovereign_cron_result: { role: "sovereign_cron_result"; jobId: string; output: string; timestamp: number }
    sovereign_entity_event: { role: "sovereign_entity_event"; entityKey: string; eventType: string; payload: any }
  }
}
```

With `convertToLlm` filtering them out before the LLM call, these become **first-class transcript entries** that:

- Render in the UI with their own type-specific component.
- Get persisted to JSONL alongside real messages.
- Are searchable in history.
- Replace today's hacks: timestamp-prefixed system strings, `[Sender (untrusted metadata)]` JSON envelopes, `[CronResult]`/`[Scheduled:]`/`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` markers — all of [parse-turns.ts:53–145](../packages/server/src/agent-backend/parse-turns.ts#L53) deletes.

Forwarded messages, entity-bound events, cron results, and notifications all become typed objects instead of fragile string parsing.

### 17.8 Direct Bus Integration

Because Pi runs in-process, Sovereign can:

- **Wire bus events directly into tools.** A `subscribe_to_bus` tool that the agent calls to receive live events (CI results, review comments, terminal output) without webhook plumbing.
- **Emit bus events from tools synchronously.** `bus.emit()` is now part of the same event loop as the agent. Multi-agent orchestration without coordination overhead.
- **Inline state inspection.** `session.agent.state.messages` is a JS array — the system view can show real conversation state, not a cached snapshot from a 60MB JSON file.
- **Synchronous tool installation.** Hot-reload a tool registration and the agent picks it up on the next turn. Today this requires gateway restart.

### 17.9 Sovereign Roadmap Alignment

Cross-referenced with [README.md](../README.md) capability list and [PRINCIPLES.md](../PRINCIPLES.md):

| Sovereign capability | What Pi enables |
| --- | --- |
| **File-driven (PRINCIPLES.md §1).** | Pi's per-cwd JSONL sessions are already file-driven and human-readable. Tree structure is `git diff`-able. |
| **Event bus as nervous system (§2).** | Pi events map 1:1 to the bus. In-process means no event loss across IPC. |
| **Runtime configuration (§3).** | Pi accepts model/thinking-level/tool changes per-prompt with no restart. Cleaner than OpenClaw's hot-reload. |
| **Reliability through code (§4).** | Subagent orchestration, scheduling, queueing all become Sovereign code, not gateway code. We own the determinism. |
| **Total transparency (§5).** | Every Pi event is observable. `tool_execution_update` exposes mid-tool state. No black boxes. |
| **DAG-based planning.** | Pi's session-tree maps to a plan-node tree. Plan branches as session forks. |
| **Multi-org / multi-project.** | Per-cwd sessions are the natural unit. Future `ThreadSessionRecord.cwd` (decision 4) makes each thread project-scoped. |
| **Voice as first-class.** | `steer()` with rapid corrections matches voice UX ("no wait — instead of X, do Y"). |
| **Entity-bound chat threads.** | Custom message types (§17.7) make entity events first-class transcript entries. |
| **External meeting import.** | `importFromJsonl` makes ingesting meeting summaries as agent context trivial. |
| **Issues & reviews unified.** | Sovereign-native `create_issue`, `add_review_comment` tools register directly with Pi. |
| **Holonic event viewer (Observability).** | Pi's typed event stream feeds the architecture view without translation. |

### 17.10 Code Deletion Inventory

Concrete deletions enabled by Pi, beyond the gateway driver itself:

| Code | Lines | Reason |
| --- | --- | --- |
| Device identity, ed25519 signing, deviceToken persistence | ~150 in [openclaw.ts](../packages/server/src/agent-backend/openclaw.ts) | No remote to authenticate to. |
| Reconnect/backoff/jitter | ~30 in [openclaw.ts:70–79, 745–762](../packages/server/src/agent-backend/openclaw.ts#L70) | In-process. |
| Pending-request map, RPC timeout, message-id generator | ~40 in [openclaw.ts:138–187](../packages/server/src/agent-backend/openclaw.ts#L138) | Direct method calls. |
| `lastStreamLengths`, `seenToolCallIds`, `seenToolResultIds`, `thinkingAccum` delta-tracking | ~80 in [openclaw.ts:240–432, 297–428](../packages/server/src/agent-backend/openclaw.ts#L240) | Pi emits true deltas with stable IDs. |
| Turn-end JSONL re-read for missing tool calls | ~25 in [openclaw.ts:394–413](../packages/server/src/agent-backend/openclaw.ts#L394) | `turn_end` carries the complete turn. |
| `stripTimestamp`, `stripInternalContextWrapper`, `stripSenderEnvelope`, `extractEmbeddedUserMessage`, `isSystemInjected`, `normalizeSystemText` and 8+ regexes | ~120 in [parse-turns.ts:52–145](../packages/server/src/agent-backend/parse-turns.ts#L52) | Custom message types replace string envelopes. |
| 60MB sessions.json cached-map parser | ~50 in [parse-gateway-sessions.ts:62–105](../packages/server/src/threads/parse-gateway-sessions.ts#L62) | In-process registry. |
| `cron-monitor.ts` auto-fix logic for gateway-side cron misconfig | ~100 in [cron-monitor.ts](../packages/server/src/scheduler/cron-monitor.ts) | Sovereign owns cron. |
| `sessions_yield` special-case in chat module | ~15 in [chat.ts:272](../packages/server/src/chat/chat.ts#L272), [parse-turns.ts:277–298](../packages/server/src/agent-backend/parse-turns.ts#L277) | Pi-based subagents use a typed tool, not yield. |
| Gateway restart service + HTTP route | ~30 in [system/routes.ts:55–69, 186–208](../packages/server/src/system/routes.ts#L55) | No daemon. |
| `fetchContextBudgetFromGateway` + mock | ~50 in [system/routes.ts:34–91](../packages/server/src/system/routes.ts#L34) | Computed from `agent.state`. |
| `OPENCLAW_WORKSPACE` indirection | ~5 in [files/routes.ts:55–58](../packages/server/src/files/routes.ts#L55) | Renamed. |

**Estimated net deletion:** ~700 lines, plus ~300 lines of associated tests. Replacement code (Pi backend + registry + subagent tool) is ~600 lines including tests. Net codebase reduction is modest; the meaningful win is conceptual surface area — fewer moving parts, fewer race conditions, fewer hacks.

### 17.11 Future Capabilities Now Cheap

Items not in scope for migration but newly tractable:

- **Multi-agent orchestration.** Multiple `AgentSession` instances in the same process, sharing the bus, with typed messages flowing between them. The "two agents collaborating on a task" pattern that's painful via gateway IPC becomes a function call.
- **Agent ensembles.** Spawn three sessions with different models on the same prompt, pick the best answer, or merge. `Promise.all([s1.prompt(p), s2.prompt(p), s3.prompt(p)])`.
- **Speculative execution.** Fork a session, try a destructive action in the fork, roll back if it fails. Pi's tree branching is the substrate.
- **Replay & debugging.** `importFromJsonl` + read-only mode = replay any session deterministically for bug repro, regression tests, or training data.
- **Time-travel debugging within a thread.** `navigateTree(turnId)` rewinds the conversation; replay from any point with modified instructions.
- **Per-org / per-project credential isolation.** Multiple `AuthStorage` instances scoped per-org. A user's personal API key never reaches a work org's session.
- **Cost telemetry.** Pi reports cost per assistant message. Aggregate into the system view; bill per-org; flag expensive threads.
- **LLM-as-tool.** Register a sub-LLM as a Pi tool (cheap-fast model for classification, expensive model for the main loop). Today this requires nested gateway sessions.
- **Voice latency reduction.** With Pi in-process, the path from speech-recognised text → `session.prompt()` → first streamed delta drops a full WebSocket round-trip. Tighter feedback loop for voice mode.
- **Agent-driven Sovereign administration.** A Sovereign module ("config agent") registers tools that modify Sovereign's own configuration. Self-modifying workspace.

---

## 18. Open Questions

(None — migration scope is locked. New questions raised during implementation should be appended here with a date.)
