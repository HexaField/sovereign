# Phase 6: Chat & Voice — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-03-13

This document specifies the Chat & Voice modules of Phase 6. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 6 depends on Phase 3 (WebSocket protocol, config) and uses the thread/notification infrastructure from Phase 1. This phase builds Sovereign's primary interaction surface — chat, voice, threads, and dashboard — with the same visual design and UX as the existing voice-ui.

---

## Design Philosophy

**Port, don't rewrite.** The voice-ui chat interface is production-tested and well-understood. Phase 6 ports its UX into Sovereign's client package with the same visual design, interactions, and behaviour. The codebase is adapted to Sovereign's architecture (event bus, WS protocol, config module) but the UX MUST remain identical.

**Agent backend abstraction.** The client MUST NOT know about OpenClaw. All agent communication flows through Sovereign's server, which defines its own API contracts for chat, sessions, and agent status. The server implements these contracts using an `AgentBackend` interface — with OpenClaw as the initial (and only) implementation. Phase 8 (Agent Core) adds a native implementation. The swap is a server-side concern; the client never changes.

**Server-side proxy.** The Sovereign server maintains persistent WebSocket connections to the agent backend (OpenClaw gateway). The client connects only to Sovereign's WS (Phase 3 protocol). Chat messages, session management, and agent events all flow through the server. This gives the server full visibility for thread routing, event injection, message forwarding, and future autonomous operations.

**Entity-bound threads.** Every thread is associated with a git entity (branch, issue, PR/patch). Events from that entity route into the thread automatically. The 'main' thread and user-created bespoke threads are global (no entity binding).

**Inline Tailwind, not CSS classes.** All styling MUST use Tailwind utility classes inline on components (or extracted into reusable SolidJS components), NOT custom CSS classes. The only CSS file is for theme token definitions (CSS custom properties on `:root` / `.light` / `.ironman` / `.jarvis`), keyframe animations, scrollbar styling, and the minimal set of pseudo-element rules that Tailwind cannot express (e.g. `.streaming-dots::after`). Everything else is Tailwind.

---

## Architecture: Agent Backend Abstraction

### The Problem

Sovereign needs an LLM agent to power chat. Today that's OpenClaw. Tomorrow it's Sovereign's own agent core (Phase 8). The client should never know or care which one is running.

### The Solution

A server-side `AgentBackend` interface that abstracts all agent operations. The server proxies between the client (via Phase 3 WS protocol) and the backend.

```
┌─────────┐     Phase 3 WS      ┌─────────────┐    AgentBackend     ┌──────────────┐
│  Client  │ ◄────────────────► │  Sovereign   │ ◄─────────────────► │   OpenClaw   │
│ (SolidJS)│   sovereign API    │   Server     │   interface impl    │   Gateway    │
└─────────┘   contracts only    └─────────────┘                      └──────────────┘
                                       │
                                       ▼  (Phase 8)
                                ┌──────────────┐
                                │  Native Agent│
                                │    Core      │
                                └──────────────┘
```

### AgentBackend Interface

```typescript
// packages/core/src/agent-backend.ts

export interface AgentBackendEvents {
  /** Streaming tokens from the agent */
  'chat.stream': { sessionKey: string; text: string }
  /** Agent completed a turn */
  'chat.turn': { sessionKey: string; turn: ParsedTurn }
  /** Agent status changed */
  'chat.status': { sessionKey: string; status: AgentStatus }
  /** Agent is performing work (tool calls, thinking) */
  'chat.work': { sessionKey: string; work: WorkItem }
  /** Context compaction started/completed */
  'chat.compacting': { sessionKey: string; active: boolean }
  /** Error from the agent */
  'chat.error': { sessionKey: string; error: string; retryAfterMs?: number }
  /** Session info (on connect or session switch) */
  'session.info': { sessionKey: string; label?: string; history: ParsedTurn[] }
  /** Backend connection state changed */
  'backend.status': { status: BackendConnectionStatus }
}

export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface AgentBackend {
  /** Connect to the agent backend */
  connect(): Promise<void>

  /** Disconnect from the agent backend */
  disconnect(): Promise<void>

  /** Current connection status */
  status(): BackendConnectionStatus

  /** Send a chat message to a session */
  sendMessage(sessionKey: string, text: string, attachments?: Buffer[]): Promise<void>

  /** Abort in-progress generation for a session */
  abort(sessionKey: string): Promise<void>

  /** Switch to / activate a session */
  switchSession(sessionKey: string): Promise<void>

  /** Create a new session */
  createSession(label?: string): Promise<string>

  /** Get conversation history for a session */
  getHistory(sessionKey: string): Promise<ParsedTurn[]>

  /** Register a callback for backend events */
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void

  /** Unregister a callback */
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
}
```

