# Lossless Restart — JSONL-Derived Liveness

**Status:** Revised after v1 field failure **Revision:** 2 **Date:** 2026-05-27

A Sovereign restart must auto-continue any thread whose agent was genuinely mid-turn, never auto-continue a thread that was idle (e.g. cron-driven and waiting for the next fire), and surface the correct `agentStatus` to the UI for both cases. The v1 design relied on an in-process `active-sessions.json` index written through on every status transition. Field testing showed this is brittle (false-idle emissions remove the entry permanently) and incomplete (only the chat module's `sendMessage` path was instrumented; cron, AD4M, and MCP-driven sends bypass it entirely). This revision throws out the in-process index and derives liveness from the on-disk JSONL transcript, which is the only source that captures every message regardless of caller and is immune to in-process status divergence.

Conforms to [PRINCIPLES.md](../PRINCIPLES.md) §6 (File-Driven by Default), §5 (Single Source of Truth), §7 (No Hidden State).

## Field-failure post-mortem (v1)

The `neural-nets` thread, mid-autonomous-cron-loop, was restarted and not resumed. Investigation found:

1. **`active-sessions.json` was empty at restart.** The Claude Code adapter's internal subscription called `markIdle` in response to a `chat.status: idle` emission and removed the entry. The model was actually still working — the idle emission was triggered by the SDK's `Stop` hook firing between turn boundaries, which is not "agent is done" but "the model is paused between rounds".
2. **The chat module's queue would not have helped.** Cron-driven prompts go through [packages/scheduler/src/cron-service.ts:151](../packages/scheduler/src/cron-service.ts#L151) directly to `routing.forSession(sessionKey).sendMessage(...)`, never touching the chat queue. AD4M-injected prompts ([bootstrap.ts:347](../packages/server/src/bootstrap.ts#L347)) and MCP-tool sends ([mcp-deps.ts:72](../packages/agent-backend/src/mcp-deps.ts#L72)) do the same. The queue captures only user-initiated sends from the web UI.
3. **The dashboard `agentStatus` was unrelated.** It reads `thread.agentStatus` from `threads/registry.json`, which is only ever written `'idle'`. The thread-list route had no Claude Code overlay (and the OpenClaw overlay it carried has since been removed alongside the adapter). Users see a stale indicator that's wrong in both directions.

The v1 approach attacks the wrong layer. In-process status events are a derived signal — they fire from multiple sources, with multiple meanings, and they can be wrong. The JSONL transcript is the canonical record. We should read it directly.

## The new model in one sentence

**The session JSONL is the canonical record of liveness; everything else derives from it.**

## The JSONL liveness analyzer

A single pure function:

```ts
type SessionLiveness =
  | { kind: 'idle' }
  | { kind: 'mid-turn-no-response'; lastUserAt: number; lastUserText: string }
  | { kind: 'mid-turn-unanswered-tool'; toolUseId: string; toolName: string; lastAssistantAt: number }
  | { kind: 'mid-turn-tool-result-unanswered'; lastToolResultAt: number }

interface AnalyzeOptions {
  /** Max age (ms) of the most recent unfinished message. Older than this and the session
   *  is classified `idle` regardless of tail pattern. Default: 5 minutes. */
  freshnessMs?: number
  /** Wall clock now() for testing. Defaults to Date.now(). */
  now?: () => number
}

function analyzeSessionJsonl(filePath: string, opts?: AnalyzeOptions): SessionLiveness
```

**Two-stage cheap → expensive evaluation** so a registry with hundreds of stale threads costs only one `fs.stat` per session, not a tail-read:

1. **Stat gate (cheap).** `fs.statSync(filePath).mtimeMs`. If `now - mtimeMs > freshnessMs` → return `idle` immediately. The SDK flushes per-message, so file mtime closely tracks the most recent transcript line.
2. **Tail-read gate (only if stat is fresh).** Read the last ~50 entries via the existing tail-first chunked [`readRecentMessages`](../packages/primitives/src/jsonl.ts) helper. Filter out non-message entries (`attachment` hook records, `last-prompt` markers, summary entries). Walk backward to find the most recent non-sidechain message:

| Tail pattern | Liveness (before freshness check) |
| --- | --- |
| Last entry is `assistant` with `stop_reason: "end_turn"` | `idle` |
| Last entry is `assistant` with `stop_reason: "tool_use"` and no matching `user` tool_result after | `mid-turn-unanswered-tool` |
| Last entry is `user` with `tool_result` content (no follow-up assistant) | `mid-turn-tool-result-unanswered` |
| Last entry is `user` with plain text content (no follow-up assistant) | `mid-turn-no-response` |
| Empty file or no message entries | `idle` |

3. **Per-entry freshness re-check.** Pull the timestamp off the classifying entry (`lastUserAt` / `lastAssistantAt` / `lastToolResultAt`). If `now - timestamp > freshnessMs` → downgrade to `idle`. This catches the rare race where mtime was bumped by a trailing hook attachment that landed seconds before SIGTERM but the actual last _message_ is older.

Sidechain (`isSidechain: true`) entries are spawned-subagent transcripts inline in the parent JSONL. For the parent's liveness we look only at the most recent non-sidechain message — a subagent still working appears as an `assistant` `stop_reason: "tool_use"` (the Task tool call) with no matching `tool_result`, which is correctly classified as `mid-turn-unanswered-tool`.

This function is **deterministic, stateless, and O(stat) for the common case** of stale sessions.

### Why a freshness gate

Without it, every restart re-prompts every thread that ever ended on an unfinished assistant message — including threads abandoned days or weeks ago. That's wrong (spam) and slow (analyzer reads JSONLs for every registry entry). Stale unfinished work usually means the user moved on; if they want to revive it, they can send a message manually.

**Default: 5 minutes.** Configurable via `config.json` at `resume.freshnessMs` (overridable per-deployment, not per-session). Five minutes is roughly two SDK turn cycles for non-trivial work — long enough to cover a routine restart-during-active-turn, short enough to skip overnight stale threads.

## Three consumers

### 1. `/api/system/agents/active` — replaces the active-sessions endpoint

For each session in `sessionsRegistry` whose `backendKind === 'claude-code'`, resolve the session file path and call `analyzeSessionJsonl`. Return the set whose liveness is not `idle`. No file writes, no subscriptions, no in-process state.

### 2. Thread-list `agentStatus` overlay — fixes the dashboard

In [threads/src/routes.ts](../packages/threads/src/routes.ts), the merge overlays the Claude Code liveness:

```ts
const cc = claudeCodeLiveness.get(t.key)
if (cc && cc !== 'idle') agentStatus = 'working' as any
```

The dashboard tile and thread dropdown light up correctly without any subscription or write-back.

### 3. Boot resume orchestrator — replaces the three-tier dance

After `routingBackend.connectAll()`, before `server.listen`:

```ts
for (const record of sessionsRegistry.list({ backendKind: 'claude-code' })) {
  const filePath = resolveSessionFile(record)
  if (!filePath) continue
  const liveness = analyzeSessionJsonl(filePath)
  if (liveness.kind === 'idle') continue

  // Prefer replaying a queue head when the in-flight prompt text matches —
  // that preserves the user's original UI bubble and de-duplicates.
  const queueHead = chatModule.messageQueue.peek(record.threadKey)
  if (queueHead && queueHead.text === liveness.lastUserText && queueHead.status !== 'queued') {
    chatModule.retryQueued(queueHead.id)
    log('resume', { kind: 'queue-replay', sessionKey: record.sessionKey })
    continue
  }

  // Otherwise (cron, AD4M, MCP, or any direct sendMessage): synthesise the
  // continuation marker. The marker text is fixed so the transcript is
  // self-describing.
  await backend.sendMessage(record.sessionKey, RESTART_CONTINUATION_MARKER)
  log('resume', { kind: 'continuation', sessionKey: record.sessionKey, liveness: liveness.kind })
}
```

The two `mid-turn-*-tool*` cases get continued with the same marker — the SDK's `resume: backendSessionId` rehydrates the transcript and the model decides whether to retry the unanswered tool, abandon it, or proceed.

## What v1 things get deleted

| Component | Why it goes |
| --- | --- |
| [`packages/agent-backend/src/active-sessions.ts`](../packages/agent-backend/src/active-sessions.ts) module | Replaced by JSONL analyzer. |
| `<dataDir>/agent-backend/active-sessions.json` file | No longer the index; JSONL is. |
| `<dataDir>/agent-backend/active-session-pointer.json` file | The `activeSessionKey` in-memory pointer is only used by MCP `agents_spawn` to know whose session to bind a spawn to — it doesn't need persistence across restarts. (A restart with a half-spawned subagent loses no useful state; the parent's JSONL will show the unanswered Task tool_use and Tier 3 nudges from there.) |
| Internal `emitter.on('chat.status' \| 'chat.work' \| 'chat.turn' \| 'subagent.*')` subscription in [claude-code.ts](../packages/agent-backend/src/claude-code/claude-code.ts) | No more transition mirroring needed. |
| `markActive` / `markIdle` / `persistState` calls on every transition | Same. |
| `setInFlight` hook in chat module's `pumpQueue` | Not needed; queue-head correlation in resume is by text match, not stored id. |
| `claudeCodeBackend.flushState()` shutdown call | Per-session claude-code-state file is no longer load-bearing for resume. |
| The three-tier resume orchestrator + `resume.test.ts` | Replaced by simpler walk-the-registry loop with one analyzer call. |
| The CLI's `_notice_active_agents` call to `/api/system/agents/active` for the "N active sessions" line | Keep the call, but it now reads the JSONL-derived endpoint — no implementation change to the CLI itself. |

