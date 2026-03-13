# Phase 6: Chat & Voice — Specification

**Status:** Draft **Revision:** 3 **Date:** 2026-03-13

This document specifies the Chat & Voice modules of Phase 6. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 6 depends on Phase 3 (WebSocket protocol, config) and uses the thread/notification infrastructure from Phase 1. This phase builds Sovereign's primary interaction surface — chat, voice, threads, and dashboard — with the same visual design and UX as the existing voice-ui.

---

## Design Philosophy

**Port, don't rewrite.** The voice-ui chat interface is production-tested and well-understood. Phase 6 ports its UX into Sovereign's client package with the same visual design, interactions, and behaviour. The codebase is adapted to Sovereign's architecture (event bus, WS protocol, config module) but the UX MUST remain identical.

**Agent backend abstraction.** The client MUST NOT know about OpenClaw. All agent communication flows through Sovereign's server, which defines its own API contracts for chat, sessions, and agent status. The server implements these contracts using an `AgentBackend` interface — with OpenClaw as the initial (and only) implementation. Phase 8 (Agent Core) adds a native implementation. The swap is a server-side concern; the client never changes.

**Server-side proxy.** The Sovereign server maintains persistent WebSocket connections to the agent backend (OpenClaw gateway). The client connects only to Sovereign's WS (Phase 3 protocol). Chat messages, session management, and agent events all flow through the server. This gives the server full visibility for thread routing, event injection, message forwarding, and future autonomous operations.

**Entity-bound threads.** Every thread is associated with one or more git entities (branch, issue, PR/patch). Events from any bound entity route into the thread automatically. The 'main' thread and user-created bespoke threads are global (no entity binding).

**Inline Tailwind, not CSS classes.** All styling MUST use Tailwind utility classes inline on components (or extracted into reusable SolidJS components), NOT custom CSS classes. The only CSS file is for theme token definitions (CSS custom properties on `:root` / `.light` / `.ironman` / `.jarvis`), keyframe animations, scrollbar styling, and the minimal set of pseudo-element rules that Tailwind cannot express. Everything else is Tailwind.

**Co-located feature modules.** Each feature is a self-contained directory with its own components, store, types, and tests. No flat `components/`, `stores/`, `lib/` top-level directories. Shared primitives live in `ui/` (design system) and `lib/` (utilities). Features import from `ui/` and `lib/` but MUST NOT import from each other — cross-feature coordination flows through the WS protocol (server as source of truth).

---

## Client Module Structure