### OpenClaw Implementation

```typescript
// packages/server/src/agent-backend/openclaw.ts

export function createOpenClawBackend(config: OpenClawConfig): AgentBackend {
  // Manages WebSocket connection to OpenClaw gateway
  // Translates OpenClaw protocol → AgentBackend events
  // Handles Ed25519 device identity, authentication, reconnection
  // Implements all AgentBackend methods by proxying to gateway WS
}

export interface OpenClawConfig {
  /** Gateway WebSocket URL (e.g. wss://localhost:3456/ws) */
  gatewayUrl: string
  /** Device identity for authentication */
  deviceKeyPath?: string
  /** Reconnection settings */
  reconnect?: {
    initialDelayMs?: number // default 1000
    maxDelayMs?: number // default 30000
    jitter?: boolean // default true
  }
}
```

### Server Chat Module

The chat module bridges the client WS and the agent backend:

```typescript
// packages/server/src/chat/chat.ts

export function createChatModule(bus: EventBus, backend: AgentBackend, threadManager: ThreadManager): ChatModule {
  // Registers WS channel 'chat' for client communication
  // Proxies client messages → backend.sendMessage()
  // Proxies backend events → client WS messages
  // Integrates with thread manager for event routing
  // Handles session ↔ thread mapping
}
```

### Client API Contract

The client talks to Sovereign's WS channel `chat`. It knows nothing about what's behind it.

**Client → Server (via Phase 3 WS):**

- `chat.send` — `{ text: string, attachments?: string[] }`
- `chat.abort` — `{}`
- `chat.history` — `{}`
- `chat.session.switch` — `{ threadKey: string }`
- `chat.session.create` — `{ label?: string }`

**Server → Client (via Phase 3 WS):**

- `chat.stream` — `{ text: string }` (streaming tokens)
- `chat.turn` — `{ turn: ParsedTurn }` (complete turn)
- `chat.status` — `{ status: AgentStatus }` (idle/working/thinking)
- `chat.work` — `{ work: WorkItem }` (tool calls, thinking blocks)
- `chat.compacting` — `{ active: boolean }`
- `chat.error` — `{ error: string, retryAfterMs?: number }`
- `chat.session.info` — `{ threadKey: string, label?: string, history: ParsedTurn[] }`

The scoping mechanism from Phase 3 WS applies: clients subscribe to `chat` scoped by `{ threadKey }`.

---

## Wave Strategy

**Wave 1 (parallel):** Theme System, Agent Backend Abstraction + OpenClaw Implementation, Chat Module (server), Client Stores **Wave 2 (after wave 1):** Chat Interface, Input Area **Wave 3 (after wave 2):** Thread System, Message Forwarding **Wave 4 (after wave 3):** Voice Interface, Dashboard **Wave 5:** Integration tests

---

## 1. Theme System

Port the voice-ui's visual identity into Sovereign as CSS custom properties + Tailwind utility classes.

### Requirements

- The client MUST define CSS custom properties (`--c-*` tokens) for all theme values: backgrounds (`bg`, `bg-raised`, `bg-overlay`), borders (`border`, `border-subtle`, `border-strong`), text (`text`, `text-muted`, `text-heading`), accents (`accent`, `danger`, `amber`), code (`code-text`, `code-bg`, `pre-bg`), hover states (`hover-bg`, `hover-bg-strong`, `active-bg`), scrollbar (`scrollbar-thumb`, `scrollbar-hover`), overlays (`backdrop`, `overlay-bg`, `menu-bg`), chat-specific (`user-bubble`, `user-bubble-text`, `badge-count`), work section (`step-bg`, `step-badge-bg`, `work-body-bg`, `work-border`), blockquote.
- The client MUST support four themes: `default` (dark), `light`, `ironman` (blue HUD with Orbitron font), `jarvis` (orange HUD with Orbitron font).
- Themes MUST be activated by CSS class on `<html>`: no class = dark (default), `.light`, `.ironman`, `.jarvis`.
- The Orbitron font MUST be included (`/fonts/orbitron.woff2`, weight 400–700) for HUD themes.
- The `--c-font` property MUST switch between the system font stack (dark/light) and Orbitron (ironman/jarvis).
- All component styling MUST use **inline Tailwind utility classes** referencing theme tokens via `var(--c-*)` in `style` props (e.g. `style={{ background: 'var(--c-bg-raised)' }}`), or via Tailwind's arbitrary value syntax (e.g. `bg-[var(--c-bg-raised)]`).
- Reusable visual patterns MUST be extracted into SolidJS components (e.g. `<Card>`, `<Badge>`, `<Chip>`, `<IconButton>`) rather than CSS utility classes.
- The only CSS file (`app.css`) MUST contain ONLY:
  1. CSS custom property definitions (`:root`, `.light`, `.ironman`, `.jarvis`)
  2. `@font-face` for Orbitron
  3. `@keyframes` for animations (`mic-pulse`, `voice-pulse`, `speak-pulse`, `pulse-dots`, `march`, `warning-pulse`)
  4. Scrollbar styling (`::-webkit-scrollbar*`)
  5. The minimal set of pseudo-element rules Tailwind cannot express (e.g. `.streaming-dots > div > :last-child::after`)
  6. Safe area `@supports` rules