## What stays

- **[`WriteThroughFile` / `WriteThroughStore`](../packages/primitives/src/write-through-file.ts) primitives.** Useful for other state (chat session-map, scheduler jobs already use atomic-rename of their own). Not removed; just unused by this revision.
- **`chat/live-state/<encodedThreadKey>.json`** files. These exist for SSE replay on client reconnect, not for resume. Keep.
- **`agent-backend/claude-code-state/<sessionKey>.json`** files. These cache `streamLastLength`/`thinkingAccum`/`textAccum`/`lastUsage` so a restart's first `chat.turn` renders coherently. Keep as a cache — not load-bearing for resume.
- **Single-instance lockfile** at `<dataDir>/.sovereign.lock`. Independent of resume; still needed to prevent two Sovereigns writing the same data dir.

## What's still unrecoverable

Honest table — these are inherent to the problem and not addressable by any in-process scheme:

| Failure | Why |
| --- | --- |
| **SIGKILL during the model's HTTP request to Anthropic** | No request-resume protocol exists. On restart the JSONL ends with the user prompt and no assistant; we re-prompt via continuation marker; the agent does the work twice if it had side effects. |
| **Partial assistant tokens not yet flushed by the SDK** | SDK writes JSONL per-message, not per-token. Tokens generated but not finalised into a message line are gone. |
| **In-flight tool subprocess (Bash, etc.)** | The OS process may complete after Sovereign dies; the `PostToolUse` hook never fires; the tool result is never injected into the SDK. On resume the JSONL shows an unanswered `tool_use` and the model is told "continue" — it must re-run the tool or move on. |
| **Native SDK subagents** | The subagent's transcript is in the parent JSONL but its in-process loop dies. The parent sees an unanswered Task tool_use; the model either retries the Task or proceeds without it. We do not synthesise a fake result. |
| **External MCP subprocesses with in-process state** | (e.g. headless browser sessions) die with Sovereign. Out of scope. |
| **Attachments held only in RAM at submit time** | The pump's attachment buffers aren't persisted. Lost. Out of scope — separate spec. |
| **Two Sovereigns on the same data dir** | Lockfile prevents. |

