# Agent Affordances Parity — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-05-24

Inventory of the OpenClaw-era runtime affordances that aren't yet provided by Sovereign, and a concrete spec for each. Most of these are **Sovereign-level affordances** (cron + prompt injection + lifecycle hooks) rather than backend-private capabilities — once landed they work identically across OpenClaw, Pi, and Claude Code threads.

This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

**Depends on:**

- The multi-backend seam from [un-openclawing-spec.md](un-openclawing-spec.md) (`RoutingBackend`, `SessionsRegistry`, `CronService`).
- The Claude Code adapter from [claude-code-adapter-spec.md](claude-code-adapter-spec.md) (specifically `CronService.createUserMessageCron`, `sovereign.sessions_send` MCP tool, `chat.compacting` event emission).

**Provenance:** The OpenClaw injection patterns referenced below are observable from the OpenClaw parser's noise-filtering rules ([packages/server/src/agent-backend/openclaw/parse-turns.ts](../packages/server/src/agent-backend/openclaw/parse-turns.ts) `isSystemInjected`). The exact injection sites and timings inside OpenClaw's runtime have not been read — descriptions of "how OpenClaw does it" are educated guesses from observed behaviour. Each requirement section MUST be verified against OpenClaw's actual behaviour before landing, particularly for any prompt-shape compatibility claims.

---

## 1. Why this exists

Cutover from OpenClaw to Claude Code (per [claude-code-adapter-spec.md](claude-code-adapter-spec.md)) replaced the chat-agent backend. It did NOT replace the **runtime affordances** OpenClaw provided on top of the agent loop:

- Periodic check-ins ("heartbeat") that wake the agent on a schedule to do proactive work.
- Auto-written daily memory entries for threads that saw activity.
- Compaction-time persistence of summaries to a memory sidecar — defends against the reseed-truncation class of context loss (P1 issue from [memory/2026-05-23.md](file:///Users/josh/.openclaw/workspace/memory/2026-05-23.md)).
- Per-session metadata (compaction count, activity timestamps, token usage) that survives process restart.

Without these, Claude Code threads run "barer" than OpenClaw threads did: they answer when prompted, but lose the proactive / memory-persistence behaviour users were getting for free.

This spec catalogues every gap, specifies the fix, and calls out the OpenClaw conventions whose **prompt-shape** matters (in case skills / prompts on disk match the old strings literally) vs. the ones that are pure noise we shouldn't reproduce.

---

## 2. Status legend

- `[x]` — implemented and verified.
- `[~]` — partial / unverified live.
- `[ ]` — not yet.

---

## 3. Real gaps with user value

### 3.1 Heartbeat

OpenClaw periodically injects `Heartbeat prompt: …` messages into a thread and accepts `HEARTBEAT_OK` as a no-op reply. Used for proactive agents: long-running monitors, periodic check-ins, polling tasks.

- [ ] `HeartbeatService` MUST exist at `packages/server/src/heartbeat/`. Listens to a per-thread heartbeat config and uses `CronService.createUserMessageCron` to schedule periodic prompts.
- [ ] The injected prompt SHOULD be:
  ```
  Heartbeat: check in if anything needs attention, otherwise reply HEARTBEAT_OK.
  ```
  Adapter parsers (OpenClaw's and the shared parser the Claude Code adapter uses) already strip `HEARTBEAT_OK` and `Heartbeat prompt:` from the rendered transcript.
- [ ] Per-thread heartbeat config MUST be optional and per-thread, configurable via:
  - REST: `POST /api/threads/:key/heartbeat { intervalMs }` / `DELETE /api/threads/:key/heartbeat`.
  - MCP tool: `sovereign.heartbeat_set` / `sovereign.heartbeat_clear` so agents can self-arm.
- [ ] Heartbeat interval MUST default to OFF. Threads opt in.
- [ ] Heartbeat firings MUST be visually distinct in the UI — render as a system chip (`💓 Heartbeat`) rather than a regular user turn, since they're not from the human.
- [ ] If the agent's reply to a heartbeat is exactly `HEARTBEAT_OK` or `NO_REPLY`, the shared parser already drops it from the rendered transcript. No new client work.
- [ ] Heartbeat config MUST persist in the registry alongside `cwd` / `orgId` / `model` so it survives Sovereign restart.

### 3.2 Daily auto-memory writes for active threads

OpenClaw injects a `Write any lasting notes to memory/…` prompt at end-of-day or session-end. The parser explicitly filters this prefix as noise, which proves the pattern.

The agent writes the file via its own `Write` tool — Sovereign doesn't write directly. This keeps the write path the same regardless of backend.

- [ ] `MemoryKeeper` module MUST exist at `packages/server/src/memory-keeper/`. Owns the daily prompt injection.
- [ ] At a configurable time-of-day (default `23:50` in the user's TZ from `process.env.TZ` or `Australia/Melbourne` as fallback) `MemoryKeeper` MUST:
  1. Enumerate threads via `routing.listSessions({ kind: 'main' | 'thread' })`.
  2. Filter to threads with `lastActivity` in the last 24h.
  3. For each, send a `sovereign.sessions_send`-equivalent message:
     ```
     Daily memory checkpoint: if anything substantive happened in this thread
     today (decisions, in-flight problems, things to resume), write a short
     entry to ~/.openclaw/workspace/memory/<YYYY-MM-DD>-<thread>.md using
     your Write tool. Otherwise reply NO_REPLY.
     ```
  4. The agent decides whether to write, and uses its own Write tool. No-op replies are dropped by the parser.
- [ ] Time-of-day MUST be overridable via `SOVEREIGN_DAILY_MEMORY_AT=23:50` env or `Config` entry.
- [ ] The memory directory root MUST be configurable via `SOVEREIGN_MEMORY_DIR`, defaulting to `~/.openclaw/workspace/memory/` (per Josh's established convention) until the workspace migration is complete.
- [ ] MUST be idempotent: if the daily memory file for `<date>-<thread>` already exists, the prompt SHOULD instruct the agent to _append_ rather than overwrite, or skip if nothing new to add.
- [ ] MUST be enableable/disableable per-org via `agent.dailyMemory: boolean` in org config. Default ON.
- [ ] MUST NOT fire for `subagent` or `event-agent` kind sessions — those are ephemeral.

### 3.3 Compaction memory file writes

Addresses the P1 from [memory/2026-05-23.md](file:///Users/josh/.openclaw/workspace/memory/2026-05-23.md): "compaction reseed message is truncated, the compacted history itself is being dropped/cut." Two distinct fixes bundle here:

#### 3.3.a Post-compaction summary persistence

- [ ] A bus listener at `packages/server/src/memory-keeper/compaction-recorder.ts` MUST subscribe to `chat.compacting { active: false }`.
- [ ] On the falling edge, the recorder MUST:
  1. Read the `compact_boundary` metadata from the session JSONL (`compact_metadata.pre_tokens`, `post_tokens`, `trigger`).
  2. Write a markdown file at `~/.openclaw/workspace/memory/compactions/<thread>-<YYYY-MM-DD-HHMMSS>.md` with:
     - Thread key + session id + boundary timestamp.
     - Pre/post token counts + trigger (`auto` | `manual`).
     - The last N (default 50) parsed turns from the session — call `backend.getHistory(sessionKey)` and tail-slice.
  3. Emit `memory.compaction.persisted` on the bus so the UI can surface a chip.
- [ ] MUST NOT block the agent — the recorder runs after the compaction completes and is purely informational.
- [ ] On cold restart, MUST NOT replay missed compactions — only persist new ones from the live event stream.

#### 3.3.b Agent-generated pre-compaction summary

When the agent is _about_ to compact, ask it to summarise what mattered, in case the SDK's automatic compaction truncates important state.

- [ ] On `chat.compacting { active: true }` for a thread, `MemoryKeeper` SHOULD send a `sovereign.sessions_send`-equivalent prompt:
  ```
  Compaction starting. Write a 3-bullet summary of the most important context
  to preserve to ~/.openclaw/workspace/memory/compactions/<thread>-pre-<YYYY-MM-DD-HHMMSS>.md
  using your Write tool. Keep it under 500 words. Then continue.
  ```
- [ ] This MUST be opt-in per thread (`agent.preCompactionSummary: boolean` in org config, default OFF) since it adds tokens to a context that's already heavy enough to trigger compaction.

---

## 4. Quick parity wins

### 4.1 Compaction count tracking

The Claude Code adapter currently hardcodes `compactionCount: 0` in `getSessionMeta` (see [claude-code.ts](../packages/server/src/agent-backend/claude-code/claude-code.ts) `getSessionMeta`).

- [ ] Adapter state MUST track `compactionCount` per session, incremented on each `PostCompact` hook invocation.
- [ ] `getSessionMeta` MUST return the live count.
- [ ] The count MUST persist in the registry so it survives Sovereign restart.

### 4.2 Activity persistence (status timestamps in sessions registry)

OpenClaw writes `working` / `idle` / `thinking` status + timestamps into its `sessions.json` so the UI's status indicator and the cron-monitor's auto-fix scan read consistent state. Claude Code adapter only emits `chat.status` WS events; the registry record doesn't carry running status.

- [ ] `SessionsRegistry` record MUST gain an `agentStatus` field + `lastStatusAt` timestamp.
- [ ] Claude Code adapter MUST update the registry on each `chat.status` emission.
- [ ] `listSessions` MUST surface these so polling clients see consistent state without a WS connection.
- [ ] The registry update MUST be debounced (50ms) — a rapid stream of `chat.status` during a burst SHOULD coalesce to one write.

### 4.3 Token usage persistence

`getSessionMeta` currently reads `state.lastUsage` which is in-memory only. Cold restart loses it until the next `result` event.

- [ ] On cold lookup (no in-memory state) `getSessionMeta` MUST fall back to `computeUsageFromFile(state.sessionFile)` — the function already exists in [history.ts](../packages/server/src/agent-backend/claude-code/history.ts).
- [ ] On hot lookup the in-memory `state.lastUsage` MUST still be preferred (it has the most recent turn).

### 4.4 Voice directive passthrough verification

The shared parser already strips `[[reply_to_current]]`, `[[reply_to:X]]`, `[[audio_as_voice]]` via `stripDirectives` (see [parse-turns.ts](../packages/server/src/agent-backend/shared/parse-turns.ts)). But these directives are protocol-level — they're meant to be _honored_ somewhere, not just stripped.

- [ ] Voice module MUST be exercised end-to-end through a Claude Code thread to confirm the directives still flow through and have their intended effect.
- [ ] If the voice module reads directives from rendered transcript only, it will miss them (parser strips before render). The voice module SHOULD read directives from `chat.turn` events _before_ the parser passes them through, or from a separate non-stripped channel.
- [ ] Behaviour MUST be specified per directive:
  - `[[reply_to_current]]` — reply to the originating channel without `audio_as_voice`.
  - `[[reply_to:<channel>]]` — reply to a specific named channel.
  - `[[audio_as_voice]]` — render the reply through TTS rather than text.

### 4.5 Subagent transcript persistence across restart

Claude Code's `Task` tool spawns subagents within a session. Sovereign tracks them via `SessionsRegistry` (`kind: 'subagent'` records), so the registry survives restart. But the `Task` tool's runtime state — what the subagent was actually doing — only lives in the in-process SDK. On Sovereign restart, in-flight subagents are abandoned mid-task.

- [ ] On Sovereign restart, `MemoryKeeper` SHOULD scan `SessionsRegistry` for `kind: 'subagent'` records with `agentStatus: 'working'` older than 5 minutes and mark them `status: 'abandoned'` so the UI surfaces them honestly rather than as live.
- [ ] No mechanism to auto-resume — that's a Claude Code SDK limitation. The marker is sufficient.

---

## 5. OpenClaw prompt-shape conventions worth verifying

These OpenClaw-injected patterns are filtered as noise by the parser. They're called out here because **if any skills / agent definitions / org prompts on disk literally match these strings**, swapping backends silently loses behaviour. We MUST grep before assuming compatibility.

- [ ] `[CronResult]` / `[Scheduled: …]` envelopes on cron-delivered messages. We use `[Cron: <label>]` instead (see [scheduler/cron-service.ts](../packages/server/src/scheduler/cron-service.ts) `formatCronPrompt`). MUST grep `~/.openclaw/workspace/`, `~/.claude/skills/`, agent definitions, and `_global` org config for `\[CronResult\]` / `\[Scheduled:` literals before declaring parity. If matches are found, either rename matches OR change `formatCronPrompt` to use both forms.
- [ ] `Sender (untrusted metadata): { json }` headers on multi-channel messages (telegram, discord). We don't inject any equivalent. If any agent prompt depends on knowing message provenance from inside a thread, this is a real gap and a sovereign-channels routing layer needs to inject the envelope (or an equivalent).
- [ ] `[Subagent Task]` / `[Subagent Context]` envelopes from OpenClaw's subagent lifecycle. Our subagents (Task tool) emit `subagent.spawned` / `subagent.completed` bus events instead. UI is fine; agent-side, if a prompt grep matches the literal string we need to inject equivalent text into the parent thread's turn stream.
- [ ] `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` wrappers — pure noise, MUST NOT reproduce.
- [ ] `OpenClaw runtime context (internal): … [Internal task completion event]` — OpenClaw's task-completion synthetic. Equivalent now is the `subagent.completed` bus event. If a skill prompt looks for the literal string, that's a parity gap.

---

## 6. Intentional non-goals

These are OpenClaw-era affordances we MUST NOT reproduce, with reasoning:

- **Device pairing / ed25519 handshake.** OpenClaw's was for the remote-gateway model. Claude Code runs in-process; `deviceIdentity: false` is correct.
- **`sessions_yield` subagent model.** Claude Code's `Task` tool is the equivalent and works. Reproducing the `sessions_yield` envelope would be a regression toward a less clean abstraction.
- **OpenClaw cron auto-fix patches** (`needsAutoFix` / `buildFixPatch` for `announce` / `webchat` delivery bugs). Sovereign-native cron uses a clean delivery model that doesn't produce those broken jobs in the first place.
- **Custom message envelopes for noise-shape reasons** (`<<<BEGIN_OPENCLAW…`, etc.). Pure protocol artefacts; Claude Code doesn't need them and we shouldn't introduce them.
- **OpenClaw's gateway-restart RPC.** N/A — no daemon to restart for Claude Code.

---

## 7. Recommended implementation order

1. **§3.3 Compaction memory writes** — directly addresses yesterday's open P1 and is the smallest. Two listeners (one for `chat.compacting:false` doing post-summary, one for `chat.compacting:true` doing pre-summary opt-in). One PR.
2. **§3.1 + §3.2 Heartbeat + Daily memory** — bundle into one new `packages/server/src/memory-keeper/` + `packages/server/src/heartbeat/` module. Both are cron + prompt-injection over the existing `CronService` + `sovereign.sessions_send` paths. Roughly one PR each, but they share infrastructure (per-thread schedule config, per-org enable flag).
3. **§4.1–§4.3 Quick parity wins** — registry-shape additions + adapter wiring. One small PR. Mostly mechanical.
4. **§5 verify-list** — `git grep` exercise across the workspace + skills + org configs. Half a day if grep finds nothing; longer if it finds real dependents.
5. **§4.4 Voice directive verification** — needs a live voice thread driven through Claude Code to confirm.
6. **§4.5 Subagent abandonment marker** — small registry sweep on boot.

---

## 8. Acceptance smoke tests

Once §3 + §4.1–4.3 land, the following MUST pass end-to-end:

- [ ] Create a thread, enable heartbeat at 60s interval. Wait 90s. The thread receives a `Heartbeat: …` system chip. Agent replies `HEARTBEAT_OK` and the reply is dropped from the rendered transcript.
- [ ] Send messages to two threads, wait for daily memory time, verify `~/.openclaw/workspace/memory/<YYYY-MM-DD>-<thread1>.md` and `…<thread2>.md` exist with agent-written content.
- [ ] Trigger a compaction on a Claude Code thread (e.g., long-running session that auto-compacts). Verify `~/.openclaw/workspace/memory/compactions/<thread>-<ts>.md` is written with `compact_metadata` + recent-turn tail.
- [ ] Send a message that should trigger compaction with `agent.preCompactionSummary: true`. Verify a `<thread>-pre-<ts>.md` exists in the same dir with agent-summarised content.
- [ ] After a compaction, `getSessionMeta(sessionKey).compactionCount === 1`. After two, `=== 2`.
- [ ] Restart Sovereign. `getSessionMeta` for the compacted thread STILL returns `compactionCount === 2` (persisted in registry).
- [ ] Restart Sovereign. `getSessionMeta` for a thread that had used tokens still returns non-zero `inputTokens` / `outputTokens` derived from the on-disk JSONL via `computeUsageFromFile`.
- [ ] `routing.listSessions()` returns `agentStatus: 'idle' | 'working' | 'thinking'` for each session, reflecting the most recent `chat.status` emission, without requiring a WS connection.
- [ ] `git grep` of `~/.openclaw/workspace/` + `~/.claude/skills/` + `~/.openclaw/agents/` for the §5 OpenClaw prompt-shape literals returns no matches that any agent currently relies on (or, if it does, those skills are migrated to the new shapes).

---

## 9. Open questions

1. **Where do `MemoryKeeper` + `HeartbeatService` live in the module DAG?** Both depend on `RoutingBackend` + `CronService` + a way to enumerate threads. Likely peers of `notifications/` and `meetings/` under `packages/server/src/`. No external dependencies.
2. **Should heartbeat / daily-memory schedules be visible in the UI cron list?** Pro: discoverable, debuggable. Con: clutter (every thread with heartbeat enabled adds a job). Recommend tagging them (`Job.tags: ['heartbeat'|'daily-memory']`) and filtering them out of the default cron list view, with a toggle to show.
3. **What happens to in-flight heartbeats when a thread is archived?** SHOULD auto-cancel — the listener that handles thread-archived events SHOULD clean up associated heartbeat crons. Same for daily-memory exclusion.
4. **TZ handling for daily memory.** OpenClaw runs in the user's local TZ (Melbourne for Josh). Should be config-driven, not hardcoded — `SOVEREIGN_DAILY_MEMORY_AT` accepts `HH:MM` in `process.env.TZ` or a `<HH:MM> <IANA>` form.
5. **Compaction recorder + memory write race.** If the agent is mid-Write when the SDK starts compacting, the Write may complete after the boundary. Recorder MUST tolerate the file being written by the agent OR by itself — write to a `compactions/agent/` vs `compactions/system/` subdirectory to avoid collision.