- Keyframe-dependent animation utilities MUST be defined as Tailwind classes in `tailwind.config.ts` `extend.animation` rather than custom CSS.
- The client MUST persist the selected theme in `localStorage` key `sovereign:theme` and restore it on load.
- The client SHOULD support `prefers-color-scheme` for auto dark/light when no theme is explicitly selected.

### Reusable Components

The following utility components MUST be created to replace voice-ui's CSS classes:

- `<Card>` — raised background, border, rounded corners (replaces arbitrary `bg-raised` patterns)
- `<Badge>` — small label with accent background (replaces `.badge-count` pattern)
- `<Chip>` — file path chip with icon, monospace text, hover accent border (replaces `.file-chip`)
- `<IconButton>` — icon-only button with hover/active states (replaces `.rec-btn`, `.code-copy-btn`, etc.)
- `<Spinner>` — loading indicator
- `<Tooltip>` — hover tooltip

### Files

```
packages/client/src/
├── app.css                    # Theme tokens, @font-face, @keyframes, scrollbar, pseudo-elements ONLY
├── fonts/orbitron.woff2
├── tailwind.config.ts         # Extended with custom animations, colors referencing CSS vars
├── components/ui/
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── Chip.tsx
│   ├── IconButton.tsx
│   ├── Spinner.tsx
│   ├── Tooltip.tsx
│   └── index.ts              # Barrel export
```

---

## 2. Agent Backend Abstraction

Server-side abstraction over the agent runtime. The client never touches this directly.

### Requirements

#### 2.1 Interface

- The `AgentBackend` interface MUST be defined in `@template/core` (shared types).
- The interface MUST support: `connect()`, `disconnect()`, `status()`, `sendMessage()`, `abort()`, `switchSession()`, `createSession()`, `getHistory()`.
- The interface MUST support event subscription: `on(event, handler)`, `off(event, handler)`.
- Events MUST include: `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `session.info`, `backend.status`.
- All types (`ParsedTurn`, `WorkItem`, `AgentStatus`, `BackendConnectionStatus`) MUST be defined in `@template/core`.

#### 2.2 OpenClaw Implementation

- The OpenClaw backend MUST establish a WebSocket connection to the OpenClaw gateway.
- The backend MUST implement Ed25519 device identity authentication:
  - Generate a keypair on first use, store to `{dataDir}/agent-backend/device-identity.json`.
  - Sign authentication payloads with the device private key.
  - Send device token on connection.
- The backend MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- The backend MUST translate the OpenClaw gateway protocol to `AgentBackend` events:
  - OpenClaw `chat.stream` → `AgentBackendEvents['chat.stream']`
  - OpenClaw `chat.turn` → `AgentBackendEvents['chat.turn']`
  - etc.
- The backend MUST strip thinking blocks from streamed text (tags: `<think>`, `<thinking>`, `<thought>`, `<antThinking>` and their content). Code blocks MUST be preserved.
- The backend MUST handle rate-limit responses: emit `chat.error` with `retryAfterMs`, then auto-retry.
- The backend MUST support the gateway's device pairing flow: if the device is not yet approved, emit `backend.status` with `'error'` and metadata about pairing.
- The gateway URL MUST be configurable via the Phase 3 config module: `agentBackend.openclaw.gatewayUrl`.
- The backend MUST support hot-reload: when `agentBackend.openclaw.gatewayUrl` changes via config, reconnect to the new URL without restart.
- The backend MUST reload conversation history when the agent transitions from working to idle (debounced, emitted as `session.info`).

#### 2.3 Chat Module (Server)

- The chat module MUST register WS channel `chat` on the Phase 3 WS protocol.
- The chat module MUST proxy client WS messages to the `AgentBackend`:
  - `chat.send` → `backend.sendMessage()`
  - `chat.abort` → `backend.abort()`
  - `chat.history` → `backend.getHistory()`
  - `chat.session.switch` → `backend.switchSession()`
  - `chat.session.create` → `backend.createSession()`
- The chat module MUST proxy `AgentBackend` events to subscribed clients via WS:
  - `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `chat.session.info`