```
packages/client/src/
├── app.css                       # Theme tokens, @font-face, @keyframes, scrollbar ONLY
├── App.tsx                       # Root component — composes feature shells
├── tailwind.config.ts            # Extended animations, colors referencing CSS vars
├── fonts/
│   └── orbitron.woff2
│
├── ui/                           # Design system — shared primitive components
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── Chip.tsx
│   ├── IconButton.tsx
│   ├── Spinner.tsx
│   ├── Tooltip.tsx
│   ├── Modal.tsx
│   ├── index.ts                  # Barrel export
│   └── ui.test.ts
│
├── lib/                          # Shared utilities (no components, no state)
│   ├── markdown.ts               # Markdown → HTML rendering
│   ├── markdown.test.ts
│   ├── export.ts                 # Message export (markdown, PDF, text)
│   ├── export.test.ts
│   └── format.ts                 # Timestamp formatting, relative time, etc.
│
├── features/
│   ├── connection/               # Backend connection status
│   │   ├── store.ts              # connectionStatus, statusText signals
│   │   ├── store.test.ts
│   │   └── ConnectionBadge.tsx   # Colored dot indicator
│   │
│   ├── chat/                     # Chat conversation
│   │   ├── store.ts              # turns, streamingHtml, agentStatus, liveWork, retry
│   │   ├── store.test.ts
│   │   ├── ChatView.tsx          # Main scrollable chat view
│   │   ├── ChatView.test.ts
│   │   ├── MessageBubble.tsx     # Individual message rendering
│   │   ├── MessageBubble.test.ts
│   │   ├── MarkdownContent.tsx   # Renders markdown with Tailwind-styled elements
│   │   ├── MarkdownContent.test.ts
│   │   ├── WorkSection.tsx       # Tool calls, thinking blocks, system events
│   │   ├── WorkSection.test.ts
│   │   ├── InputArea.tsx         # Text input, file attachments, recording trigger
│   │   ├── InputArea.test.ts
│   │   └── types.ts             # Chat-specific client types (if any beyond core)
│   │
│   ├── threads/                  # Thread management
│   │   ├── store.ts              # threadKey, threads[], switchThread, createThread
│   │   ├── store.test.ts
│   │   ├── ThreadDrawer.tsx      # Slide-out thread list
│   │   ├── ThreadDrawer.test.ts
│   │   ├── ForwardDialog.tsx     # Thread picker + commentary for message forwarding
│   │   ├── ForwardDialog.test.ts
│   │   ├── helpers.ts           # Display names, entity icons, thread grouping
│   │   └── helpers.test.ts
│   │
│   ├── voice/                    # Voice recording + TTS playback
│   │   ├── store.ts              # voiceState, isRecording, recording timer
│   │   ├── store.test.ts
│   │   ├── VoiceView.tsx         # Full-screen push-to-talk
│   │   ├── VoiceView.test.ts
│   │   ├── RecordingView.tsx     # Past recordings list
│   │   ├── RecordingView.test.ts
│   │   ├── audio.ts             # MediaRecorder, TTS playback, audio unlock
│   │   └── audio.test.ts
│   │
│   ├── dashboard/                # Global context home screen
│   │   ├── DashboardView.tsx     # Activity feed, health, threads, notifications
│   │   ├── DashboardView.test.ts
│   │   ├── ActivityFeed.tsx      # Workspace events stream
│   │   ├── HealthPanel.tsx       # Connection + service health
│   │   └── ThreadQuickSwitch.tsx # Recent threads for fast navigation
│   │
│   ├── nav/                      # Header + navigation + settings
│   │   ├── store.ts              # viewMode, drawerOpen, settingsOpen
│   │   ├── store.test.ts
│   │   ├── Header.tsx
│   │   ├── Header.test.ts
│   │   ├── SettingsModal.tsx     # Theme, audio settings
│   │   └── SettingsModal.test.ts
│   │
│   └── theme/                    # Theme management
│       ├── store.ts              # currentTheme, setTheme, auto-detect
│       ├── store.test.ts
│       └── themes.ts             # Theme definitions, localStorage persistence
```

### Module Rules

- Each `features/*` module MUST be self-contained: its own store, components, helpers, types, and tests.
- Features MUST NOT import from other features. Cross-feature data flows through:
  1. The WS protocol (server as source of truth) — each store subscribes to its own WS channels
  2. Explicit prop passing in `App.tsx` (e.g. `<ChatView threadKey={threadStore.threadKey} />`)
  3. Shared primitives from `ui/` and `lib/`
- `ui/` components MUST be stateless and generic — they know nothing about chat, threads, or voice.
- `lib/` utilities MUST be pure functions — no state, no signals, no side effects.
- Each store MUST be independently testable with a mocked WS connection.
- The one cross-feature read dependency: the chat store takes `threadKey: Accessor<string>` as an init parameter (from the thread store). This is a function reference, not an import of the thread store.

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
  'chat.stream': { sessionKey: string; text: string }
  'chat.turn': { sessionKey: string; turn: ParsedTurn }
  'chat.status': { sessionKey: string; status: AgentStatus }
  'chat.work': { sessionKey: string; work: WorkItem }
  'chat.compacting': { sessionKey: string; active: boolean }
  'chat.error': { sessionKey: string; error: string; retryAfterMs?: number }
  'session.info': { sessionKey: string; label?: string; history: ParsedTurn[] }
  'backend.status': { status: BackendConnectionStatus }
}

export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface AgentBackend {
  connect(): Promise<void>
  disconnect(): Promise<void>
  status(): BackendConnectionStatus
  sendMessage(sessionKey: string, text: string, attachments?: Buffer[]): Promise<void>
  abort(sessionKey: string): Promise<void>
  switchSession(sessionKey: string): Promise<void>
  createSession(label?: string): Promise<string>
  getHistory(sessionKey: string): Promise<ParsedTurn[]>
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
}
```

### OpenClaw Implementation

```typescript
// packages/server/src/agent-backend/openclaw.ts

