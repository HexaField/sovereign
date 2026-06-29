# Presence Thread — Design Plan

## Goal

Introduce a **two-thread presence system**: a persistent pair of threads that together serve as the single touchpoint for all non-specific inbound messages — STT transcriptions, AD4M mentions, future gateways — plus a clean user-facing chat surface, with long-term continuity, dedicated memory, and modality-aware response routing.

When Josh speaks to Sovereign via STT, the internal agent replies via TTS _to that tab_. When an AD4M mention arrives, the internal agent replies _in that AD4M context_. When Josh types in the gateway thread, that thread's own agent handles the conversation and can forward to / coordinate with the internal agent. Each of the two threads is always the same long-lived session — never spinning up new sessions per interaction.

### The two threads

- **`presence-internal`** — the agent's stream-of-consciousness. Where Hex thinks, observes, manages watched threads, and decides whether/how to reach out externally. Inbound voice / AD4M / future ambient gateways land here. Its assistant turns are NOT auto-pushed anywhere (R4). It carries PRESENCE.md + PRESENCE_MEMORY.md. The user _can_ read or write here directly, but it's not the normal way to chat.
- **`presence`** — the user's primary text gateway to Hex. A normal Claude Code thread with its own SDK session and JSONL. This is where the user has typed conversations with Hex when no other thread is contextually relevant. Has tools to forward text into the internal thread and to read internal's recent state.

The two threads are paired but independent. Each has its own session, history, and context window. They communicate via explicit tool calls — not via auto-piping.

## Non-Goals