- WS subscriptions MUST be scoped by `{ threadKey }` — a client subscribed to thread `main` only receives events for that thread.
- The chat module MUST emit bus events for thread integration:
  - `chat.message.sent` — when a user sends a message (for thread activity tracking)
  - `chat.turn.completed` — when the agent completes a turn (for thread status updates)
- The chat module MUST maintain a mapping between Sovereign thread keys and backend session keys. Multiple Sovereign threads MAY map to different backend sessions.

### REST API

- `GET /api/chat/status` — agent backend connection status
- `POST /api/chat/sessions` — create a new session (returns session/thread key)

### Config Schema Addition

```typescript
agentBackend: {
  provider: 'openclaw' // only option for now; Phase 8 adds 'native'
  openclaw: {
    gatewayUrl: string // e.g. 'wss://localhost:3456/ws'
    reconnect: {
      initialDelayMs: number // default 1000
      maxDelayMs: number // default 30000
    }
  }
}
```

### Files

```
packages/core/src/
├── agent-backend.ts           # AgentBackend interface, event types, shared types (ParsedTurn, WorkItem, AgentStatus)

packages/server/src/agent-backend/
├── types.ts                   # Server-side types
├── openclaw.ts                # OpenClaw gateway implementation
├── openclaw.test.ts
├── thinking.ts                # Thinking block stripping (shared utility)
├── thinking.test.ts

packages/server/src/chat/
├── chat.ts                    # Chat module — WS channel, proxy, bus integration
├── chat.test.ts
├── routes.ts                  # REST endpoints
├── ws.ts                      # WS channel registration + message handlers
├── ws.test.ts
```

---

## 3. Client Stores

Modular reactive state. Each domain owns its own store — no monolithic app store. Stores are self-contained: they define their own signals, subscribe to their own WS channels, and expose only what consumers need.

### Requirements

#### 3.1 Connection Store

- MUST expose: `connectionStatus: Accessor<ConnectionStatus>`, `statusText: Accessor<string>`.
- MUST subscribe to the `chat` WS channel for `backend.status` messages.
- MUST derive `statusText` from `connectionStatus` (e.g. `'connecting'` → `'connecting…'`).
- Types: `ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'`.

#### 3.2 Chat Store