export function createOpenClawBackend(config: OpenClawConfig): AgentBackend
export interface OpenClawConfig {
  gatewayUrl: string
  deviceKeyPath?: string
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number; jitter?: boolean }
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

- `chat.stream` — `{ text: string }`
- `chat.turn` — `{ turn: ParsedTurn }`
- `chat.status` — `{ status: AgentStatus }`
- `chat.work` — `{ work: WorkItem }`
- `chat.compacting` — `{ active: boolean }`
- `chat.error` — `{ error: string, retryAfterMs?: number }`
- `chat.session.info` — `{ threadKey: string, label?: string, history: ParsedTurn[] }`

Scoping: clients subscribe to `chat` scoped by `{ threadKey }`.

---

## Wave Strategy

**Wave 1 (parallel):** Theme module, Agent Backend + OpenClaw impl, Chat module (server), Client stores (connection, chat, thread, nav, theme) **Wave 2 (after wave 1):** Chat feature (ChatView, MessageBubble, MarkdownContent, WorkSection, InputArea) **Wave 3 (after wave 2):** Threads feature (ThreadDrawer, ForwardDialog), Header/Nav feature **Wave 4 (after wave 3):** Voice feature (VoiceView, RecordingView, audio lib), Dashboard feature **Wave 5:** Integration tests

---

## 1. Theme Module

Port the voice-ui's visual identity into Sovereign. This is both a client feature module (`features/theme/`) and the CSS foundation.

### Requirements

- The client MUST define CSS custom properties (`--c-*` tokens) for all theme values: backgrounds, borders, text, accents, code, hover states, scrollbar, overlays, chat-specific, work section, blockquote — exactly matching the voice-ui token set.
- The client MUST support four themes: `default` (dark), `light`, `ironman` (blue HUD with Orbitron font), `jarvis` (orange HUD with Orbitron font).
- Themes MUST be activated by CSS class on `<html>`: no class = dark (default), `.light`, `.ironman`, `.jarvis`.
- The Orbitron font MUST be included (`/fonts/orbitron.woff2`, weight 400–700) for HUD themes.
- The `--c-font` property MUST switch between the system font stack (dark/light) and Orbitron (ironman/jarvis).
- All component styling MUST use **inline Tailwind utility classes** referencing theme tokens via `style={{ background: 'var(--c-bg-raised)' }}` or Tailwind arbitrary values `bg-[var(--c-bg-raised)]`.
- `app.css` MUST contain ONLY: CSS custom property definitions, `@font-face`, `@keyframes`, scrollbar styling, pseudo-element rules Tailwind cannot express, safe area `@supports`.
- Keyframe animations MUST be registered in `tailwind.config.ts` `extend.animation`.
- The theme store (`features/theme/store.ts`) MUST persist the selected theme to `localStorage` key `sovereign:theme` and restore on load.
- The theme store SHOULD support `prefers-color-scheme` for auto dark/light when no theme is explicitly selected.

### UI Design System (`ui/`)

Reusable primitive components, stateless and generic:

- `<Card>` — raised background, border, rounded corners
- `<Badge>` — small label with accent background
- `<Chip>` — monospace text chip with icon and hover accent border
- `<IconButton>` — icon-only button with hover/active states
- `<Spinner>` — loading indicator
- `<Tooltip>` — hover tooltip
- `<Modal>` — overlay dialog with backdrop

---

## 2. Agent Backend Abstraction

Server-side abstraction over the agent runtime.

### Requirements

#### 2.1 Interface

- The `AgentBackend` interface MUST be defined in `@template/core`.
- All shared types (`ParsedTurn`, `WorkItem`, `AgentStatus`, `BackendConnectionStatus`, `ForwardedMessage`) MUST be in `@template/core`.

#### 2.2 OpenClaw Implementation

- MUST establish a WebSocket connection to the OpenClaw gateway.
- MUST implement Ed25519 device identity auth (keypair at `{dataDir}/agent-backend/device-identity.json`).
- MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- MUST translate OpenClaw gateway protocol → `AgentBackend` events.
- MUST strip thinking blocks from streamed text (preserve code blocks).
- MUST handle rate-limit responses: emit `chat.error` with `retryAfterMs`, auto-retry.
- MUST support gateway's device pairing flow.
- Gateway URL configurable via `agentBackend.openclaw.gatewayUrl` (hot-reloadable).
- MUST reload conversation history on agent idle transition (debounced).