## Requirements

### Liveness derivation

- **R1.** A pure `analyzeSessionJsonl(filePath, opts?): SessionLiveness` function exists in `@sovereign/agent-backend/claude-code/history.ts` (or a sibling), with the table above as its complete behavioural spec.
- **R2.** The function uses the existing tail-first `readRecentMessages` chunked-read helper. No new I/O primitive. Reading the tail of a 20 MB JSONL costs one stat + one 256 KB read.
- **R3.** Sidechain (`isSidechain: true`) entries are skipped for parent-session liveness; they are inline subagent transcripts, not parent activity.
- **R4.** Non-message entry types (`attachment`, `last-prompt`, `summary`, hook records) are filtered out before liveness inference.
- **R4a.** Stat-gate short-circuit: if `now - mtimeMs > freshnessMs`, return `idle` **without** opening the file for a tail read. With a few hundred registry entries this is the dominant cost path; we must not regress to a full tail read per stale session.
- **R4b.** Per-entry freshness re-check: after classifying, if the classifying entry's timestamp is older than `freshnessMs`, downgrade to `idle`. Belt-and-braces against mtime bumped by trailing non-message attachments.
- **R4c.** `freshnessMs` defaults to **5 minutes** (300 000 ms). Overridable via `config.json` at `resume.freshnessMs`. Read once at `resumeActiveSessions` invocation; not per-request hot-reloaded (resume is a boot-time concern).