- MUST expose: `turns: ParsedTurn[]`, `streamingHtml: Accessor<string>`, `agentStatus: Accessor<AgentStatus>`, `liveWork: Accessor<WorkItem[]>`, `liveThinkingText: Accessor<string>`, `compacting: Accessor<boolean>`.
- MUST expose retry state: `isRetryCountdownActive: Accessor<boolean>`, `retryCountdownSeconds: Accessor<number>`, `startRetryCountdown(seconds)`, `clearRetryCountdown()`.
- MUST expose actions: `sendMessage(text, attachments?)`, `abortChat()`.
- MUST subscribe to the `chat` WS channel for `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `chat.session.info` messages.
- All state MUST be scoped to the current thread — when the thread changes (from thread store), the chat store resets and loads history for the new thread.
- Types `ParsedTurn`, `WorkItem`, `AgentStatus` imported from `@template/core`.

#### 3.3 Thread Store

- MUST expose: `threadKey: Accessor<string>`, `threads: Accessor<ThreadInfo[]>`.
- MUST expose actions: `switchThread(key)`, `createThread(label?)`.
- The `threadKey` MUST sync with URL hash and support browser back/forward navigation.
- The initial thread key MUST be read from URL hash or default to `'main'`.
- MUST subscribe to the `threads` WS channel for `thread.created`, `thread.updated`, `thread.status` messages.
- MUST fetch thread list on init via REST (`GET /api/threads`).

#### 3.4 Voice Store

- MUST expose: `voiceState: Accessor<VoiceState>`, `isRecording: Accessor<boolean>`, `recordingTimerText: Accessor<string>`, `voiceStatusText: Accessor<string>`.
- MUST expose actions: `startRecording()`, `stopRecording()`, `interruptPlayback()`.
- Self-contained: manages `MediaRecorder`, audio chunks, timer intervals internally.
- Types: `VoiceState = 'idle' | 'listening' | 'speaking' | 'processing'`.

#### 3.5 UI Store

- MUST expose: `viewMode: Accessor<ViewMode>`, `setViewMode(mode)`, `drawerOpen: Accessor<boolean>`, `setDrawerOpen(open)`, `settingsOpen: Accessor<boolean>`, `setSettingsOpen(open)`.
- The `viewMode` MUST sync with URL query parameters (`?view=chat`, `?view=voice`, etc.) and support browser back/forward navigation.
- Types: `ViewMode = 'chat' | 'voice' | 'dashboard' | 'recording'`.

#### 3.6 Store Principles

- Each store MUST be a standalone module — no circular imports between stores.
- Cross-store coordination MUST flow through the WS channel (server as source of truth) or through explicit composition in components, NOT through stores importing each other.
- The one exception: the chat store MUST read the current `threadKey` from the thread store to scope its WS subscription. This is a read-only dependency, passed as a parameter at init: `initChatStore(threadKey: Accessor<string>)`.
- Each store MUST be independently testable with a mocked WS connection.

### Files

```
packages/client/src/stores/
├── connection.ts        # Backend connection status
├── connection.test.ts
├── chat.ts              # Turns, streaming, work, agent status, retry
├── chat.test.ts
├── thread.ts            # Thread list, current thread, switching
├── thread.test.ts
├── voice.ts             # Recording state, playback state
├── voice.test.ts
├── ui.ts                # View mode, drawer, settings modal
├── ui.test.ts
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
- The chat view MUST show a streaming indicator (pulsing dots via Tailwind animation) when content is being streamed.
- The chat view MUST show a compaction indicator when context is being compacted.
- The chat view MUST show a rate-limit retry countdown when the agent backend is rate-limited.
- All styling MUST use inline Tailwind classes with `var(--c-*)` theme tokens.

#### 4.2 Message Bubble

- User messages MUST be styled as right-aligned bubbles with `var(--c-user-bubble)` background and `var(--c-user-bubble-text)` text color.
- Assistant messages MUST be left-aligned with full-width markdown rendering.
- System messages MUST be styled distinctly (muted, centered or indented).
- Each message MUST show a timestamp (today → "Today at HH:MM:SS", older → "Day, Mon DD at HH:MM:SS").
- Each message MUST have a context menu (long-press on mobile, right-click on desktop) with actions: Copy text, Copy markdown, Export PDF, Forward to thread.
- Message copy buttons MUST appear on hover (desktop) using Tailwind `group-hover:opacity-*` and be accessible via context menu (mobile).
- Assistant messages MUST render markdown: headings, lists, code blocks with copy buttons, inline code with copy buttons, blockquotes, tables, links, strong, emphasis, horizontal rules. Markdown rendering styles MUST use a `<MarkdownContent>` component that applies Tailwind classes to rendered HTML elements.
- Pending messages (optimistic, not yet confirmed by server) MUST be visually distinguished (reduced opacity via Tailwind `opacity-50`).

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
├── ChatView.tsx
├── ChatView.test.ts
├── MessageBubble.tsx
├── MessageBubble.test.ts
├── MarkdownContent.tsx       # Renders markdown HTML with Tailwind-styled elements
├── MarkdownContent.test.ts
├── WorkSection.tsx
├── WorkSection.test.ts
```

---

## 5. Input Area

The message composition area. Supports text, file attachments, and voice recording trigger.

### Requirements

- The input area MUST provide a multi-line text input that auto-resizes vertically as the user types.
- The input area MUST send on Enter (without modifier) and insert a newline on Shift+Enter.
- The input area MUST support file attachments: drag-and-drop, paste, and a file picker button.
- Attached files MUST be shown as removable `<Chip>` components above the input.
- The input area MUST include a voice recording button (microphone `<IconButton>`) that triggers push-to-talk recording.
- The recording state MUST show a timer (elapsed time) and a pulsing animation (Tailwind `animate-mic-pulse`).
- The input area MUST include a send `<IconButton>` that is disabled when input is empty and no files are attached.
- The input area MUST include an abort `<IconButton>` (visible only when the agent is working) to cancel in-progress generation.
- The input area MUST support message history navigation: Up/Down arrow keys cycle through previously sent messages (per-thread, persisted in `localStorage`).
- The input area MUST support a scratchpad: content is auto-saved to `localStorage` per thread and restored on thread switch.
- The input area MUST be fixed at the bottom of the chat view with safe-area inset padding for mobile.
- The input area MUST show the current agent status inline (e.g. "Working…", "Thinking…") when the agent is active.

### Files

```
packages/client/src/components/
├── InputArea.tsx
├── InputArea.test.ts
```

---

## 6. Thread System

Entity-bound thread management. Every thread is tied to a git entity or is a global thread.

### Requirements

#### 6.1 Thread Model

- Every thread MUST have an identity: `{ threadKey: string, entities: EntityBinding[], label?: string }`.
- The `entities` array MAY be empty (global threads), contain one entity (typical), or contain multiple entities (cross-cutting work).
- An `EntityBinding` MUST contain: `{ orgId: string, projectId: string, entityType: 'branch' | 'issue' | 'pr', entityRef: string }`.
- Thread keys for entity-bound threads MUST follow the format: `{orgId}/{projectId}/{entityType}:{entityRef}` based on the **primary** entity (first in the array). The key is immutable once created — adding more entities does not change the key.
- Global thread keys MUST be: `main` for the default thread, or user-defined labels for bespoke threads.
- Entities MUST be addable to an existing thread: `POST /api/threads/:key/entities` with an `EntityBinding` body. This allows a thread to track a branch AND its associated issue AND its PR simultaneously.
- Entities MUST be removable from a thread: `DELETE /api/threads/:key/entities/:entityType/:entityRef`.
- When a worktree is created (bus event `worktree.created`), a thread MUST be automatically created (or reused) for that branch.
- When an issue is created (bus event `issue.created`), a thread MUST be automatically created for that issue.
- When a review is created (bus event `review.created`), a thread MUST be automatically created for that PR/patch.
- When entities are naturally related (e.g. a PR references an issue, or a branch is created from an issue), the thread manager SHOULD automatically associate them into the same thread rather than creating separate threads. Detection via: PR body mentioning `fixes #42` / `closes #42`, branch name containing issue number (e.g. `feat/42-auth`), explicit cross-references in issue/PR metadata.
- Thread metadata MUST be persisted to `{dataDir}/threads/registry.json` (atomic write).