#### 2.3 Chat Module (Server)

- MUST register WS channel `chat` on the Phase 3 WS protocol.
- MUST proxy client WS messages → `AgentBackend` methods.
- MUST proxy `AgentBackend` events → subscribed clients via WS (scoped by `{ threadKey }`).
- MUST emit bus events: `chat.message.sent`, `chat.turn.completed`.
- MUST maintain thread key ↔ backend session key mapping.

### REST API

- `GET /api/chat/status` — agent backend connection status
- `POST /api/chat/sessions` — create a new session

### Config Schema

```typescript
agentBackend: {
  provider: 'openclaw'
  openclaw: {
    gatewayUrl: string
    reconnect: { initialDelayMs: number; maxDelayMs: number }
  }
}
voice: {
  transcribeUrl?: string
  ttsUrl?: string
}
```

### Server Files

```
packages/core/src/
├── agent-backend.ts              # Interface + shared types

packages/server/src/agent-backend/
├── types.ts
├── openclaw.ts
├── openclaw.test.ts
├── thinking.ts                   # Thinking block stripping utility
├── thinking.test.ts

packages/server/src/chat/
├── chat.ts                       # Chat module — WS proxy + bus integration
├── chat.test.ts
├── routes.ts
├── ws.ts
├── ws.test.ts
```

---

## 3. Client Feature Stores

Each feature module contains its own store. Stores are self-contained, subscribe to their own WS channels, and expose only what their feature's components need.

### 3.1 Connection Store (`features/connection/store.ts`)

- Exposes: `connectionStatus`, `statusText`.
- Subscribes to `chat` WS channel for `backend.status` messages.

### 3.2 Chat Store (`features/chat/store.ts`)

- Exposes: `turns`, `streamingHtml`, `agentStatus`, `liveWork`, `liveThinkingText`, `compacting`, retry state, `sendMessage()`, `abortChat()`.
- Subscribes to `chat` WS channel (scoped by threadKey).
- Init: `initChatStore(threadKey: Accessor<string>)` — takes threadKey accessor from thread store.
- Resets and loads history on thread change.

### 3.3 Thread Store (`features/threads/store.ts`)

- Exposes: `threadKey`, `threads: ThreadInfo[]`, `switchThread()`, `createThread()`, `addEntity()`, `removeEntity()`.
- `threadKey` syncs with URL hash; initial from hash or `'main'`.
- Subscribes to `threads` WS channel.
- Fetches thread list on init via REST.

### 3.4 Voice Store (`features/voice/store.ts`)

- Exposes: `voiceState`, `isRecording`, `recordingTimerText`, `voiceStatusText`, `startRecording()`, `stopRecording()`, `interruptPlayback()`.
- Self-contained: manages MediaRecorder, audio chunks, timer intervals.

### 3.5 Nav Store (`features/nav/store.ts`)

- Exposes: `viewMode`, `setViewMode()`, `drawerOpen`, `setDrawerOpen()`, `settingsOpen`, `setSettingsOpen()`.
- `viewMode` syncs with URL query parameter `?view=`.

### 3.6 Theme Store (`features/theme/store.ts`)

- Exposes: `currentTheme`, `setTheme()`.
- Persists to `localStorage`, restores on load.
- Applies CSS class on `<html>`.

### Store Principles

- Each store is a standalone module — no circular imports between stores.
- Cross-store coordination flows through WS (server as source of truth) or prop passing in `App.tsx`.
- One exception: chat store takes `threadKey: Accessor<string>` at init (function reference, not import).
- Each store independently testable with mocked WS.

---

## 4. Chat Feature

The primary conversation view. Components and store co-located in `features/chat/`.

### Requirements

#### 4.1 ChatView

- Renders conversation turns as a scrollable list.
- Auto-scrolls to bottom on new messages/streaming — UNLESS user has scrolled up (80px threshold).
- "Scroll to bottom" button when user has scrolled up.
- Double-`requestAnimationFrame` for scroll-after-render.
- Streaming indicator (pulsing dots via Tailwind animation).
- Compaction indicator. Rate-limit retry countdown.