### Resume on boot

- **R5.** `bootstrapServer` invokes `resumeActiveSessions()` after `routingBackend.connectAll()` and before `server.listen()`. No HTTP traffic is served until the sweep returns.
- **R6.** The sweep walks `sessionsRegistry.list({ backendKind: 'claude-code' })`, stat-gates each session file by mtime against `freshnessMs`, calls `analyzeSessionJsonl` only on the fresh ones, and acts only on non-idle results. A registry with 500 threads where only 2 are fresh costs 500 `stat`s and 2 tail-reads.
- **R7.** When a queue head for the same thread carries text matching the JSONL's `lastUserText`, the head is replayed via `chatModule.retryQueued(head.id)` (preserves UI bubble; no duplicate prompt).
- **R8.** Otherwise the sweep calls `backend.sendMessage(sessionKey, RESTART_CONTINUATION_MARKER)` with the fixed marker `"[Resumed after server restart. Continue from where you left off.]"`.
- **R9.** Every resume action is logged with `sessionKey`, `liveness.kind`, and outcome (`queue-replay` | `continuation` | `skipped`).
- **R10.** A `system.resume` bus event is emitted with the summary counts.

### API + UI

- **R11.** `/api/system/agents/active` walks the registry and returns sessions whose `analyzeSessionJsonl` result is non-idle. The same freshness gate applies — a thread mid-turn but quiescent for >5 min is not "active" by this endpoint either.
- **R12.** The threads-list merge in [threads/routes.ts](../packages/threads/src/routes.ts) overlays `agentStatus = 'working'` for any Claude Code session whose liveness is non-idle. The thread-list request computes the liveness map **lazily and stat-first**: walk every registry entry, stat-gate first, only tail-read the fresh ones. With hundreds of threads this is a fast pass of mtime checks.
- **R13.** The dashboard tile uses the same merged `agentStatus` it already reads. No new endpoint, no new wiring.

### Schema + lockfile