#### 6.2 Event Routing

- Events from an entity MUST be routed to **every thread that contains that entity** in its `entities` array. A single event MAY route to multiple threads if the entity is associated with more than one.
- Entity → thread matching:
  - `git.status.changed` with a branch → route to all threads containing `branch:*` entity
  - `issue.updated`, `issue.comment.added` → route to all threads containing `issue:*` entity
  - `review.updated`, `review.comment.added`, `review.approved`, `review.merged` → route to all threads containing `pr:*` entity
  - Webhook events with entity extraction → route to all matching threads
- AGENT-classified events MUST trigger autonomous agent work in the thread: the thread manager sends the event as a system message via the `AgentBackend` to the session mapped to that thread.
- NOTIFY-classified events MUST surface as a notification in the thread view for the user to respond to (via Phase 1 notification system).
- Events for entities with no existing thread SHOULD create the thread automatically.

#### 6.3 Thread Drawer (Client)

- The thread drawer MUST slide in from the left, showing all threads grouped by:
  - **Global** — main thread + user-created threads
  - **Per-workspace** — grouped by `orgId/projectId`, showing entity-bound threads
- Each thread entry MUST show: display name, entity type icon, last activity time, unread indicator.
- The drawer MUST support: switching threads (tap), creating new global threads, hiding threads (swipe or menu), unhiding threads.
- Hidden threads MUST be persisted in `localStorage` key `sovereign:hidden-threads`.
- The drawer MUST show subagent sessions (if any) under the parent thread.
- Thread display names MUST be derived from the primary entity (first in array): branch name, issue title + number, PR title + number. When multiple entities are bound, a secondary indicator MUST show the additional entity count (e.g. "feat-auth +2").
- All styling MUST use Tailwind utility classes.

#### 6.4 Thread Status

- Each thread MUST expose status: last message timestamp, unread count, agent activity state (idle/working).
- Thread status MUST be pushed from the server via the WS `threads` channel.
- The header MUST show the current thread name and a `<Badge>` with unread count from other threads.

### Thread REST API

- `GET /api/threads` — list all threads with status
- `GET /api/threads/:key` — get thread details + entities
- `POST /api/threads` — create a global thread
- `DELETE /api/threads/:key` — archive/hide a thread
- `POST /api/threads/:key/entities` — add an entity binding to a thread
- `DELETE /api/threads/:key/entities/:entityType/:entityRef` — remove an entity from a thread
- `GET /api/threads/:key/events` — list events routed to this thread

### Thread WS Channel: `threads`