- Replacing existing named threads (they stay as they are)
- Auto-routing _everything_ through the presence pair (only un-targeted messages)
- Making the presence threads "god threads" that know about all other threads (they're the default landing pads, nothing more)
- Tightly coupling internal ↔ gateway — they cooperate via tools, not by sharing context

---

## Architecture

### 1. Thread Identity

Two `ThreadInfo` entries in `threads.json`, each flagged by a string role:

```typescript
// In packages/core/src/thread.ts — extend ThreadInfo
export interface ThreadInfo {
  // ... existing fields ...
  /** Role this thread plays in the presence system. `'internal'` is the
   *  agent's stream-of-consciousness; `'gateway'` is the user's text-chat
   *  surface. At most one thread may carry each role. */
  presence?: 'internal' | 'gateway'
}
```

**Why a role, not hard-coded IDs?** Both threads are regular threads that can be renamed, have their membrane changed, etc. The role is the stable reference. `ThreadManager` exposes `getPresenceThread(role)` returning the single thread of that role, or `null`.

**Bootstrap**: On startup, the bootstrap layer ensures both threads exist. Missing internal → auto-create with label `"presence-internal"`, membrane `"personal"`, role `'internal'`. Missing gateway → auto-create with label `"presence"`, membrane `"personal"`, role `'gateway'`.

**Migration**: legacy threads carrying `presence: true` (boolean) are auto-promoted to `presence: 'internal'` on load — they keep their id and history.

### 2. Modality Metadata on Messages

Each inbound message carries its **origin modality** so the response can be routed back:

```typescript
// In packages/core/src — new type or extend existing
export interface MessageOrigin {
  /** How the message arrived. */
  modality: 'text' | 'voice' | 'ad4m' | 'cron' | 'webhook'
  /** Originating device/tab for targeted response delivery. */
  deviceId?: string
  /** AD4M-specific: perspective UUID + parent channel for reply routing. */
  ad4m?: {
    perspectiveUuid: string
    channelAddress: string
    messageAddress: string
  }
  /** Webhook-specific: source identifier. */
  webhookSource?: string
}
```

This gets threaded through the chat module's `handleSend` / `SendOptions`, persisted alongside the queued message so the response handler knows how to deliver.

### 3. Response Tools (Tool-Call Delivery, Not Automatic Routing)

**The internal thread is internal.** Its normal assistant turns are stream-of-consciousness — they appear in the internal thread UI for the user to read if curious, but are NEVER auto-delivered to any external surface. The agent reaches out only when it explicitly chooses to, by invoking a response tool.

This makes the internal thread categorically different from other threads:

- Other threads (including the **gateway**): each user message has a paired assistant response — a query/response loop.
- Internal thread: a continuous internal monologue. Inbound events (voice, AD4M mention, forwarded user text from gateway, watched-thread digests) arrive as context, the agent thinks about them, and _optionally_ reaches out via tool calls. Silence is a valid outcome.

#### Tools Exposed to the Internal Agent

Each modality gets a dedicated MCP tool. The tool itself performs the delivery — there is no event-driven dispatcher subscribing to `chat.turn.completed`. These tools are only available when the calling session is the internal session.

```typescript
presence_reply_voice(text: string, opts?: { deviceId?: string }): { delivered: boolean; deviceId: string }
// Synthesizes TTS and delivers audio to the last voice-origin deviceId (or explicit override).
// Stubbed until vui-voice-backend-spec.md lands — falls back to text broadcast on the
// originating deviceId's chat channel.

presence_reply_ad4m(text: string, opts?: { perspectiveUuid?: string; channelAddress?: string }): { messageAddress: string }
// Posts a reply into the AD4M channel from the most recent ad4m-origin message
// (or explicit overrides). Uses AD4M MCP tools (add_child with channel as parent).

presence_reply_text(text: string, opts?: { threadId?: string }): void
// Posts a regular chat message — defaults to the GATEWAY thread (so the user sees
// the reply in their normal chat surface), or to another thread id if the agent
// wants to broadcast somewhere else.

presence_reply_webhook(text: string, opts: { source: string }): void
// Future: posts back through a webhook source. Stubbed.
```

#### Tools Exposed to the Gateway Agent

The gateway agent has its own SDK session and runs as a normal chat thread. It gets a small set of tools for coordinating with the internal agent:

```typescript
presence_internal_send(text: string, opts?: { deviceId?: string }): { delivered: boolean }
// Forward text into the internal thread as a `text`-modality inbound. The internal
// agent will see it as a `[presence:inbound modality=text …]` envelope and can
// choose to think about it / call its response tools / reply via presence_reply_text.

presence_internal_history(limit?: number): { turns: Array<{ role; content }> }
// Peek at the internal thread's recent turns — useful for the gateway agent to
// summarise Hex's recent ambient activity for the user.
```

The gateway never gets the `presence_reply_*` tools — only internal can use those (they target ambient surfaces where the gateway agent isn't the right speaker).

#### Origin Context Available to the Agent

Inbound messages are rendered into the agent's context as system-style envelopes that carry the `MessageOrigin` fields so the agent can choose the right reply tool _and_ answer "who/where am I replying to?":

```
[presence:inbound modality=voice deviceId=device-abc-123 at=2026-06-30T14:55:01Z]
"Hey, how's the build going?"
```

```
[presence:inbound modality=ad4m perspectiveUuid=… channelAddress=… messageAddress=… at=…]
"@hex did you see the governance draft?"
```

The tool defaults (`presence_reply_voice` with no opts) target the most recent origin matching that modality, so the common case is `presence_reply_voice("Build's green.")` — no bookkeeping required. The explicit `opts` overrides exist for cases like "answer the voice message that came in 30 seconds ago, not the one just now".

#### Why Tool-Call Delivery, Not Auto-Routing

- **Agency**: the agent decides whether and when to respond — voice messages don't force a reply, and the agent can defer ("let me check that watched thread first") or stay silent.
- **Multiple actions per turn**: one inbound message can spawn a voice reply _and_ an AD4M post _and_ a memory write, in whatever order makes sense.
- **No coupling between turn completion and delivery**: the agent can think for several turns of tool calls before deciding to reach out — or never reach out at all.
- **Explicit channel choice**: the agent picks the modality; the system never guesses based on a "last origin" stack that may not be what the agent actually wants.

#### Delivery Mechanics

Each tool's implementation lives in the presence package's MCP-server contribution and dispatches directly:

- `presence_reply_voice` → calls `voiceModule.synthesize(text)` → sends audio via WS binary frame on the `voice-tts` channel to the target `deviceId`. Until the voice backend exists, this falls back to a normal chat message tagged `[voice-stub]` delivered to the target `deviceId`'s chat channel.
- `presence_reply_ad4m` → uses `add_child` on the AD4M MCP server, parented at the channel address.
- `presence_reply_text` → emits a normal `chat.turn` on the target thread, broadcast via WS the same way any chat message would be.

The tools return structured results (delivered, message address, etc.) so the agent can chain reasoning on success/failure.

### 4. PRESENCE.md — Personality Layer

A new personality source file `~/.sovereign/PRESENCE.md` that defines _how the agent behaves in presence mode_. Unlike IDENTITY.md/SOUL.md (which define who the agent is globally), PRESENCE.md defines:

- Conversational tone for ambient interactions (more casual, voice-friendly)
- Instructions for modality-aware responses ("if you received this via voice, keep responses short and spoken-word friendly")
- Memory interaction patterns ("proactively reference and update your presence memory")

**Injection**: PRESENCE.md is NOT compiled into the global `~/.claude/CLAUDE.md`. Instead, it's injected as an additional `systemPrompt.append` layer specifically for the presence thread's session. The mechanism already exists: `makeMembraneAppendResolver` resolves per-session context. We extend this with a presence-specific layer.

```
Session prompt layers for presence thread:
  1. SDK preset (claude_code)
  2. Global personality (~/.claude/CLAUDE.md)
  3. Membrane context (CONTEXT.md for the thread's membrane)
  4. Presence personality (PRESENCE.md) ← NEW, only for presence thread
  5. Presence memory (PRESENCE_MEMORY.md) ← NEW, only for presence thread
```

The resolver chain in `wiring.ts` becomes:

```typescript
function makePresenceAppendResolver(membraneManager, threadManager, presenceMemoryPath, presencePersonalityPath) {
  const base = makeMembraneAppendResolver(membraneManager, threadManager)
  return (sessionKey) => {
    const parts = [base?.(sessionKey)]
    const thread = threadManager.get(sessionKeyToThreadKey(sessionKey))
    if (thread?.presence) {
      // Inject presence personality
      parts.push(readFileOrEmpty(presencePersonalityPath))
      // Inject presence memory (continuously updated)
      parts.push(readFileOrEmpty(presenceMemoryPath))
    }
    return parts.filter(Boolean).join('\n\n') || undefined
  }
}
```

### 5. Presence Memory — Continuous Context

A dedicated memory file at `~/.sovereign/PRESENCE_MEMORY.md` (or `~/.sovereign/data/presence-memory.md` if we want it gitignored).

**Key differences from global MEMORY.md:**

- **Proactively updated**: The agent is instructed (via PRESENCE.md) to append observations, conversation summaries, and contextual notes after each interaction
- **More granular**: Records things like "Josh mentioned he's tired today", "Last voice interaction was about the AD4M governance thread", "Josh asked about weather before heading out"
- **Shorter retention**: Entries are date-stamped and the agent is encouraged to prune old entries
- **Not global**: Only injected into the presence thread session, not all threads

The agent writes to this file using standard `Write` tool calls during its session. The file is re-read on each session start (or on resume, since the personality is loaded at session init).

**Injection mechanism**: Read at session start and appended to the system prompt (same as PRESENCE.md). Since the presence thread is long-lived and resumed, this means the memory is "frozen" at session start — but Claude Code sessions compact and restart naturally, at which point the latest memory is re-loaded.

### 6. Thread Watch List & Silent Digest

The presence thread needs situational awareness of activity across other threads — but not at the cost of waking for every turn or scanning everything on each interaction.

**Approach: Agent-driven opt-in with silent accumulation.**

#### Watch List (MCP Tools)

Two new MCP tools available to the presence agent:

```typescript
// Agent calls these during its session to manage what it tracks
presence_watch(threadId: string, reason?: string): void
presence_unwatch(threadId: string): void
presence_watched(): Array<{ threadId: string; label: string; reason?: string }>
```

PRESENCE.md instructs the agent to actively manage its watch list based on conversational context — if Josh mentions a project, watch its thread; if a thread goes quiet for days, unwatch it. The watch list persists to disk (`<dataDir>/presence-watched.json`) and survives restarts.

#### Digest Buffer (Server-Side)

A `PresenceDigest` service that:

1. Subscribes to `chat.turn.completed` on the EventBus
2. Filters to only watched thread IDs
3. Extracts a one-line summary (first sentence of the assistant's last response, truncated to ~120 chars)
4. Appends to an in-memory buffer (capped at N entries, persisted to disk for restart survival)

No agent wake, no token cost — summaries accumulate silently.

#### Digest Delivery

When the presence thread activates (voice, mention, text — any inbound message), the chat module prepends the accumulated digest to the user's message:

```
[Thread activity since last interaction]
- adam (3min ago): Completed review of governance proposal draft
- living-web (18min ago): Drafted mesh network architecture section
[End thread activity]

<actual user message>
```

After delivery, the buffer clears. The agent can dive deeper on anything interesting via the existing `sessions_history` MCP tool.

#### Why This Works

- **Zero cost when idle** — summaries accumulate without waking the agent
- **Agent-controlled** — opt-in via tool calls, not static configuration
- **Shallow by default, deep on demand** — one-liners for scanning, `sessions_history` for detail
- **Dynamic** — watch list shifts as context shifts, no stale subscriptions
- **Natural delivery** — activity context arrives alongside the actual interaction, not as interruptions

#### Summary Quality

Start with simple first-sentence extraction from the last assistant turn (essentially free). Future refinement: each thread's agent could emit a structured `turn_summary` field on completion for higher-quality digests.

### 7. Gateway Routing Changes

#### STT/TTS (Voice)

**Current flow**: VoiceView.tsx → `stopRecording()` → `transcribeAudio()` → `sendMessage(text)` → sends to whatever thread is currently selected in the UI.

**New flow**: When voice input arrives and _no specific thread is focused_ (or the user is on the dashboard/voice page), route to the presence thread instead.

Changes:

- `VoiceView.tsx` / `VoiceWidget.tsx`: Check if a specific thread is focused. If not, send to presence thread ID.
- `sendMessage()` in chat store needs to accept an explicit `threadId` override (currently uses `currentThreadKey()`).
- The voice send includes `origin: { modality: 'voice', deviceId }` so the server can route TTS back.

**Stubbed for now.** The voice modality tag and routing plumbing are wired in this spec, but actual STT transcription and TTS synthesis are deferred to [`vui-voice-backend-spec.md`](vui-voice-backend-spec.md), which covers provider selection, streaming synthesis, wake-word detection, and the full voice pipeline. The response router's `voice` branch will be a no-op (falls back to text broadcast) until that spec lands.

#### AD4M Mentions

**Current flow**: `waker.ts` emits `ad4m.thread.message` → `bootstrap.ts` resolves/creates a thread per perspective → injects message via `routingBackend.sendMessage()`.

**New flow**: AD4M mentions route to the **presence thread** instead of per-perspective threads (unless explicitly configured otherwise). The origin metadata includes the AD4M perspective + channel info.

Changes:

- `bootstrap.ts` AD4M handler: resolve presence thread instead of creating per-perspective threads
- Include `MessageOrigin` with AD4M context in the injected message
- Response router picks up the AD4M origin and replies in-context

#### Future Gateways

Any new gateway (email, SMS, Matrix, etc.) follows the same pattern:

1. Arrive via bus event
2. Route to presence thread with appropriate `MessageOrigin`
3. Response router handles delivery back through the originating channel

---

## Requirements

The whole spec ships in one pass — no phased rollout. Requirements are grouped by concern; every item in every group must be in place before the feature is considered done.

### R1. Thread Identity

- `ThreadInfo` carries a `presence?: 'internal' | 'gateway'` field. At most one thread per role; manager enforces on `create` / `update`.
- `ThreadManager` exposes `getPresenceThread(role: 'internal' | 'gateway'): ThreadInfo | null`.
- Loader migrates legacy `presence: true` (boolean) → `presence: 'internal'` so the existing presence thread is preserved as the internal thread.
- On startup, bootstrap ensures both threads exist. Missing internal → auto-created with label `"presence-internal"`, membrane `"personal"`, role `'internal'`. Missing gateway → auto-created with label `"presence"`, membrane `"personal"`, role `'gateway'`.
- Both are otherwise normal threads — renameable, deletable (which clears the role), visible in the thread list.

### R2. Message Origin Metadata

- A `MessageOrigin` type (modality + modality-specific identifiers — `deviceId`, AD4M perspective/channel/message, webhook source) is defined in `@sovereign/core` and re-exported through the public surface.
- `SendOptions` accepts `origin?: MessageOrigin`. The chat module's queue persists the origin alongside each queued message so a restart preserves it.
- Inbound system envelopes for the presence thread render the origin as a structured `[presence:inbound modality=… deviceId=… …]` header so the agent can read it.

### R3. Presence Personality & Memory Layering

- `~/.sovereign/PRESENCE.md` exists as a human-authored personality file (analogous to SOUL.md). It is NOT compiled into the global `~/.claude/CLAUDE.md`.
- `~/.sovereign/PRESENCE_MEMORY.md` exists as an agent-maintained memory file, writable by the internal agent via `Write`. Location is tracked, not gitignored — Josh can read/prune it.
- The session-prompt-append resolver, when the session belongs to the **internal** thread, appends PRESENCE.md and PRESENCE_MEMORY.md after the membrane CONTEXT.md. The gateway session does NOT get these — it's a normal text agent.
- Personality/memory paths are passed through `ClaudeCodeBackendDeps` so the resolver can find them. No global compilation step.

### R4. Internal-Only Conversation Model

- The internal thread's normal assistant turns are stream-of-consciousness — they are persisted to the JSONL and shown in the thread UI, but no automatic delivery happens to any external surface on turn completion.
- There is NO `PresenceResponseRouter` subscribing to `chat.turn.completed` for the internal thread. External delivery happens only via the response tools below.
- The push orchestrator (`@sovereign/thread-presence`) skips the internal thread so its turns don't bug-buzz the user. The gateway thread, by contrast, receives normal push (it's a regular user-facing chat surface).
- Silence is a valid response — the agent may choose not to reply at all to an inbound event.

### R5. Response Tools (MCP)

Implemented in the presence package and registered into the Sovereign MCP server. Each tool dispatches its own delivery; no shared dispatcher. Internal-only tools refuse to run from any other session; gateway-only tools likewise.

Internal-session tools:

- `presence_reply_voice(text, opts?)` — synthesises TTS, delivers to the target `deviceId` (defaults to the most recent voice-origin device). Until the voice backend ships, falls back to a chat message tagged `[voice-stub]` on the target device's chat channel. Returns `{ delivered, deviceId }`.
- `presence_reply_ad4m(text, opts?)` — posts a reply via AD4M MCP (`add_child` parented at `channelAddress`), defaulting to the most recent ad4m-origin perspective/channel. Returns `{ messageAddress }`.
- `presence_reply_text(text, opts?)` — emits a normal chat turn; defaults to the **gateway** thread (so the user sees the reply in their normal chat surface), accepts a `threadId` override to post into another thread.
- `presence_reply_webhook(text, { source })` — stub. Returns `{ delivered: false, reason: 'not-implemented' }` for now; surface exists so PRESENCE.md can reference it.

Gateway-session tools:

- `presence_internal_send(text, opts?)` — forward text into the internal thread as a `text`-modality inbound. Returns `{ delivered }`.
- `presence_internal_history(limit?)` — peek at the internal thread's recent turns. Returns `{ turns }`.

Tools resolve their default targets from a small in-memory "last origin per modality" map maintained by the presence module — populated whenever an inbound message lands on the internal thread.

### R6. Watch List & Silent Digest

- `presence_watch(threadId, reason?)`, `presence_unwatch(threadId)`, `presence_watched()` MCP tools available only on the **internal** session.
- Watch list persists to `<dataDir>/presence-watched.json` and survives restarts.
- A `PresenceDigest` service subscribes to `chat.turn.completed` on the bus, filters to watched thread ids, extracts a one-line summary (first sentence of the assistant's response, truncated to ~120 chars), and appends to an in-memory buffer capped at N entries (persisted for restart survival).
- When the **internal** thread receives an inbound message, the chat module prepends the accumulated digest above the user/system envelope, then clears the buffer. The gateway thread is a normal thread; no digest prepending happens there.
- The digest never wakes the agent on its own — accumulation is purely passive.

### R7. Gateway Routing — Inbound

- Voice client surfaces (`VoiceView`, `VoiceWidget`) route to the **internal** thread when no specific thread is focused (ambient voice = ambient agent). When the user is focused on the gateway thread, voice goes to the gateway like any other thread. Voice sends include `origin: { modality: 'voice', deviceId }`.
- The chat store's `sendMessage()` accepts an explicit `threadId` override so voice/AD4M paths can target the internal thread regardless of UI selection.
- AD4M mention handler in bootstrap routes to the **internal** thread (not per-perspective threads) and includes `origin: { modality: 'ad4m', ad4m: { perspectiveUuid, channelAddress, messageAddress } }`.
- The AD4M waker emits the full perspective/channel/message context so the origin can be constructed verbatim.
- The **gateway** thread receives no special inbound routing — it's a normal chat surface that the user types into directly. Its agent forwards anything noteworthy to internal via `presence_internal_send`.

### R8. Packaging

- A new `packages/presence/` workspace package owns:
  - `digest.ts` (passive bus subscription + buffer)
  - `watch-store.ts` (watch list persistence)
  - `response-tools.ts` (the four `presence_reply_*` MCP tool implementations)
  - `last-origin.ts` (in-memory per-modality last-origin map)
- The package is wired into `packages/server/src/bootstrap.ts` alongside other modules; its MCP tools are registered into the Sovereign MCP server contribution.

### R9. Tests

- `ThreadManager.getPresenceThread()` returns the flagged thread; at-most-one is enforced on both `create` and `update`.
- Chat module: `SendOptions.origin` is persisted on the queue and survives a restart round-trip.
- Digest service: accumulation, prepend-on-activation, clear-after-read, buffer-cap eviction, restart persistence.
- Watch store: add/remove/list, persistence round-trip, MCP tool round-trip.
- Response tools: each tool dispatches through the correct channel; defaults pull from the last-origin map; explicit `opts` overrides win.
- Wiring: presence personality + memory append happens only when the resolver is called for the presence thread session — never for other threads.
- E2E: voice inbound → presence thread receives system envelope → agent calls `presence_reply_voice` → audio (stub for now) lands on originating `deviceId`'s WS channel.

---

## Constraints & Assumptions

- **Single presence thread** per Sovereign instance. Not per-membrane.
- **PRESENCE.md is human-authored** (like SOUL.md). The agent reads it, doesn't write it.
- **PRESENCE_MEMORY.md is agent-maintained**. The agent writes observations. Josh can edit/prune.
- **The presence thread uses the `personal` membrane** by default (private context).
- **Session continuity**: The presence thread's Claude Code session is long-lived (resumed on server restart like any thread). Memory is injected at session start, so a `/compact` or context overflow will re-load latest memory.
- **No special UI** needed initially — the presence thread appears in the thread list like any other. The voice widget on the dashboard routes to it. The ⬡ button could be enhanced later to indicate "presence active".

## Open Questions

1. **AD4M reply format**: Should the agent's AD4M reply include any special formatting (e.g., quoting the original message)?
2. **Presence memory location**: `~/.sovereign/PRESENCE_MEMORY.md` (tracked, visible) or `~/.sovereign/data/presence-memory.md` (gitignored, ephemeral)?
3. **Voice-tab targeting**: The `deviceId` on WS connections — is this stable enough to target TTS back to a specific tab reliably? (Checked: yes, it persists for the WS connection lifetime.)
4. **Multiple voice tabs**: If Josh has the dashboard open on multiple devices, should TTS go to all of them or just the originating one? Originating only is simpler and more correct.