- **R14.** Single-instance lockfile at `<dataDir>/.sovereign.lock` carrying `{pid, startedAt, host}`. Boot refuses on a live foreign PID.
- **R15.** No new file formats are introduced. (v1's `active-sessions.json` schema is deleted.)

### Hygiene

- **R16.** Delete: `packages/agent-backend/src/active-sessions.ts`, `packages/agent-backend/src/active-sessions.test.ts`, `packages/agent-backend/src/resume.ts`, `packages/agent-backend/src/resume.test.ts`, the per-event subscription block in `claude-code.ts`, the `setInFlight` hook in `chat.ts`, the `ChatActiveSessionsHook` interface, the `claudeCodeBackend.flushState` member, the `lastResumeReport` plumbing and `/api/dashboard/resume-summary` route in bootstrap.
- **R17.** Keep: `WriteThroughFile`/`WriteThroughStore` primitives, `chat/live-state/*` (SSE replay), `agent-backend/claude-code-state/*` (turn rendering cache), lockfile.

## Implementation order

Do these in order; each is a complete, testable step.

1. **Add `analyzeSessionJsonl`** alongside the existing JSONL helpers in [`packages/agent-backend/src/claude-code/history.ts`](../packages/agent-backend/src/claude-code/history.ts). Unit-test against five fixture JSONLs (idle, mid-tool, mid-response, mid-tool-result, empty) and against the real captured `4fba8a04-…jsonl` tail to confirm it classifies the live data correctly.
2. **Switch `/api/system/agents/active`** to read from the registry + analyzer. Verify by curl against a running server.
3. **Add the threads-list overlay** (R12). Verify the dashboard tile + thread dropdown light up when a session has unanswered work.
4. **Replace `resumeActiveSessions`** with the new walk. Single test that creates a fixture session file with unanswered work, runs the sweep, asserts `backend.sendMessage` was called with the marker.
5. **Delete the v1 wiring**: per-event subscription, `setInFlight`, `flushState`, `lastResumeReport`, `active-sessions.ts`, `active-session-pointer.json` write/read, the resume-summary route. Verify build clean and existing tests still pass.
6. **Delete the v1 files at runtime** (write a one-time migration to `unlink` `active-sessions.json` and `active-session-pointer.json` if present; idempotent). Not strictly required — the new code just ignores them — but cleaner.

## Files to be touched

- [packages/agent-backend/src/claude-code/history.ts](../packages/agent-backend/src/claude-code/history.ts) — add `analyzeSessionJsonl` + tests.
- [packages/agent-backend/src/resume.ts](../packages/agent-backend/src/resume.ts) — rewrite as the simple walk; smaller than v1.
- [packages/agent-backend/src/claude-code/claude-code.ts](../packages/agent-backend/src/claude-code/claude-code.ts) — delete the internal subscription block, `markActive`/`markIdle`/`persistState`-on-status calls, the `activeSessions` dep, the `flushState` member, the `active-session-pointer.json` writer.
- [packages/agent-backend/src/active-sessions.ts](../packages/agent-backend/src/active-sessions.ts) + [active-sessions.test.ts](../packages/agent-backend/src/active-sessions.test.ts) — delete.
- [packages/agent-backend/src/wiring.ts](../packages/agent-backend/src/wiring.ts) — remove `createActiveSessions` + the dep wiring.
- [packages/agent-backend/src/index.ts](../packages/agent-backend/src/index.ts) — remove the active-sessions re-exports.
- [packages/chat/src/chat.ts](../packages/chat/src/chat.ts) — remove `ChatActiveSessionsHook` + `setInFlight` call.
- [packages/server/src/bootstrap.ts](../packages/server/src/bootstrap.ts) — pass nothing to chat module's `activeSessions`, switch the resume call to the new orchestrator, drop `lastResumeReport` + `/api/dashboard/resume-summary`, drop `claudeCodeBackend.flushState`.
- [packages/system/src/routes.ts](../packages/system/src/routes.ts) — `/api/system/agents/active` reads from registry + analyzer (drop the `activeSessions` opt).
- [packages/threads/src/routes.ts](../packages/threads/src/routes.ts) — add Claude Code liveness overlay.
- [bin/sovereign](../bin/sovereign) — no change (still calls `/api/system/agents/active`).
- `~/.openclaw/workspace/.sovereign-data/agent-backend/active-sessions.json` and `active-session-pointer.json` — delete on next boot (one-time migration).

## Resolved decisions

1. **Liveness is JSONL-derived, not in-memory.** Eliminates v1's false-idle bug.
2. **Resume covers every send path automatically.** Because we read JSONL not queue, cron/AD4M/MCP sends are handled identically to chat sends.
3. **The dashboard `agentStatus` is fixed as a side-effect.** Same JSONL analyzer powers the overlay.
4. **No tier 2 coherence check needed.** If the JSONL ends with a clean `end_turn`, the analyzer returns idle — no separate "did the turn complete after we snapshotted?" detector required.
5. **Subagent resumption is via parent's natural SDK resume.** No synthetic completion events.
6. **Continuation marker is fixed text.** `"[Resumed after server restart. Continue from where you left off.]"` — searchable in transcripts.
7. **Freshness gate: 5 minutes default.** Stat-first so stale registry entries cost nothing. Stops abandoned threads from getting re-prompted on every restart, and keeps boot fast as the thread count grows.