**Server → Client:** `thread.created`, `thread.updated`, `thread.event.routed`, `thread.status` **Scoped by:** `{ orgId?, projectId? }` — or unscoped for all threads

### Thread Bus Events

`thread.created`, `thread.archived`, `thread.event.routed`, `thread.message.forwarded`

### Files

```
packages/client/src/lib/
├── threads.ts                # Client-side thread helpers, display names, status tracking
├── threads.test.ts

packages/client/src/components/
├── ThreadDrawer.tsx
├── ThreadDrawer.test.ts

packages/server/src/threads/
├── types.ts                  # ThreadKey, EntityBinding, ThreadEvent
├── router.ts                 # Event → thread routing logic
├── router.test.ts
├── threads.ts                # Thread registry, auto-creation on entity events
├── threads.test.ts
├── ws.ts                     # WS channel for thread events
├── ws.test.ts
├── routes.ts                 # REST API
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
- The forward operation MUST send the message + commentary to the `AgentBackend` session mapped to the target thread (so the agent in that thread receives the context).
- The forward MUST work across workspaces (forward from a thread in project A to a thread in project B).
- Forward MUST emit a bus event: `thread.message.forwarded` with `{ sourceThread, targetThread, messageId }`.
- Forward MUST be available via REST: `POST /api/threads/:key/forward`.

### Interface (in `@template/core`)

```typescript
export interface ForwardedMessage {
  originalContent: string
  originalRole: 'user' | 'assistant' | 'system'
  originalTimestamp: number
  sourceThread: string
  sourceThreadLabel: string
  commentary?: string
  attachments?: string[]
}
```

### Files

```
packages/client/src/components/
├── ForwardDialog.tsx
├── ForwardDialog.test.ts

packages/server/src/threads/
├── forward.ts                # Forward message handling
├── forward.test.ts
```

---

## 8. Voice Interface

Push-to-talk voice recording and TTS playback.

### Requirements

- The voice view MUST provide a full-screen push-to-talk interface (large button, status text, timer).
- Recording MUST use `MediaRecorder` with `audio/webm;codecs=opus` (fallback to `audio/webm`).
- On recording stop, audio MUST be sent to the server's transcription endpoint and the resulting text sent as a chat message via the `chat` WS channel.
- TTS playback MUST be supported: when the agent responds, the response text is sent to the server's TTS endpoint and played back as audio.
- The server MUST expose transcription and TTS via REST:
  - `POST /api/voice/transcribe` — accepts audio blob, returns text
  - `POST /api/voice/tts` — accepts text, returns audio blob
- Audio unlock MUST be handled for mobile browsers (iOS Safari requires user gesture to play audio).
- The voice view MUST show state transitions: `idle` → `listening` (recording) → `processing` (transcribing) → `speaking` (TTS playback) → `idle`.
- Each state MUST have distinct visual feedback using Tailwind animation classes: idle (tap prompt), listening (pulsing mic `animate-mic-pulse`), processing (spinner), speaking (pulsing speaker `animate-speak-pulse`).
- The voice view MUST support interrupting TTS playback (tap while speaking → stop audio, return to idle).
- Recording view (separate from voice view) MUST list past recordings with playback, export, and delete actions.

### Files

```
packages/client/src/components/
├── VoiceView.tsx
├── VoiceView.test.ts
├── RecordingView.tsx
├── RecordingView.test.ts

packages/client/src/lib/
├── audio.ts                  # Audio playback (TTS), recording, unlock helpers
├── audio.test.ts