#### 4.2 MessageBubble

- User: right-aligned, `var(--c-user-bubble)` background.
- Assistant: left-aligned, full-width markdown via `<MarkdownContent>`.
- System: muted, centered/indented.
- Timestamp display. Context menu (copy, markdown, PDF, forward).
- Copy button on hover (`group-hover:opacity-*`).
- Pending messages: `opacity-50`.

#### 4.3 MarkdownContent

- Renders markdown HTML with Tailwind-styled elements.
- Code blocks with copy buttons (`<IconButton>`).
- Inline code with hover copy.
- Headings, lists, blockquotes, tables, links, strong, em, hr.

#### 4.4 WorkSection

- Collapsible intermediate activity between user message and assistant response.
- Tool calls paired with results (by `toolCallId`).
- Tool icons: 📖 read, ✏️ write, ✂️ edit, ▶ exec, ⚙ process, 🌐 browser, etc.
- Collapsible inputs/results. Collapsible thinking blocks.
- Whole section collapsible (default collapsed when turn complete).

#### 4.5 InputArea

- Multi-line auto-resize. Enter to send, Shift+Enter for newline.
- File attachments: drag-and-drop, paste, file picker. Shown as `<Chip>`.
- Voice recording trigger: mic `<IconButton>`, pulsing timer.
- Send/abort `<IconButton>`. Disabled send when empty.
- Message history: Up/Down arrows (per-thread, `localStorage`).
- Scratchpad: auto-save to `localStorage` per thread.
- Fixed bottom, safe-area padding.
- Inline agent status ("Working…", "Thinking…").

---

## 5. Thread Feature

Entity-bound thread management. Co-located in `features/threads/`.

### Requirements

#### 5.1 Thread Model

- Identity: `{ threadKey: string, entities: EntityBinding[], label?: string }`.
- `entities` array: empty (global), one (typical), or many (cross-cutting).
- `EntityBinding`: `{ orgId, projectId, entityType: 'branch' | 'issue' | 'pr', entityRef }`.
- Thread key format: `{orgId}/{projectId}/{entityType}:{entityRef}` (primary entity, immutable).
- Global keys: `main` or user labels.
- Add/remove entities via REST. Auto-associate related entities (PR→issue, branch→issue).
- Persist to `{dataDir}/threads/registry.json` (atomic).

#### 5.2 Event Routing (Server)

- Route events to **all** threads containing the matching entity.
- AGENT events → send to `AgentBackend` session for that thread.
- NOTIFY events → Phase 1 notification system.
- Auto-create threads for entities with no thread.

#### 5.3 ThreadDrawer

- Slide-in from left. Grouped: Global + per-workspace (`orgId/projectId`).
- Entry: display name, entity icon, last activity, unread badge.
- Actions: switch, create, hide/unhide. Hidden threads in `localStorage`.
- Subagent sessions shown under parent thread.
- Display name from primary entity; "+N" for additional entities.

#### 5.4 ForwardDialog

- Thread picker + commentary input + search/filter.
- Forwarded message: preserves content, author, timestamp, source thread.
- Visually distinct in target thread: "forwarded from" header.
- Via REST: `POST /api/threads/:key/forward`.
- Bus event: `thread.message.forwarded`.

#### 5.5 Thread Helpers (`helpers.ts`)

- Display name derivation. Entity type icons. Thread grouping logic. Relative time.

### Thread REST API

- `GET /api/threads` — list all threads with status
- `GET /api/threads/:key` — get thread details + entities
- `POST /api/threads` — create a global thread
- `DELETE /api/threads/:key` — archive/hide a thread
- `POST /api/threads/:key/entities` — add entity binding
- `DELETE /api/threads/:key/entities/:entityType/:entityRef` — remove entity
- `POST /api/threads/:key/forward` — forward a message
- `GET /api/threads/:key/events` — list routed events

### Thread WS Channel: `threads`

Server → Client: `thread.created`, `thread.updated`, `thread.event.routed`, `thread.status` Scoped by: `{ orgId?, projectId? }` or unscoped.

