# Phase 6: Chat & Voice — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-13

This document specifies the Chat & Voice modules of Phase 6. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 6 depends on Phase 3 (WebSocket protocol, config) and uses the thread/notification infrastructure from Phase 1. This phase ports the entire voice-ui chat interface into Sovereign, preserving all functionality and visual styling. The UI connects to OpenClaw gateway as the agent backend (replaced by Sovereign's own agent core in Phase 8).

---

## Design Philosophy

**Port, don't rewrite.** The voice-ui chat interface is production-tested and well-understood. Phase 6 ports its components into Sovereign's client package with the same visual design, interactions, and behaviour. The codebase is adapted to Sovereign's architecture (event bus, WS protocol, config module) but the UX MUST remain identical.

**Entity-bound threads.** Every thread is associated with a git entity (branch, issue, PR/patch). Events from that entity route into the thread automatically. The 'main' thread and user-created bespoke threads are global (no entity binding).

**Styling continuity.** The voice-ui's CSS custom properties (theme tokens), Tailwind configuration, font stack, dark/light/ironman/jarvis themes, animations, and markdown rendering styles MUST be preserved exactly. Users MUST NOT perceive a visual difference between voice-ui and Sovereign's chat interface.

---

## Wave Strategy

**Wave 1 (parallel):** Theme & Styles, Gateway Bridge, App Store **Wave 2 (after wave 1):** Chat Interface, Input Area **Wave 3 (after wave 2):** Thread System, Message Forwarding **Wave 4 (after wave 3):** Voice Interface, Dashboard **Wave 5:** Integration tests

---

## 1. Theme & Styles

Port the voice-ui's complete visual system into Sovereign's client package.

### Requirements

- The client MUST include the complete CSS custom property system from voice-ui's `app.css`: all `--c-*` tokens for backgrounds, borders, text, accents, code, scrollbars, overlays, bubbles, etc.
- The client MUST support all four themes: `default` (dark), `light`, `ironman` (blue HUD), `jarvis` (orange HUD).
- Theme switching MUST be applied via a CSS class on the root element (`:root` for default, `.light`, `.ironman`, `.jarvis`).
- The Orbitron font MUST be included for HUD themes (`ironman`, `jarvis`) — loaded from `/fonts/orbitron.woff2`.
- All custom animations MUST be ported: `mic-pulse`, `voice-pulse`, `speak-pulse`, `pulse-dots`, `march` (marching ants), `warning-pulse`.
- All utility classes MUST be ported: `.animate-mic-pulse`, `.animate-voice-pulse`, `.animate-speak-pulse`, `.tap-highlight-none`, `.safe-top`, `.safe-bottom`, `.tabular-nums`, `.antialiased`, `.rounded-b-2xl`, `.streaming-dots`.
- Scrollbar styling MUST use the theme tokens (`--c-scrollbar-thumb`, `--c-scrollbar-hover`).
- The markdown rendering styles (`.msg-assistant` rules) MUST be ported exactly: headings, lists, code (inline + block), blockquotes, tables, links, horizontal rules, strong, em.
- Code copy buttons (`.code-copy-btn`, `.inline-code-copy`, `.inline-code-wrap`) and message copy buttons (`.msg-copy-btn`) MUST be styled identically.
- File chip styles (`.file-chip`) MUST be ported.
- Recording button styles (`.rec-btn`, `.rec-btn-accent`, `.rec-btn-default`) MUST be ported.
- Work section styles (`.c-step-bg`, `.c-step-badge-bg`, `.c-work-body-bg`, `.c-work-border`) MUST be ported.
- The client MUST persist the selected theme in `localStorage` and restore it on load.
- The client SHOULD support `prefers-color-scheme` media query for auto dark/light detection when no theme is explicitly selected.

### Files

```
packages/client/src/
├── app.css              # Complete theme tokens + utility classes + markdown styles (port from voice-ui)
├── fonts/               # Orbitron woff2
```

---

## 2. Gateway Bridge

WebSocket connection to the OpenClaw gateway for agent communication. This is the message transport layer — all chat messages flow through it.

### Requirements

#### 2.1 Connection Management

- The bridge MUST establish a WebSocket connection to the OpenClaw gateway at a configurable URL.
- The bridge MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- The bridge MUST track connection state: `connecting`, `authenticating`, `connected`, `disconnected`, `error`.
- The bridge MUST expose connection state as a reactive signal (SolidJS signal).
- The bridge MUST emit a human-readable status text string alongside the connection state.

#### 2.2 Authentication

- The bridge MUST support Ed25519 device identity authentication:
  - Generate a keypair on first use, store in `localStorage`.
  - Sign authentication payloads with the device private key.
  - Send device token on connection.
- The bridge MUST support the gateway's device pairing flow: if the device is not yet approved, display a pairing UI showing the device ID and requesting user approval via the gateway.
- The bridge MUST store and restore the device token from `localStorage`.
- The bridge MUST support a gateway token modal for manual token entry (fallback auth).

#### 2.3 Message Protocol

- The bridge MUST support the OpenClaw gateway WebSocket protocol:
  - Send: `chat` messages (user input), `abort` (cancel generation), `history` (request conversation history), `session.switch` (change thread), `session.create` (new thread).
  - Receive: `chat.stream` (streaming tokens), `chat.turn` (complete turn), `chat.status` (agent status changes), `chat.work` (tool calls, thinking blocks), `chat.compacting`, `chat.error`, `session.info`, `session.history`.
- The bridge MUST parse streaming chat events and update reactive stores:
  - `streamingHtml` — accumulated HTML from streaming tokens (with thinking block stripping).
  - `agentStatus` — current agent status (`idle`, `working`, `thinking`).
  - `liveWork` — array of work items (tool calls, results, thinking blocks) for the current turn.
  - `liveThinkingText` — raw thinking text from the current turn.
  - `compacting` — boolean indicating context compaction in progress.
- The bridge MUST strip thinking blocks from streamed text (tags: `<think>`, `<thinking>`, `<thought>`, `<antThinking>` and their content). Code blocks MUST be preserved (thinking tags inside backticks are not stripped).
- The bridge MUST implement a pending message system — track message IDs and resolve/reject promises when the gateway responds.
- The bridge MUST support rate-limit retry: when the gateway returns a rate limit response, display a countdown timer and retry automatically.
- The bridge MUST reload conversation history from the gateway when the agent transitions from working to idle (debounced).

#### 2.4 Session Management

- The bridge MUST support switching between threads/sessions via the gateway.
- The bridge MUST support creating new threads via the gateway.
- The bridge MUST track the current session key and expose it as a reactive signal.
- The bridge MUST support aborting in-progress generation.

### Interface

```typescript
// Reactive signals exposed by the gateway bridge
interface GatewayBridge {
  // Connection
  connect(): void
  disconnect(): void
  connectionStatus: Accessor<ConnectionStatus>
  statusText: Accessor<string>

  // Chat
  sendMessage(text: string, attachments?: File[]): Promise<void>
  abortChat(): void

  // Session
  sessionKey: Accessor<string>
  switchSession(key: string): Promise<void>
  createSession(label?: string): Promise<string>

  // State
  turns: ParsedTurn[]
  streamingHtml: Accessor<string>
  agentStatus: Accessor<AgentStatus>
  liveWork: Accessor<WorkItem[]>
  liveThinkingText: Accessor<string>
  compacting: Accessor<boolean>
  isRetryCountdownActive: Accessor<boolean>
}

type ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'
type AgentStatus = 'idle' | 'working' | 'thinking'
```

### Files

```
packages/client/src/lib/
├── gateway.ts           # WebSocket connection, message handling, state management
├── gateway.test.ts      # Unit tests (mocked WebSocket)
├── device-identity.ts   # Ed25519 keypair generation, signing, token storage
├── device-identity.test.ts
├── audio.ts             # Audio playback (TTS), recording, unlock helpers
├── audio.test.ts
├── markdown.ts          # Markdown → HTML rendering with syntax highlighting
├── markdown.test.ts
├── export.ts            # Message export (markdown, PDF, text)
├── export.test.ts
```

---

## 3. App Store

Central reactive state for the chat application. Ported from voice-ui's `stores/app.ts`.

### Requirements

- The store MUST expose all reactive signals needed by chat components:
  - `connectionStatus`, `statusText` — gateway connection state
  - `sessionKey` — current thread/session identifier
  - `viewMode` — current view (`chat`, `voice`, `dashboard`, `recording`)
  - `turns` — parsed conversation turns (user message + work items + assistant response)
  - `streamingHtml` — live streaming HTML content
  - `agentStatus` — current agent activity state
  - `liveWork` — array of work items for the in-progress turn
  - `liveThinkingText` — raw thinking text being streamed
  - `compacting` — context compaction indicator
  - `voiceState` — voice interface state (`idle`, `listening`, `speaking`, `processing`)
  - `drawerOpen` — thread drawer visibility
  - `isRecording` — voice recording active state
  - `settingsOpen` — settings modal visibility
- The store MUST define the `ParsedTurn` type: `{ user, work: WorkItem[], final: string | null, finalTimestamp?, cronResult?, pending? }`.
- The store MUST define the `WorkItem` type: `{ kind: 'toolCall' | 'toolResult' | 'thought' | 'system', systemKind?, name?, text?, content?, input?, toolCallId? }`.
- The `viewMode` MUST sync with URL query parameters (`?view=chat`, `?view=voice`, etc.) and support browser back/forward navigation.
- The initial session key MUST be read from URL hash or default to `'main'`.
- The store MUST support retry countdown state: `isRetryCountdownActive`, `startRetryCountdown(seconds)`, `clearRetryCountdown()`.

### Files

```
packages/client/src/stores/
├── app.ts               # All reactive signals + types
├── app.test.ts          # Store unit tests
```

---

## 4. Chat Interface

The primary conversation view. Renders the message thread with streaming, work indicators, and auto-scrolling.

### Requirements

#### 4.1 Chat View

- The chat view MUST render conversation turns as a scrollable list.
- The chat view MUST auto-scroll to the bottom on new messages or streaming content — UNLESS the user has manually scrolled up.
- The chat view MUST detect user scroll-up via a scroll threshold (80px from bottom) and pause auto-scroll.
- The chat view MUST show a "scroll to bottom" button when the user has scrolled up and new content arrives.
- The chat view MUST use double-`requestAnimationFrame` for scroll-after-render to ensure DOM layout.
- The chat view MUST show a streaming indicator (pulsing dots appended to the last text, via `.streaming-dots` CSS) when content is being streamed.
- The chat view MUST show a compaction indicator when context is being compacted.
- The chat view MUST show a rate-limit retry countdown when the gateway is rate-limited.

#### 4.2 Message Bubble

- User messages MUST be styled as right-aligned bubbles with `--c-user-bubble` background.
- Assistant messages MUST be left-aligned with full-width markdown rendering.
- System messages MUST be styled distinctly (muted, centered or indented).
- Each message MUST show a timestamp (today → "Today at HH:MM:SS", older → "Day, Mon DD at HH:MM:SS").
- Each message MUST have a context menu (long-press on mobile, right-click on desktop) with actions: Copy text, Copy markdown, Export PDF, Forward to thread.
- Message copy buttons (`.msg-copy-btn`) MUST appear on hover (desktop) and be accessible via context menu (mobile).
- Assistant messages MUST render markdown with the full `.msg-assistant` style rules: headings, lists, code blocks with copy buttons, inline code with copy buttons, blockquotes, tables, links, strong, emphasis, horizontal rules.
- Pending messages (optimistic, not yet confirmed by gateway) MUST be visually distinguished (e.g. reduced opacity).

#### 4.3 Work Section

- Between a user message and the assistant's final response, a collapsible **work section** MUST display the agent's intermediate activity.
- Work items MUST include: tool calls (with name, icon, input preview), tool results (with output preview), thinking blocks (expandable), system events (nudges, compaction, heartbeat, etc.).
- Tool calls MUST be paired with their results (matched by `toolCallId`).
- Each tool call MUST show an icon from the tool icon map (📖 read, ✏️ write, ✂️ edit, ▶ exec, ⚙ process, 🌐 browser, etc.).
- Tool call inputs and results MUST be collapsible (collapsed by default for long content).
- Thinking blocks MUST be collapsible and styled distinctly.
- The work section MUST be collapsible as a whole (default collapsed when the turn is complete).

### Files

```
packages/client/src/components/
├── ChatView.tsx          # Main chat view with scrolling logic
├── ChatView.test.ts
├── MessageBubble.tsx     # Individual message rendering
├── MessageBubble.test.ts
├── WorkSection.tsx       # Tool calls, thinking blocks, system events
├── WorkSection.test.ts
```

---

## 5. Input Area

The message composition area. Supports text, file attachments, and voice recording trigger.

### Requirements

- The input area MUST provide a multi-line text input that auto-resizes vertically as the user types.
- The input area MUST send on Enter (without modifier) and insert a newline on Shift+Enter.
- The input area MUST support file attachments: drag-and-drop, paste, and a file picker button.
- Attached files MUST be shown as removable chips above the input.
- The input area MUST include a voice recording button (microphone icon) that triggers push-to-talk recording.
- The recording state MUST show a timer (elapsed time) and a pulsing animation (`animate-mic-pulse`).
- The input area MUST include a send button that is disabled when input is empty and no files are attached.
- The input area MUST include an abort button (visible only when the agent is working) to cancel in-progress generation.
- The input area MUST support message history navigation: Up/Down arrow keys cycle through previously sent messages (per-thread, persisted in `localStorage`).
- The input area MUST support a scratchpad: content is auto-saved to `localStorage` per thread and restored on thread switch.
- The input area MUST be fixed at the bottom of the chat view with safe-area padding for mobile (`.safe-bottom`).
- The input area MUST show the current agent status inline (e.g. "Working…", "Thinking…") when the agent is active.

### Files

```
packages/client/src/components/
├── InputArea.tsx          # Text input, file attachments, recording, send/abort
├── InputArea.test.ts
```

---

## 6. Thread System

Entity-bound thread management. Every thread is tied to a git entity or is a global thread.

### Requirements

#### 6.1 Thread Model

- Every thread MUST have an identity: `{ threadKey: string, entityBinding?: EntityBinding, label?: string }`.
- An `EntityBinding` MUST contain: `{ orgId, projectId, entityType: 'branch' | 'issue' | 'pr', entityRef: string }`.
- Thread keys for entity-bound threads MUST follow the format: `{orgId}/{projectId}/{entityType}:{entityRef}` (e.g. `myorg/myrepo/branch:feat-auth`, `myorg/myrepo/issue:42`, `myorg/myrepo/pr:73`).
- Global thread keys MUST be: `main` for the default thread, or user-defined labels for bespoke threads.
- When a worktree is created (bus event `worktree.created`), a thread MUST be automatically created (or reused) for that branch.
- When an issue is created (bus event `issue.created`), a thread MUST be automatically created for that issue.
- When a review is created (bus event `review.created`), a thread MUST be automatically created for that PR/patch.

#### 6.2 Event Routing

- Events from an entity MUST be routed to the entity's thread:
  - `git.status.changed` with a branch → route to `branch:*` thread
  - `issue.updated`, `issue.comment.added` → route to `issue:*` thread
  - `review.updated`, `review.comment.added`, `review.approved`, `review.merged` → route to `pr:*` thread
  - Webhook events with entity extraction → route to the matching thread
- AGENT-classified events MUST trigger autonomous agent work in the thread (send the event as a system message to the gateway session for that thread).
- NOTIFY-classified events MUST surface as a notification in the thread view for the user to respond to.
- Events for entities with no existing thread SHOULD create the thread automatically.

#### 6.3 Thread Drawer

- The thread drawer MUST slide in from the left, showing all threads grouped by:
  - **Global** — main thread + user-created threads
  - **Per-workspace** — grouped by `orgId/projectId`, showing entity-bound threads
- Each thread entry MUST show: display name, entity type icon, last activity time, unread indicator.
- The drawer MUST support: switching threads (tap), creating new global threads, hiding threads (swipe or menu), unhiding threads.
- Hidden threads MUST be persisted in `localStorage`.
- The drawer MUST show subagent sessions (if any) under the parent thread.
- Thread display names MUST be derived from the entity: branch name, issue title + number, PR title + number.

#### 6.4 Thread Status

- Each thread MUST expose status: last message timestamp, unread count, agent activity state (idle/working).
- Thread status MUST be fetched from the gateway and updated via WS.
- The header MUST show the current thread name and a badge with unread count from other threads.

### Files

```
packages/client/src/lib/
├── threads.ts           # Thread management, entity binding, event routing, status
├── threads.test.ts

packages/client/src/components/
├── ThreadDrawer.tsx      # Slide-out thread list
├── ThreadDrawer.test.ts

packages/server/src/threads/
├── types.ts             # ThreadKey, EntityBinding, ThreadEvent types
├── router.ts            # Event → thread routing logic
├── router.test.ts       # Router tests
├── threads.ts           # Thread registry, auto-creation on entity events
├── threads.test.ts      # Thread management tests
```

---

## 7. Message Forwarding

Cross-thread message forwarding for user-driven orchestration.

### Requirements

- The user MUST be able to forward any message from one thread to another.
- Forwarding MUST be accessible from the message context menu: "Forward to…" → thread picker.
- The thread picker MUST show all available threads (global + entity-bound) with search/filter.
- A forwarded message MUST preserve: original message content, original author (user/assistant/system), original timestamp, source thread identity, any file attachments or file refs.
- The user MUST be able to add commentary text when forwarding ("Add a note…" input in the forward dialog).
- The forwarded message MUST be visually distinct in the target thread — a "forwarded from" header showing the source thread name and original timestamp.
- The forward operation MUST send the message + commentary to the gateway session for the target thread (so the agent in that thread receives the context).
- The forward MUST work across workspaces (forward from a thread in project A to a thread in project B).
- Forward MUST emit a bus event: `thread.message.forwarded` with `{ sourceThread, targetThread, messageId }`.

### Interface

```typescript
interface ForwardedMessage {
  originalContent: string
  originalRole: 'user' | 'assistant' | 'system'
  originalTimestamp: number
  sourceThread: string // thread key where the message originated
  sourceThreadLabel: string // display name of source thread
  commentary?: string // user's added note
  attachments?: string[] // file paths or refs
}
```

### Files

```
packages/client/src/components/
├── ForwardDialog.tsx     # Thread picker + commentary input
├── ForwardDialog.test.ts

packages/server/src/threads/
├── forward.ts           # Forward message handling (server-side)
├── forward.test.ts
```

---

## 8. Voice Interface

Push-to-talk voice recording and TTS playback. Ported from voice-ui.

### Requirements

- The voice view MUST provide a full-screen push-to-talk interface (large button, status text, timer).
- Recording MUST use `MediaRecorder` with `audio/webm;codecs=opus` (fallback to `audio/webm`).
- On recording stop, audio MUST be sent to the transcription endpoint (Whisper / Kokoro) and the resulting text sent as a chat message.
- TTS playback MUST be supported: when the agent responds, the response text is sent to the TTS endpoint and played back as audio.
- Audio unlock MUST be handled for mobile browsers (iOS Safari requires user gesture to play audio).
- The voice view MUST show state transitions: `idle` → `listening` (recording) → `processing` (transcribing) → `speaking` (TTS playback) → `idle`.
- Each state MUST have distinct visual feedback: idle (tap prompt), listening (pulsing mic animation), processing (spinner), speaking (pulsing speaker animation).
- The voice view MUST support interrupting TTS playback (tap while speaking → stop audio, return to idle).
- Recording view (separate from voice view) MUST list past recordings with playback, export, and delete actions.

### Files

```
packages/client/src/components/
├── VoiceView.tsx         # Full-screen push-to-talk interface
├── VoiceView.test.ts
├── RecordingView.tsx     # Past recordings list
├── RecordingView.test.ts
```

---

## 9. Dashboard (Global Context)

The home screen for global threads. Shows activity across all workspaces.

### Requirements

- The dashboard MUST be the default view when the user is in a global thread (main or bespoke).
- The dashboard MUST show:
  - **Clock** — current time, auto-updating.
  - **System health** — connection status to gateway, connected services (server, Kokoro TTS), uptime indicators.
  - **Workspace activity feed** — recent events across all workspaces: commits, active agents, running tests, open reviews, issue updates. Each entry links to its entity-bound thread.
  - **Notifications** — grouped by thread/entity. NOTIFY events shown with action prompt. Click → jump to thread.
  - **Active agents** — list of currently working agent sessions with status and thread binding.
  - **Thread quick-switch** — list of recently active threads, click to switch.
- The dashboard MUST auto-refresh via WS subscriptions (status updates, notifications, workspace events).
- The dashboard MUST use the same theme tokens and visual language as the rest of the chat interface.
- The dashboard SHOULD show weather (ported from voice-ui, configurable, optional).
- The dashboard MAY show task/planning summary (completion rates from Phase 5 planning module).

### Files

```
packages/client/src/components/
├── DashboardView.tsx     # Global context home screen
├── DashboardView.test.ts
```

---

## 10. Header & Navigation

Top navigation bar. Ported from voice-ui with adaptations for entity-bound threads.

### Requirements

- The header MUST show: connection status indicator (colored dot), current thread name, view switcher (chat/voice/dashboard), thread drawer toggle, settings button.
- The connection status MUST use theme-consistent colors: green for connected, red for error/disconnected, muted for connecting.
- The thread name MUST show the entity binding when applicable (e.g. "feat-auth" for a branch thread, "Issue #42: Fix login" for an issue thread).
- The header MUST include a subagent indicator: when subagents are active in the current thread, show a count badge.
- The header MUST include a warning badge with count (architecture warnings).
- View switching MUST update the URL query parameter and render the appropriate view.
- The settings modal MUST support: theme selection (dark/light/ironman/jarvis), gateway URL configuration, audio settings (TTS enabled, voice selection).

### Files

```
packages/client/src/components/
├── Header.tsx            # Top navigation bar
├── Header.test.ts
├── SettingsModal.tsx     # Theme, gateway, audio settings
├── SettingsModal.test.ts
├── GatewayTokenModal.tsx # Manual gateway token entry
├── GatewayTokenModal.test.ts
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 6 MUST include integration tests covering:

- Gateway connection → authentication → session established → send message → receive streaming response → final turn rendered
- Thread auto-creation: worktree.created event → branch thread created → thread drawer shows it
- Thread auto-creation: issue.created event → issue thread created
- Event routing: issue.updated event → routed to correct issue thread
- Thread switching: switch thread → gateway session changes → history loaded → messages rendered
- Message forwarding: forward message from thread A to thread B → appears in B with "forwarded from" header
- Voice recording: start recording → stop → audio transcribed → message sent as chat
- Dashboard: workspace events arrive via WS → activity feed updates
- Theme switching: change theme → all components re-render with new tokens
- Auto-scroll: messages arrive → chat scrolls to bottom → user scrolls up → auto-scroll pauses → new message indicator appears
- Input area: message history navigation with arrow keys → previous messages cycle
- Rate limit retry: gateway returns rate limit → countdown displayed → auto-retry

### Server-Side Thread Module

The thread management logic (auto-creation, event routing) lives on the server:

```
packages/server/src/threads/
├── types.ts             # ThreadKey, EntityBinding, ThreadEvent
├── router.ts            # Event → thread routing
├── router.test.ts
├── threads.ts           # Thread registry, auto-creation
├── threads.test.ts
├── forward.ts           # Message forwarding
├── forward.test.ts
├── ws.ts                # WS channel for thread events
├── ws.test.ts
├── routes.ts            # REST API for thread operations
```

Thread REST API:

- `GET /api/threads` — list all threads with status
- `GET /api/threads/:key` — get thread details + entity binding
- `POST /api/threads` — create a global thread
- `DELETE /api/threads/:key` — archive/hide a thread
- `POST /api/threads/:key/forward` — forward a message to this thread
- `GET /api/threads/:key/events` — list events routed to this thread

Thread WS channel: `threads`

- Server → client: `thread.created`, `thread.updated`, `thread.event.routed`, `thread.message.forwarded`
- Scoped by: `{ orgId?, projectId? }` — or unscoped for all threads

Thread bus events: `thread.created`, `thread.archived`, `thread.event.routed`, `thread.message.forwarded`

### Dependencies (New)

**Client:**

- `marked` or equivalent — markdown → HTML rendering (if not already included)
- `highlight.js` — syntax highlighting for code blocks (if not already included)
- `@noble/ed25519` — Ed25519 keypair for device identity

**Server:**

- No new server dependencies

### Module Registration

Server-side thread module follows the established pattern:

- Export `createThreadManager(bus: EventBus, dataDir: string, deps: ThreadDeps)` factory
- Export `status(): ModuleStatus`
- `ThreadDeps: { getConfig: () => Config }`
- Thread registry persisted to `{dataDir}/threads/registry.json`

### Testing

- **Client tests:** Use Vitest with `environment: 'node'`. Mock `WebSocket`, `localStorage`, `MediaRecorder`. Test reactive signal updates, message parsing, theme token application.
- **Server tests:** Thread router tests with mock bus events. Thread auto-creation tests. Forward tests.
- **Integration tests** in `packages/server/src/__integration__/phase6.test.ts` and `packages/client/src/__integration__/phase6.test.ts`.

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1–5 directories)
├── threads/
│   └── registry.json    # Thread registry (key → entity binding, metadata)
```

### Config

No new config namespace required. Gateway URL is configured client-side. Theme preference is stored in `localStorage`.

Thread auto-creation behaviour SHOULD be configurable in the future via `threads.autoCreate: boolean` but defaults to `true` and is not configurable in Phase 6.