packages/server/src/voice/
├── voice.ts                  # Voice module — transcription + TTS orchestration
├── voice.test.ts
├── routes.ts                 # REST endpoints for transcribe + TTS
```

---

## 9. Dashboard (Global Context)

The home screen for global threads. Shows activity across all workspaces.

### Requirements

- The dashboard MUST be the default view when the user is in a global thread (main or bespoke).
- The dashboard MUST show:
  - **Clock** — current time, auto-updating.
  - **System health** — backend connection status, connected services, uptime indicators.
  - **Workspace activity feed** — recent events across all workspaces: commits, active agents, running tests, open reviews, issue updates. Each entry links to its entity-bound thread.
  - **Notifications** — grouped by thread/entity. NOTIFY events shown with action prompt. Click → jump to thread.
  - **Active agents** — list of currently working agent sessions with status and thread binding.
  - **Thread quick-switch** — list of recently active threads, click to switch.
- The dashboard MUST auto-refresh via WS subscriptions (`status`, `notifications`, `threads` channels).
- The dashboard MUST use theme tokens via inline Tailwind.
- The dashboard SHOULD show weather (configurable, optional).
- The dashboard MAY show task/planning summary (completion rates from Phase 5 planning module).

### Files

```
packages/client/src/components/
├── DashboardView.tsx
├── DashboardView.test.ts
```

---

## 10. Header & Navigation

Top navigation bar.

### Requirements

- The header MUST show: connection status `<Badge>` (colored dot), current thread name, view switcher (chat/voice/dashboard), thread drawer toggle `<IconButton>`, settings `<IconButton>`.
- Connection status MUST use theme tokens: green for connected, red/danger for error/disconnected, muted for connecting.
- The thread name MUST show the primary entity binding when applicable (e.g. "feat-auth" for a branch thread, "Issue #42: Fix login" for an issue thread). When multiple entities are bound, a clickable "+N" indicator MUST expand to show all bound entities.
- The header MUST include a subagent indicator: when subagents are active in the current thread, show a count `<Badge>`.
- View switching MUST update the URL query parameter and render the appropriate view.
- The settings modal MUST support: theme selection (dark/light/ironman/jarvis), audio settings (TTS enabled, voice selection).
- Gateway URL configuration MUST NOT be in the client settings — it's a server config (`agentBackend.openclaw.gatewayUrl`) managed via the Phase 3 config API.

### Files

```
packages/client/src/components/
├── Header.tsx
├── Header.test.ts
├── SettingsModal.tsx
├── SettingsModal.test.ts
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 6 MUST include integration tests covering:

- **Agent backend proxy:** server connects to mock gateway → client sends `chat.send` via WS → server proxies to backend → backend responds with stream → client receives `chat.stream` + `chat.turn`
- **Thread auto-creation:** `worktree.created` bus event → thread created → WS `thread.created` sent to subscribed clients
- **Thread auto-creation:** `issue.created` bus event → issue thread created
- **Event routing:** `issue.updated` event → routed to correct issue thread → WS `thread.event.routed` sent
- **Thread switching:** client sends `chat.session.switch` → server maps to backend session → history loaded → `chat.session.info` sent
- **Message forwarding:** `POST /api/threads/:key/forward` → message delivered to target thread's backend session → `thread.message.forwarded` bus event
- **Voice transcription:** `POST /api/voice/transcribe` with audio → returns text
- **Rate limit:** backend emits `chat.error` with `retryAfterMs` → server forwards to client → client shows countdown
- **Config hot-reload:** change `agentBackend.openclaw.gatewayUrl` → backend reconnects to new URL
- **Backend disconnection:** mock gateway closes → server emits `backend.status: disconnected` → clients notified → reconnection → `backend.status: connected`

### Dependencies (New)

**Client:**

- `marked` (or equivalent) — markdown → HTML rendering
- `highlight.js` — syntax highlighting for code blocks

**Server:**

- `@noble/ed25519` — Ed25519 keypair for device identity (moved from client to server, since auth is server-side now)

### Module Registration

Server-side modules follow the established pattern:

```typescript
// Agent backend
createOpenClawBackend(config: OpenClawConfig): AgentBackend

// Chat module
createChatModule(bus: EventBus, backend: AgentBackend, threadManager: ThreadManager): ChatModule

// Thread manager
createThreadManager(bus: EventBus, dataDir: string, deps: ThreadDeps): ThreadManager

// Voice module
createVoiceModule(bus: EventBus, config: VoiceConfig): VoiceModule
```

Each exports `status(): ModuleStatus`.

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1–5 directories)
├── threads/
│   └── registry.json          # Thread registry (key → entity binding, metadata)
├── agent-backend/
│   └── device-identity.json   # Ed25519 keypair for backend auth
```

### Config Schema Addition

```typescript
// Added to Phase 3 config schema
agentBackend: {
  provider: 'openclaw'
  openclaw: {
    gatewayUrl: string           // required
    reconnect: {
      initialDelayMs: number     // default 1000
      maxDelayMs: number         // default 30000
    }
  }
}
voice: {
  transcribeUrl?: string         // external transcription service URL (e.g. Whisper)
  ttsUrl?: string                // external TTS service URL (e.g. Kokoro)
}
```

### Testing

- **Client tests:** Vitest with `environment: 'node'`. Mock Phase 3 WS store. Test reactive signal updates, message parsing, theme token application, markdown rendering.
- **Server tests:** Mock `AgentBackend` for chat module tests. Mock bus for thread router tests. Mock `execFile` for voice module tests.
- **Integration tests** in `packages/server/src/__integration__/phase6.test.ts`.