### Bus Events

`thread.created`, `thread.archived`, `thread.event.routed`, `thread.message.forwarded`

### Server Files

```
packages/server/src/threads/
├── types.ts
├── router.ts
├── router.test.ts
├── threads.ts
├── threads.test.ts
├── forward.ts
├── forward.test.ts
├── ws.ts
├── ws.test.ts
├── routes.ts
```

---

## 6. Voice Feature

Push-to-talk recording and TTS playback. Co-located in `features/voice/`.

### Requirements

- Full-screen push-to-talk: large button, status text, timer.
- `MediaRecorder` with `audio/webm;codecs=opus` (fallback `audio/webm`).
- On stop: send audio to server transcription → text as chat message.
- TTS: agent response → server TTS endpoint → audio playback.
- Server REST: `POST /api/voice/transcribe`, `POST /api/voice/tts`.
- Audio unlock for mobile (iOS Safari gesture requirement).
- State transitions: idle → listening → processing → speaking → idle.
- Visual feedback per state: tap prompt, pulsing mic, spinner, pulsing speaker.
- Interrupt: tap while speaking → stop audio → idle.
- RecordingView: past recordings with playback, export, delete.

### Server Files

```
packages/server/src/voice/
├── voice.ts
├── voice.test.ts
├── routes.ts
```

---

## 7. Dashboard Feature

Global context home screen. Co-located in `features/dashboard/`.

### Requirements

- Default view for global threads (main, bespoke).
- Shows: clock, system health, workspace activity feed, notifications (grouped by thread), active agents, thread quick-switch.
- Auto-refresh via WS subscriptions (`status`, `notifications`, `threads`).
- Activity feed entries link to entity-bound threads.
- Notifications: NOTIFY events with action prompt, click → jump to thread.
- Optional: weather, planning summary (Phase 5).

### Sub-components

- `ActivityFeed.tsx` — workspace events stream
- `HealthPanel.tsx` — connection + service health
- `ThreadQuickSwitch.tsx` — recent threads for fast navigation

---

## 8. Nav Feature

Header, navigation, settings. Co-located in `features/nav/`.

### Requirements

- Header: `<ConnectionBadge>`, thread name, view switcher, drawer toggle, settings button.
- Thread name shows primary entity; "+N" for multi-entity threads.
- Subagent count badge when active.
- View switching → URL query param.
- SettingsModal: theme selection, audio settings. NO gateway URL config (that's server-side).

---

## Cross-Cutting Concerns

### Integration Tests

Phase 6 MUST include integration tests covering:

- **Agent backend proxy:** server ↔ mock gateway ↔ client full round-trip
- **Thread auto-creation:** entity bus events → thread created → WS notification
- **Event routing:** entity events → correct thread(s)
- **Thread switching:** client → server session map → history loaded
- **Multi-entity threads:** add entity → events from both entities route to same thread
- **Message forwarding:** REST forward → target thread → bus event
- **Voice transcription:** POST audio → text response
- **Rate limit:** backend error → server → client countdown → auto-retry
- **Config hot-reload:** gateway URL change → backend reconnects
- **Backend disconnection:** gateway drops → reconnect → clients notified

### Dependencies (New)

**Client:** `marked`, `highlight.js` **Server:** `@noble/ed25519`

### Module Registration (Server)

```typescript
createOpenClawBackend(config: OpenClawConfig): AgentBackend
createChatModule(bus: EventBus, backend: AgentBackend, threadManager: ThreadManager): ChatModule
createThreadManager(bus: EventBus, dataDir: string, deps: ThreadDeps): ThreadManager
createVoiceModule(bus: EventBus, config: VoiceConfig): VoiceModule
```

Each exports `status(): ModuleStatus`.

### Data Directory Extension

```
{dataDir}/
├── threads/registry.json
├── agent-backend/device-identity.json
```

### Testing

- **Client feature tests:** Vitest `environment: 'node'`. Each feature's store tested with mocked WS. Components tested for signal reactivity and rendering logic.
- **Server tests:** Mock `AgentBackend` for chat. Mock bus for thread router. Mock exec for voice.
- **Integration:** `packages/server/src/__integration__/phase6.test.ts`.
