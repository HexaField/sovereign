# Phase 6: Chat & Voice — Specification

**Status:** Draft **Revision:** 4 **Date:** 2026-03-13

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
│   │   ├── store.ts
│   │   ├── store.test.ts
│   │   └── ConnectionBadge.tsx
│   │
│   ├── chat/                     # Chat conversation
│   │   ├── store.ts
│   │   ├── store.test.ts
│   │   ├── ChatView.tsx
│   │   ├── ChatView.test.ts
│   │   ├── MessageBubble.tsx
│   │   ├── MessageBubble.test.ts
│   │   ├── MarkdownContent.tsx
│   │   ├── MarkdownContent.test.ts
│   │   ├── WorkSection.tsx
│   │   ├── WorkSection.test.ts
│   │   ├── InputArea.tsx
│   │   ├── InputArea.test.ts
│   │   └── types.ts
│   │
│   ├── threads/                  # Thread management
│   │   ├── store.ts
│   │   ├── store.test.ts
│   │   ├── ThreadDrawer.tsx
│   │   ├── ThreadDrawer.test.ts
│   │   ├── ForwardDialog.tsx
│   │   ├── ForwardDialog.test.ts
│   │   ├── helpers.ts
│   │   └── helpers.test.ts
│   │
│   ├── voice/                    # Voice recording + TTS playback
│   │   ├── store.ts
│   │   ├── store.test.ts
│   │   ├── VoiceView.tsx
│   │   ├── VoiceView.test.ts
│   │   ├── RecordingView.tsx
│   │   ├── RecordingView.test.ts
│   │   ├── audio.ts
│   │   └── audio.test.ts
│   │
│   ├── dashboard/                # Global context home screen
│   │   ├── DashboardView.tsx
│   │   ├── DashboardView.test.ts
│   │   ├── ActivityFeed.tsx
│   │   ├── HealthPanel.tsx
│   │   └── ThreadQuickSwitch.tsx
│   │
│   ├── nav/                      # Header + navigation + settings
│   │   ├── store.ts
│   │   ├── store.test.ts
│   │   ├── Header.tsx
│   │   ├── Header.test.ts
│   │   ├── SettingsModal.tsx
│   │   └── SettingsModal.test.ts
│   │
│   └── theme/                    # Theme management
│       ├── store.ts
│       ├── store.test.ts
│       └── themes.ts
```

### Module Rules

- Each `features/*` module MUST be self-contained: its own store, components, helpers, types, and tests.
- Features MUST NOT import from other features. Cross-feature data flows through:
  1. The WS protocol (server as source of truth) — each store subscribes to its own WS channels.
  2. Explicit prop passing in `App.tsx` (e.g. `<ChatView threadKey={threadStore.threadKey} />`).
  3. Shared primitives from `ui/` and `lib/`.
- `ui/` components MUST be stateless and generic — they MUST NOT know about chat, threads, voice, or any feature domain.
- `lib/` utilities MUST be pure functions — no state, no signals, no side effects.
- Each store MUST be independently testable with a mocked WS connection.
- The one cross-feature read dependency: the chat store takes `threadKey: Accessor<string>` as an init parameter (from the thread store). This is a function reference, not an import of the thread store module.

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

export function createOpenClawBackend(config: OpenClawConfig): AgentBackend

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

### ForwardedMessage Interface

```typescript
// packages/core/src/agent-backend.ts

export interface ForwardedMessage {
  /** Original message content (markdown) */
  originalContent: string
  /** Who sent the original message */
  originalRole: 'user' | 'assistant' | 'system'
  /** Unix timestamp of the original message */
  originalTimestamp: number
  /** Thread key where the message originated */
  sourceThread: string
  /** Human-readable source thread label */
  sourceThreadLabel: string
  /** Optional commentary added by the user when forwarding */
  commentary?: string
  /** File attachments from the original message */
  attachments?: string[]
}
```

---

## Wave Strategy

**Wave 1 (parallel):** Theme module, Agent Backend + OpenClaw impl, Chat module (server), Client stores (connection, chat, thread, nav, theme) **Wave 2 (after wave 1):** Chat feature (ChatView, MessageBubble, MarkdownContent, WorkSection, InputArea) **Wave 3 (after wave 2):** Threads feature (ThreadDrawer, ForwardDialog), Header/Nav feature **Wave 4 (after wave 3):** Voice feature (VoiceView, RecordingView, audio lib), Dashboard feature **Wave 5:** Integration tests

---

## 1. Theme Module

Port the voice-ui's visual identity into Sovereign. This is both a client feature module (`features/theme/`) and the CSS foundation.

### Requirements

#### 1.1 CSS Custom Properties

- The client MUST define CSS custom properties (`--c-*` tokens) for all theme values: backgrounds (`bg`, `bg-raised`, `bg-overlay`), borders (`border`, `border-subtle`, `border-strong`), text (`text`, `text-muted`, `text-heading`), accents (`accent`, `danger`, `amber`), code (`code-text`, `code-bg`, `pre-bg`), hover states (`hover-bg`, `hover-bg-strong`, `active-bg`), scrollbar (`scrollbar-thumb`, `scrollbar-hover`), overlays (`backdrop`, `overlay-bg`, `menu-bg`), chat-specific (`user-bubble`, `user-bubble-text`, `badge-count`), work section (`step-bg`, `step-badge-bg`, `work-body-bg`, `work-border`), blockquote — exactly matching the voice-ui token set.
- The client MUST support four themes: `default` (dark), `light`, `ironman` (blue HUD with Orbitron font), `jarvis` (orange HUD with Orbitron font).
- Themes MUST be activated by CSS class on `<html>`: no class = dark (default), `.light`, `.ironman`, `.jarvis`.
- The `--c-font` property MUST switch between the system font stack (dark/light themes) and Orbitron (ironman/jarvis themes).

#### 1.2 Fonts

- The Orbitron font MUST be included at `/fonts/orbitron.woff2` with weight range 400–700 for HUD themes.
- The `@font-face` declaration MUST be in `app.css` and use `font-display: swap`.

#### 1.3 Styling Rules

- All component styling MUST use **inline Tailwind utility classes** referencing theme tokens via `style={{ background: 'var(--c-bg-raised)' }}` or Tailwind's arbitrary value syntax (e.g. `bg-[var(--c-bg-raised)]`).
- Reusable visual patterns MUST be extracted into SolidJS components (e.g. `<Card>`, `<Badge>`, `<Chip>`, `<IconButton>`) rather than CSS utility classes.
- `app.css` MUST contain ONLY:
  1. CSS custom property definitions (`:root`, `.light`, `.ironman`, `.jarvis`).
  2. `@font-face` for Orbitron.
  3. `@keyframes` for animations (`mic-pulse`, `voice-pulse`, `speak-pulse`, `pulse-dots`, `march`, `warning-pulse`).
  4. Scrollbar styling (`::-webkit-scrollbar*`).
  5. The minimal set of pseudo-element rules Tailwind cannot express (e.g. `.streaming-dots > div > :last-child::after`).
  6. Safe area `@supports` rules for mobile notch/home indicator padding.
- `app.css` MUST NOT contain any layout, sizing, spacing, or color rules that Tailwind can express.
- Keyframe-dependent animation utilities MUST be defined in `tailwind.config.ts` under `extend.animation` and `extend.keyframes` rather than as custom CSS classes.

#### 1.4 Theme Store

- The theme store (`features/theme/store.ts`) MUST expose `currentTheme: Accessor<Theme>` and `setTheme(theme: Theme): void`.
- The theme store MUST persist the selected theme to `localStorage` key `sovereign:theme` and restore it on load.
- The theme store MUST apply the selected theme by setting the CSS class on `document.documentElement` (`<html>`).
- The theme store SHOULD support `prefers-color-scheme` media query for automatic dark/light selection when no theme is explicitly selected by the user.
- The `Theme` type MUST be: `'default' | 'light' | 'ironman' | 'jarvis'`.

#### 1.5 UI Design System (`ui/`)

The following reusable primitive components MUST be created. All MUST be stateless, generic, and domain-agnostic:

- `<Card>` — MUST render a container with `var(--c-bg-raised)` background, `var(--c-border)` border, and rounded corners. MUST accept `children` and optional `class` prop for layout overrides.
- `<Badge>` — MUST render a small inline label with accent background. MUST accept `count?: number` and `variant?: 'accent' | 'danger' | 'muted'`. MUST hide when `count` is 0 or undefined.
- `<Chip>` — MUST render a monospace text chip with optional leading icon and `var(--c-border)` border. MUST show `var(--c-accent)` border on hover. MUST accept `label: string`, `icon?: JSX.Element`, `onRemove?: () => void`.
- `<IconButton>` — MUST render an icon-only button with `var(--c-hover-bg)` background on hover and `var(--c-active-bg)` on active. MUST accept `icon: JSX.Element`, `onClick`, `disabled?: boolean`, `title?: string` (for accessibility). MUST include `aria-label` derived from `title`.
- `<Spinner>` — MUST render a CSS-animated loading indicator using theme accent color.
- `<Tooltip>` — MUST render a hover-triggered tooltip positioned above or below the target element. MUST accept `text: string`, `position?: 'top' | 'bottom'`, `children`.
- `<Modal>` — MUST render an overlay dialog with `var(--c-backdrop)` background, centered content panel with `var(--c-overlay-bg)` background. MUST accept `open: Accessor<boolean>`, `onClose: () => void`, `title?: string`, `children`. MUST trap focus inside the modal when open. MUST close on Escape key and backdrop click.

### Files

```
packages/client/src/
├── app.css
├── fonts/orbitron.woff2
├── tailwind.config.ts
├── ui/
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── Chip.tsx
│   ├── IconButton.tsx
│   ├── Spinner.tsx
│   ├── Tooltip.tsx
│   ├── Modal.tsx
│   ├── index.ts
│   └── ui.test.ts
├── features/theme/
│   ├── store.ts
│   ├── store.test.ts
│   └── themes.ts
```

---

## 2. Agent Backend Abstraction

Server-side abstraction over the agent runtime. The client never touches this directly.

### Requirements

#### 2.1 Interface (`@template/core`)

- The `AgentBackend` interface MUST be defined in `@template/core` (shared types package).
- The interface MUST support the following methods: `connect()`, `disconnect()`, `status()`, `sendMessage()`, `abort()`, `switchSession()`, `createSession()`, `getHistory()`.
- The interface MUST support typed event subscription: `on(event, handler)`, `off(event, handler)`.
- Events MUST include: `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `session.info`, `backend.status` — as defined in the `AgentBackendEvents` interface above.
- All shared types MUST be defined in `@template/core`:
  - `ParsedTurn` — a complete conversation turn with role, content, timestamp, work items, thinking blocks.
  - `WorkItem` — a single unit of agent work: `{ type: 'tool_call' | 'tool_result' | 'thinking' | 'system_event', toolCallId?: string, name?: string, input?: string, output?: string, icon?: string, timestamp: number }`.
  - `AgentStatus` — `'idle' | 'working' | 'thinking'`.
  - `BackendConnectionStatus` — `'connecting' | 'connected' | 'disconnected' | 'error'`.
  - `ForwardedMessage` — as defined in the Architecture section above.

#### 2.2 OpenClaw Implementation

- The OpenClaw backend MUST establish a WebSocket connection to the OpenClaw gateway URL specified in config.
- The backend MUST implement a challenge-response WebSocket handshake:
  - On WS open, the backend MUST wait for a `connect.challenge` event from the gateway containing a `nonce`.
  - The backend MUST sign a v2 payload with the device private key: `v2|{deviceId}|openclaw-control-ui|webchat|operator|{scopes}|{signedAt}|{token}|{nonce}`.
  - Signatures MUST be base64url-encoded (not hex).
  - The backend MUST send a `connect` RPC with params: `{ minProtocol: 3, maxProtocol: 3, client: { id, version, platform, mode }, role: 'operator', scopes, device: { id, publicKey, signature, signedAt, nonce }, auth: { token }, userAgent, caps }`.
  - `deriveDeviceId(publicKeyHex)` = sha256 of public key bytes as hex.
  - `publicKeyBase64Url(publicKeyHex)` = public key bytes as base64url.
  - If the connect RPC returns a `deviceToken` in the result, the backend MUST persist it to `{dataDir}/agent-backend/device-token.json`.
  - If the connect RPC is rejected with a pairing-related error, the backend MUST emit `backend.status` with `'error'` and `errorType: 'auth_rejected'`.
- The backend MUST support a `gatewayToken` config option used as a fallback auth token when no stored device token exists.
- The backend MUST implement Ed25519 device identity authentication:
  - The backend MUST generate an Ed25519 keypair on first use and store it to `{dataDir}/agent-backend/device-identity.json`.
  - The backend MUST sign authentication payloads with the device private key.
  - The backend MUST send the device token in the initial WS handshake.
- The backend MUST implement automatic reconnection with exponential backoff:
  - Initial delay MUST default to 1000ms.
  - Maximum delay MUST default to 30000ms.
  - Jitter MUST be applied by default to prevent thundering herd.
  - The backend MUST emit `backend.status` with `'disconnected'` immediately on connection loss.
  - The backend MUST emit `backend.status` with `'connecting'` when a reconnection attempt begins.
  - The backend MUST emit `backend.status` with `'connected'` when reconnection succeeds.
- The backend MUST translate the OpenClaw gateway protocol to `AgentBackend` events:
  - OpenClaw streaming messages → `chat.stream` events.
  - OpenClaw turn completion → `chat.turn` events with a fully parsed `ParsedTurn`.
  - OpenClaw tool call / tool result messages → `chat.work` events.
  - OpenClaw thinking block messages → `chat.work` events with `type: 'thinking'`.
  - OpenClaw status transitions → `chat.status` events.
  - OpenClaw compaction messages → `chat.compacting` events.
  - OpenClaw error messages → `chat.error` events.
- The backend MUST strip thinking blocks from streamed text. Thinking block tags (`<think>`, `<thinking>`, `<thought>`, `<antThinking>` and their closing counterparts) and their content MUST be removed from the `chat.stream` text. Code blocks (` ``` `) MUST be preserved even if they contain thinking-like tags.
- The backend MUST handle rate-limit responses from the gateway:
  - The backend MUST emit `chat.error` with `retryAfterMs` set to the gateway's indicated retry delay.
  - The backend MUST automatically retry the request after the indicated delay.
- The backend MUST support the gateway's device pairing flow:
  - If the device is not yet approved by the gateway, the backend MUST emit `backend.status` with `'error'` and include metadata about the pending pairing request.
  - The backend MUST NOT block or crash when pairing is pending — it MUST continue reconnection attempts.
- The gateway URL MUST be configurable via the Phase 3 config module at path `agentBackend.openclaw.gatewayUrl`.
- The backend MUST support hot-reload: when `agentBackend.openclaw.gatewayUrl` changes via the config module, the backend MUST disconnect from the old URL and reconnect to the new URL without process restart or client disconnection.
- The backend MUST reload conversation history when the agent transitions from working to idle. This reload MUST be debounced (300ms) to avoid unnecessary refetches during rapid state changes. The reloaded history MUST be emitted as a `session.info` event.

#### 2.3 Thinking Block Stripping

- The `thinking.ts` utility MUST export a `stripThinkingBlocks(text: string): string` function.
- The function MUST remove all content between matched thinking tags: `<think>...</think>`, `<thinking>...</thinking>`, `<thought>...</thought>`, `<antThinking>...</antThinking>`.
- The function MUST handle nested thinking tags (take the outermost pair).
- The function MUST handle unclosed thinking tags (strip from the opening tag to the end of the string, as this occurs during streaming).
- The function MUST NOT strip content inside fenced code blocks (triple backtick regions).
- The function MUST handle multiple thinking blocks in a single text.
- The function MUST preserve all whitespace and content outside of thinking blocks.

#### 2.4 Chat Module (Server)

- The chat module MUST register WS channel `chat` on the Phase 3 WS protocol.
- The chat module MUST proxy client WS messages to the `AgentBackend`:
  - `chat.send` → `backend.sendMessage(sessionKey, text, attachments)`.
  - `chat.abort` → `backend.abort(sessionKey)`.
  - `chat.history` → `backend.getHistory(sessionKey)`, respond with `chat.session.info`.
  - `chat.session.switch` → `backend.switchSession(sessionKey)`.
  - `chat.session.create` → `backend.createSession(label)`.
- The chat module MUST proxy `AgentBackend` events to subscribed clients via WS:
  - `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `chat.session.info`.
  - All proxied messages MUST respect Phase 3 WS scoping — a client subscribed to `chat` with scope `{ threadKey: 'main' }` MUST only receive events for the `main` thread.
- The chat module MUST emit bus events for cross-module integration:
  - `chat.message.sent` — MUST be emitted when a user sends a message, with `{ threadKey, text, timestamp }`. Used by thread manager for activity tracking.
  - `chat.turn.completed` — MUST be emitted when the agent completes a turn, with `{ threadKey, turn: ParsedTurn }`. Used by thread manager for status updates.
- The chat module MUST maintain a bidirectional mapping between Sovereign thread keys and backend session keys:
  - When a new thread is created, the chat module MUST create a corresponding backend session via `backend.createSession()`.
  - When a client sends `chat.session.switch`, the chat module MUST look up the backend session key for the given thread key and call `backend.switchSession()`.
  - Multiple Sovereign threads MAY map to different backend sessions.
  - The mapping MUST be persisted to `{dataDir}/chat/session-map.json` (atomic write) so it survives server restarts.

### REST API

- `GET /api/chat/status` — MUST return the agent backend connection status (`BackendConnectionStatus`) and current session info.
- `POST /api/chat/sessions` — MUST create a new backend session and return the assigned thread key + session key.

### Config Schema Addition

```typescript
agentBackend: {
  provider: 'openclaw'  // only option for now; Phase 8 adds 'native'
  openclaw: {
    gatewayUrl: string   // required, e.g. 'wss://localhost:3456/ws'
    reconnect: {
      initialDelayMs: number  // default 1000
      maxDelayMs: number      // default 30000
    }
  }
}
voice: {
  transcribeUrl?: string   // external transcription service URL (e.g. Whisper)
  ttsUrl?: string          // external TTS service URL (e.g. Kokoro)
}
```

### Server Files

```
packages/core/src/
├── agent-backend.ts              # AgentBackend interface, event types, shared types

packages/server/src/agent-backend/
├── types.ts                      # Server-side types (OpenClawConfig, internal state)
├── openclaw.ts                   # OpenClaw gateway implementation
├── openclaw.test.ts
├── thinking.ts                   # Thinking block stripping utility
├── thinking.test.ts

packages/server/src/chat/
├── chat.ts                       # Chat module — WS proxy, session mapping, bus integration
├── chat.test.ts
├── routes.ts                     # REST endpoints
├── ws.ts                         # WS channel registration + message handlers
├── ws.test.ts
```

---

## 3. Client Feature Stores

Each feature module contains its own store. Stores are self-contained: they define their own signals, subscribe to their own WS channels, and expose only what their feature's components need.

### Requirements

#### 3.1 Connection Store (`features/connection/store.ts`)

- The store MUST expose `connectionStatus: Accessor<ConnectionStatus>` — the current backend connection state.
- The store MUST expose `statusText: Accessor<string>` — a human-readable string derived from `connectionStatus` (e.g. `'connecting'` → `'Connecting…'`, `'connected'` → `'Connected'`, `'disconnected'` → `'Disconnected'`, `'error'` → `'Connection error'`).
- The store MUST subscribe to the `chat` WS channel for `backend.status` messages and update `connectionStatus` accordingly.
- Types: `ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'`.
- The `ConnectionBadge` component MUST render a colored dot: green for `connected`, amber for `connecting`/`authenticating`, red for `disconnected`/`error`. The dot MUST use `var(--c-accent)` for green, `var(--c-amber)` for amber, `var(--c-danger)` for red.

#### 3.2 Chat Store (`features/chat/store.ts`)

- The store MUST expose the following reactive signals:
  - `turns: Accessor<ParsedTurn[]>` — the full conversation history for the current thread.
  - `streamingHtml: Accessor<string>` — live streaming HTML content being rendered incrementally.
  - `agentStatus: Accessor<AgentStatus>` — current agent activity state (`idle`, `working`, `thinking`).
  - `liveWork: Accessor<WorkItem[]>` — array of work items for the in-progress turn.
  - `liveThinkingText: Accessor<string>` — raw thinking text being streamed (for expandable thinking display).
  - `compacting: Accessor<boolean>` — whether context compaction is in progress.
- The store MUST expose retry countdown state:
  - `isRetryCountdownActive: Accessor<boolean>` — whether a rate-limit retry countdown is running.
  - `retryCountdownSeconds: Accessor<number>` — seconds remaining until retry.
  - `startRetryCountdown(seconds: number): void` — starts the countdown timer (decrements every second).
  - `clearRetryCountdown(): void` — cancels the countdown and resets state.
- The store MUST expose actions:
  - `sendMessage(text: string, attachments?: File[]): void` — sends a chat message via the `chat` WS channel. MUST add an optimistic pending turn to `turns` immediately (before server confirmation). MUST clear the input scratchpad for the current thread.
  - `abortChat(): void` — sends `chat.abort` via the `chat` WS channel. MUST update `agentStatus` to `idle`.
- The store MUST subscribe to the `chat` WS channel for: `chat.stream`, `chat.turn`, `chat.status`, `chat.work`, `chat.compacting`, `chat.error`, `chat.session.info`.
- When a `chat.turn` message arrives, the store MUST replace the optimistic pending turn (if any) with the confirmed turn from the server.
- When a `chat.error` message arrives with `retryAfterMs`, the store MUST call `startRetryCountdown(retryAfterMs / 1000)`.
- When a `chat.session.info` message arrives, the store MUST replace `turns` with the provided history.
- All state MUST be scoped to the current thread — when the thread changes (from the thread store via the `threadKey` accessor), the chat store MUST:
  1. Clear all current state (`turns`, `streamingHtml`, `liveWork`, `liveThinkingText`, `compacting`).
  2. Send `chat.session.switch` via WS with the new thread key.
  3. Await the `chat.session.info` response to populate `turns` with the new thread's history.
- Init: `initChatStore(threadKey: Accessor<string>)` — the store MUST accept the thread key as a reactive accessor and set up an effect that reacts to thread changes.
- Types `ParsedTurn`, `WorkItem`, `AgentStatus` MUST be imported from `@template/core`.

#### 3.3 Thread Store (`features/threads/store.ts`)

- The store MUST expose the following reactive signals:
  - `threadKey: Accessor<string>` — the currently active thread key.
  - `threads: Accessor<ThreadInfo[]>` — the full list of threads with metadata.
- The store MUST expose the following actions:
  - `switchThread(key: string): void` — sets the active thread key. MUST update the URL hash to `#thread={key}`. MUST NOT reload the page.
  - `createThread(label?: string): void` — sends a `POST /api/threads` REST request to create a new global thread. MUST add the new thread to `threads` on success.
  - `addEntity(threadKey: string, entity: EntityBinding): void` — sends `POST /api/threads/:key/entities` to add an entity binding.
  - `removeEntity(threadKey: string, entityType: string, entityRef: string): void` — sends `DELETE /api/threads/:key/entities/:entityType/:entityRef`.
- The `threadKey` MUST sync bidirectionally with the URL hash:
  - On init, the store MUST read the thread key from the URL hash (`#thread=...`). If no hash is present, it MUST default to `'main'`.
  - When `switchThread()` is called, the store MUST update the URL hash.
  - The store MUST listen for `popstate` events (browser back/forward) and update `threadKey` accordingly.
- The store MUST subscribe to the `threads` WS channel for `thread.created`, `thread.updated`, `thread.status` messages:
  - `thread.created` — MUST add the new thread to `threads`.
  - `thread.updated` — MUST update the matching thread's metadata in `threads`.
  - `thread.status` — MUST update the matching thread's status (last activity, unread count, agent activity).
- The store MUST fetch the initial thread list on init via `GET /api/threads` REST endpoint.
- `ThreadInfo` type: `{ key: string, entities: EntityBinding[], label?: string, lastActivity: number, unreadCount: number, agentStatus: AgentStatus }`.

#### 3.4 Voice Store (`features/voice/store.ts`)

- The store MUST expose the following reactive signals:
  - `voiceState: Accessor<VoiceState>` — current voice interface state.
  - `isRecording: Accessor<boolean>` — derived from `voiceState === 'listening'`.
  - `recordingTimerText: Accessor<string>` — elapsed recording time formatted as `MM:SS`. MUST update every second during recording. MUST reset to `'00:00'` when recording stops.
  - `voiceStatusText: Accessor<string>` — human-readable status derived from `voiceState` (e.g. `'Tap to speak'`, `'Listening…'`, `'Processing…'`, `'Speaking…'`).
- The store MUST expose the following actions:
  - `startRecording(): void` — MUST request microphone access via `navigator.mediaDevices.getUserMedia()`. MUST create a `MediaRecorder` with `audio/webm;codecs=opus` MIME type (fallback to `audio/webm` if opus is not supported). MUST set `voiceState` to `'listening'` and start the recording timer.
  - `stopRecording(): void` — MUST stop the `MediaRecorder`, collect the audio blob, set `voiceState` to `'processing'`, send the audio to the server transcription endpoint (`POST /api/voice/transcribe`), and on response, send the transcribed text as a chat message via the chat WS channel. MUST set `voiceState` to `'idle'` after the chat message is sent (or to `'speaking'` if TTS playback begins).
  - `interruptPlayback(): void` — MUST stop any in-progress TTS audio playback immediately. MUST set `voiceState` to `'idle'`.
- Types: `VoiceState = 'idle' | 'listening' | 'speaking' | 'processing'`.
- The store MUST be self-contained: it manages `MediaRecorder`, audio chunks, timer intervals, and audio playback internally. It MUST NOT import from any other feature store.

#### 3.5 Nav Store (`features/nav/store.ts`)

- The store MUST expose the following reactive signals:
  - `viewMode: Accessor<ViewMode>` — the current view.
  - `drawerOpen: Accessor<boolean>` — whether the thread drawer is open.
  - `settingsOpen: Accessor<boolean>` — whether the settings modal is open.
- The store MUST expose the following actions:
  - `setViewMode(mode: ViewMode): void` — MUST update the URL query parameter to `?view={mode}`. MUST NOT trigger a page reload.
  - `setDrawerOpen(open: boolean): void`.
  - `setSettingsOpen(open: boolean): void`.
- The `viewMode` MUST sync bidirectionally with URL query parameters:
  - On init, the store MUST read the view mode from the `?view=` query parameter. If absent, MUST default to `'chat'`.
  - When `setViewMode()` is called, the store MUST update the URL query parameter using `history.replaceState()`.
  - The store MUST listen for `popstate` events and update `viewMode` accordingly.
- Types: `ViewMode = 'chat' | 'voice' | 'dashboard' | 'recording'`.

#### 3.6 Theme Store (`features/theme/store.ts`)

- Specified in §1.4 above.

#### 3.7 Store Principles

- Each store MUST be a standalone module — no circular imports between stores.
- Cross-store coordination MUST flow through the WS channel (server as source of truth) or through explicit composition in `App.tsx` components, NOT through stores importing each other.
- The one exception: the chat store MUST read the current `threadKey` from the thread store to scope its WS subscription. This is a read-only dependency, passed as a parameter at init: `initChatStore(threadKey: Accessor<string>)`.
- Each store MUST be independently testable with a mocked WS connection (injected via constructor or init function).

---

## 4. Chat Feature

The primary conversation view. All components and store co-located in `features/chat/`.

### Requirements

#### 4.1 ChatView

- The `ChatView` component MUST render conversation turns as a vertically scrollable list.
- The component MUST auto-scroll to the bottom when new messages arrive or streaming content updates — UNLESS the user has manually scrolled up.
- The component MUST detect user scroll-up using a scroll threshold: if the scroll position is more than 80px from the bottom, auto-scroll MUST be paused.
- The component MUST show a "scroll to bottom" floating button when the user has scrolled up and new content has arrived below the viewport. Clicking the button MUST scroll to the bottom and re-enable auto-scroll.
- The component MUST use double-`requestAnimationFrame` for scroll-after-render to ensure DOM layout is complete before scrolling.
- The component MUST show a streaming indicator (pulsing dots using Tailwind `animate-pulse-dots` animation) below the last message when `streamingHtml` is non-empty.
- The component MUST show a compaction indicator (muted text + `<Spinner>`) when `compacting` is `true`.
- The component MUST show a rate-limit retry countdown when `isRetryCountdownActive` is `true`, displaying `retryCountdownSeconds` with a visual countdown bar.
- The component MUST render each turn using the `<MessageBubble>` component for the message and `<WorkSection>` component for intermediate work items.
- All styling MUST use inline Tailwind classes with `var(--c-*)` theme tokens.

#### 4.2 MessageBubble

- User messages MUST be styled as right-aligned bubbles with `var(--c-user-bubble)` background and `var(--c-user-bubble-text)` text color. MUST have rounded corners and horizontal padding.
- Assistant messages MUST be left-aligned with full-width layout. Content MUST be rendered through the `<MarkdownContent>` component.
- System messages MUST be styled distinctly: muted text color (`var(--c-text-muted)`), centered or left-indented, smaller font size.
- Each message MUST show a timestamp:
  - Today's messages: `"Today at HH:MM:SS"`.
  - Older messages: `"Day, Mon DD at HH:MM:SS"`.
- Each message MUST have a context menu accessible via:
  - Long-press on mobile (300ms threshold).
  - Right-click on desktop.
  - The context menu MUST include actions: Copy text (plain text), Copy markdown (source markdown), Export PDF, Forward to thread (opens `ForwardDialog`).
- Message copy buttons MUST appear on hover (desktop) using Tailwind `group-hover:opacity-100` with `opacity-0` default, making them visible only when the mouse is over the message. On mobile, these actions MUST be accessible exclusively via the context menu.
- Pending messages (optimistic sends not yet confirmed by server) MUST be visually distinguished with reduced opacity (`opacity-50` via Tailwind) and a subtle loading indicator.
- Forwarded messages MUST render a distinct "forwarded from" header showing the source thread name and original timestamp, styled with `var(--c-text-muted)` and a left border accent.

#### 4.3 MarkdownContent

- The `MarkdownContent` component MUST render markdown-formatted HTML with Tailwind-styled elements.
- The component MUST support the following markdown elements:
  - **Headings** (h1–h6): MUST use `var(--c-text-heading)` color and appropriate sizing via Tailwind `text-*` classes.
  - **Paragraphs**: MUST have appropriate line-height and spacing.
  - **Lists** (ordered and unordered): MUST have proper indentation and bullet/number styling.
  - **Code blocks** (fenced with triple backtick): MUST render with `var(--c-pre-bg)` background, `var(--c-code-text)` text, monospace font, horizontal scroll for overflow, and a copy-to-clipboard `<IconButton>` positioned at the top-right corner. Syntax highlighting MUST be applied using `highlight.js` with a theme that uses `var(--c-*)` tokens.
  - **Inline code**: MUST render with `var(--c-code-bg)` background, `var(--c-code-text)` text, monospace font, rounded padding. MUST show a copy-to-clipboard icon on hover.
  - **Blockquotes**: MUST render with a left border using `var(--c-accent)` and indented content.
  - **Tables**: MUST render with `var(--c-border)` borders, alternating row backgrounds, and horizontal scroll for overflow.
  - **Links**: MUST use `var(--c-accent)` color, underline on hover, and `target="_blank"` with `rel="noopener noreferrer"` for external links.
  - **Strong/Emphasis**: MUST use appropriate font-weight/style.
  - **Horizontal rules**: MUST render with `var(--c-border)` color.
  - **Images**: MUST render inline with `max-width: 100%` and rounded corners.
- The component MUST use `marked` (or equivalent) for markdown parsing and MUST sanitize output to prevent XSS.

#### 4.4 WorkSection

- The `WorkSection` component MUST render between a user message and the assistant's final response, showing the agent's intermediate activity.
- Work items MUST include:
  - **Tool calls**: MUST show the tool name, an icon from the tool icon map, and a collapsible preview of the tool input. Icons: 📖 `read`, ✏️ `write`, ✂️ `edit`, ▶ `exec`, ⚙ `process`, 🌐 `browser`, 📡 `web_fetch`, 🔍 `memory_search`, 📋 `memory_get`, 🔧 for unknown tools.
  - **Tool results**: MUST be paired with their corresponding tool call (matched by `toolCallId`). MUST show a collapsible preview of the output. Success results MUST show a green checkmark; error results MUST show a red ✗.
  - **Thinking blocks**: MUST be rendered as expandable sections with `var(--c-text-muted)` text. MUST show a "Thinking…" label when collapsed. MUST show the raw thinking text when expanded.
  - **System events**: MUST be rendered inline with muted styling. System events include: nudges, compaction notifications, heartbeat acknowledgments, context overflow warnings.
- Tool call inputs and results MUST be collapsible: collapsed by default for content exceeding 3 lines, with a "Show more" / "Show less" toggle.
- Thinking blocks MUST be collapsible: collapsed by default.
- The entire work section MUST be collapsible as a whole. MUST be expanded by default while the turn is in progress (agent working). MUST be collapsed by default when the turn is complete. MUST show a summary line when collapsed (e.g. "5 tool calls, 2 thinking blocks").
- Work items MUST be styled with `var(--c-step-bg)` background and `var(--c-work-border)` border.
- The work section MUST show a step count badge using `<Badge>` with `var(--c-step-badge-bg)`.

#### 4.5 InputArea

- The input area MUST provide a multi-line `<textarea>` that auto-resizes vertically as the user types. The textarea MUST have a minimum height of one line and a maximum height of 200px (scrollable beyond that).
- The input area MUST send the message on Enter (without modifier keys). Shift+Enter MUST insert a newline.
- The input area MUST support file attachments via three mechanisms:
  - Drag-and-drop: files dropped onto the input area MUST be added as attachments.
  - Paste: images pasted from clipboard MUST be added as attachments.
  - File picker: a file picker `<IconButton>` (📎 icon) MUST open a native file dialog. Selected files MUST be added as attachments.
- Attached files MUST be shown as removable `<Chip>` components above the input. Each chip MUST show the filename, file size, and a remove (✗) button. Image attachments SHOULD show a thumbnail preview.
- The input area MUST include a voice recording button (microphone `<IconButton>` 🎤) that triggers push-to-talk recording via the voice store.
- When recording is active, the input area MUST show a recording timer (elapsed time as `MM:SS`) and a pulsing animation (Tailwind `animate-mic-pulse`) on the microphone button. The microphone button MUST change to a stop button (⬛) during recording.
- The input area MUST include a send `<IconButton>` (➤ icon) that:
  - MUST be disabled (visually muted, non-interactive) when the input text is empty AND no files are attached.
  - MUST be enabled when there is text or at least one attachment.
- The input area MUST include an abort `<IconButton>` (⬛ stop icon) that:
  - MUST be visible ONLY when `agentStatus` is `'working'` or `'thinking'`.
  - MUST replace the send button when visible.
  - MUST call `abortChat()` on click.
- The input area MUST support message history navigation:
  - Up arrow key (when cursor is at the beginning of input) MUST cycle backward through previously sent messages for the current thread.
  - Down arrow key MUST cycle forward.
  - Message history MUST be persisted per-thread in `localStorage` key `sovereign:history:{threadKey}`.
  - History MUST be limited to the last 50 messages per thread.
- The input area MUST support a scratchpad:
  - Input content MUST be auto-saved to `localStorage` key `sovereign:scratchpad:{threadKey}` on every change (debounced 500ms).
  - When switching threads, the scratchpad content for the new thread MUST be restored into the input.
  - When a message is sent, the scratchpad for that thread MUST be cleared.
- The input area MUST be fixed at the bottom of the chat view.
- The input area MUST apply safe-area inset padding at the bottom for mobile devices with home indicators (using `env(safe-area-inset-bottom)`).
- The input area MUST show the current agent status inline: when `agentStatus` is `'working'`, show "Working…" in muted text above or beside the input. When `'thinking'`, show "Thinking…".

### Files

```
packages/client/src/features/chat/
├── store.ts
├── store.test.ts
├── ChatView.tsx
├── ChatView.test.ts
├── MessageBubble.tsx
├── MessageBubble.test.ts
├── MarkdownContent.tsx
├── MarkdownContent.test.ts
├── WorkSection.tsx
├── WorkSection.test.ts
├── InputArea.tsx
├── InputArea.test.ts
├── types.ts
```

---

## 5. Thread Feature

Entity-bound thread management. All components, store, and helpers co-located in `features/threads/`.

### Requirements

#### 5.1 Thread Model

- Every thread MUST have an identity: `{ threadKey: string, entities: EntityBinding[], label?: string }`.
- The `entities` array MAY be empty (global threads like `main`), contain one entity (typical — a branch, issue, or PR), or contain multiple entities (cross-cutting work spanning multiple entities).
- An `EntityBinding` MUST contain: `{ orgId: string, projectId: string, entityType: 'branch' | 'issue' | 'pr', entityRef: string }`.
- Thread keys for entity-bound threads MUST follow the format: `{orgId}/{projectId}/{entityType}:{entityRef}` based on the **primary** entity (first in the `entities` array). The key is immutable once created — adding more entities MUST NOT change the key.
- Global thread keys MUST be: `main` for the default thread, or user-defined labels for bespoke threads (e.g. `research`, `standup`).
- Entities MUST be addable to an existing thread via `POST /api/threads/:key/entities` with an `EntityBinding` body. This allows a thread to track a branch AND its associated issue AND its PR simultaneously.
- Entities MUST be removable from a thread via `DELETE /api/threads/:key/entities/:entityType/:entityRef`. Removing the last entity from a non-global thread MUST NOT delete the thread — it becomes an unbound thread.
- When a worktree is created (bus event `worktree.created`), the thread manager MUST automatically create a thread for that branch (or reuse an existing thread if one already exists for that branch).
- When an issue is created (bus event `issue.created`), the thread manager MUST automatically create a thread for that issue.
- When a review/PR is created (bus event `review.created`), the thread manager MUST automatically create a thread for that PR/patch.
- When entities are naturally related, the thread manager SHOULD automatically associate them into the same thread rather than creating separate threads. Detection methods:
  - PR body containing `fixes #42`, `closes #42`, `resolves #42` → link PR and issue into same thread.
  - Branch name containing issue number (e.g. `feat/42-auth`, `fix-42`) → link branch and issue into same thread.
  - Explicit cross-references in issue/PR metadata.
- Thread metadata MUST be persisted to `{dataDir}/threads/registry.json` using atomic file writes (write to temp file + rename).

#### 5.2 Event Routing (Server)

- Events from an entity MUST be routed to **every thread that contains that entity** in its `entities` array. A single event MAY route to multiple threads if the entity appears in more than one thread.
- Entity → thread matching rules:
  - `git.status.changed` with a branch reference → route to all threads containing a `branch:*` entity matching that branch.
  - `issue.updated`, `issue.comment.added` → route to all threads containing an `issue:*` entity matching that issue.
  - `review.updated`, `review.comment.added`, `review.approved`, `review.changes_requested`, `review.merged` → route to all threads containing a `pr:*` entity matching that PR/patch.
  - Webhook events with entity extraction → route to all matching threads.
- Events MUST be classified as either AGENT or NOTIFY:
  - AGENT-classified events MUST trigger autonomous agent work in the thread: the thread manager MUST send the event as a system message to the `AgentBackend` session mapped to that thread.
  - NOTIFY-classified events MUST surface as a notification in the thread view for the user to respond to (via the Phase 1 notification system, with `threadKey` metadata).
- Events for entities with no existing thread SHOULD cause automatic thread creation for that entity.
- The event router MUST emit `thread.event.routed` bus events with `{ threadKey, event, entityBinding }` for observability.

#### 5.3 ThreadDrawer (Client)

- The `ThreadDrawer` component MUST slide in from the left edge of the screen with a smooth CSS transition (300ms ease).
- The drawer MUST show all threads grouped into sections:
  - **Global** — `main` thread + any user-created bespoke threads (no entity binding).
  - **Per-workspace** — grouped by `{orgId}/{projectId}`, showing entity-bound threads for that project.
- Each thread entry MUST show:
  - Display name: derived from the primary entity (first in `entities` array) — branch name for branches, issue title + number for issues, PR title + number for PRs. For global threads, show the label.
  - Entity type icon: 🌿 for branch, 🎫 for issue, 🔀 for PR.
  - Last activity time: relative time (e.g. "2m ago", "1h ago", "Yesterday").
  - Unread indicator: `<Badge>` with unread message count. MUST hide when count is 0.
  - When multiple entities are bound, a secondary indicator MUST show the additional entity count (e.g. "feat-auth +2"). Clicking the indicator SHOULD expand to show all bound entities.
- The drawer MUST support the following actions:
  - **Switch thread**: tap/click on a thread entry to switch to it (calls `switchThread(key)` on the thread store).
  - **Create thread**: a "New thread" button at the top of the Global section. MUST open a name input dialog.
  - **Hide thread**: swipe-left on mobile or right-click → "Hide" on desktop. Hidden threads MUST disappear from the list.
  - **Unhide thread**: a "Show hidden" toggle at the bottom of the drawer. When active, hidden threads appear with muted styling and an "Unhide" action.
- Hidden thread keys MUST be persisted in `localStorage` key `sovereign:hidden-threads` as a JSON array.
- The drawer MUST show subagent sessions (if any) nested under the parent thread entry, with an indented style and a bot icon.
- The drawer MUST have a search/filter input at the top that filters threads by name, entity ref, or label. Matching MUST be case-insensitive substring match.

#### 5.4 ForwardDialog (Client)

- The `ForwardDialog` component MUST open as a `<Modal>` overlay when triggered from a message's context menu ("Forward to…").
- The dialog MUST show a thread picker listing all available threads (global + entity-bound) with search/filter. The current thread MUST be excluded from the list.
- The dialog MUST include a "Add a note…" text input for optional commentary to accompany the forwarded message.
- A forwarded message MUST preserve: original message content (markdown), original author (user/assistant/system), original timestamp, source thread key and label, any file attachments or file references.
- The dialog MUST show a preview of the message being forwarded (truncated to first 3 lines with "…" if longer).
- Clicking "Forward" MUST send the `ForwardedMessage` payload to `POST /api/threads/:key/forward`.
- A forwarded message MUST be visually distinct in the target thread — a "Forwarded from {sourceThreadLabel}" header above the message content, styled with `var(--c-text-muted)` text and a `var(--c-border)` left border.
- Forward MUST work across workspaces (forward from a thread in project A to a thread in project B).
- Forward MUST emit a bus event: `thread.message.forwarded` with `{ sourceThread, targetThread, messageId }`.

#### 5.5 Thread Helpers (`helpers.ts`)

- `getThreadDisplayName(thread: ThreadInfo): string` — MUST derive a human-readable display name from the primary entity: branch name, issue title + `#number`, PR title + `#number`. For global threads, MUST return the label or `'Main'`.
- `getEntityIcon(entityType: EntityBinding['entityType']): string` — MUST return the appropriate emoji icon: `'branch'` → `'🌿'`, `'issue'` → `'🎫'`, `'pr'` → `'🔀'`.
- `groupThreadsByWorkspace(threads: ThreadInfo[]): Map<string, ThreadInfo[]>` — MUST group threads by `{orgId}/{projectId}` key. Global threads (empty entities) MUST be grouped under a `'global'` key.
- `formatRelativeTime(timestamp: number): string` — MUST format a Unix timestamp as relative time (e.g. "Just now", "2m ago", "1h ago", "Yesterday", "Mon, Mar 10").

### Thread REST API

- `GET /api/threads` — MUST return all threads with current status (last activity, unread count, agent activity, entity bindings).
- `GET /api/threads/:key` — MUST return full thread details including all entity bindings, label, creation time, and recent events.
- `POST /api/threads` — MUST create a new global thread. Body: `{ label?: string }`. MUST return the created thread with its key.
- `DELETE /api/threads/:key` — MUST archive/hide a thread. MUST NOT delete thread data. MUST emit `thread.archived` bus event.
- `POST /api/threads/:key/entities` — MUST add an entity binding to an existing thread. Body: `EntityBinding`. MUST return the updated thread. MUST emit `thread.updated` bus event.
- `DELETE /api/threads/:key/entities/:entityType/:entityRef` — MUST remove an entity binding from a thread. MUST return the updated thread. MUST emit `thread.updated` bus event.
- `POST /api/threads/:key/forward` — MUST forward a message to the specified thread. Body: `ForwardedMessage`. MUST deliver the message to the target thread's backend session. MUST emit `thread.message.forwarded` bus event.
- `GET /api/threads/:key/events` — MUST return a paginated list of events routed to this thread. Query params: `limit` (default 50), `offset` (default 0), `since` (Unix timestamp).

### Thread WS Channel: `threads`

**Server → Client:**

- `thread.created` — `{ thread: ThreadInfo }` — emitted when a new thread is created (auto or manual).
- `thread.updated` — `{ thread: ThreadInfo }` — emitted when thread metadata changes (entities added/removed, label changed).
- `thread.event.routed` — `{ threadKey: string, event: object, entityBinding: EntityBinding }` — emitted when an entity event is routed to a thread.
- `thread.status` — `{ threadKey: string, lastActivity: number, unreadCount: number, agentStatus: AgentStatus }` — emitted when thread status changes.

**Scoped by:** `{ orgId?, projectId? }` — or unscoped for all threads. A client subscribed to `threads` with scope `{ orgId: 'myorg', projectId: 'myproject' }` MUST only receive events for threads bound to that project.

### Thread Bus Events

- `thread.created` — `{ threadKey, entities, label? }`.
- `thread.archived` — `{ threadKey }`.
- `thread.event.routed` — `{ threadKey, event, entityBinding }`.
- `thread.message.forwarded` — `{ sourceThread, targetThread, messageId, forwardedBy }`.

### Server Files

```
packages/server/src/threads/
├── types.ts                      # ThreadKey, EntityBinding, ThreadInfo, ThreadEvent types
├── router.ts                     # Event → thread routing logic
├── router.test.ts
├── threads.ts                    # Thread registry, auto-creation, entity management
├── threads.test.ts
├── forward.ts                    # Message forwarding logic
├── forward.test.ts
├── ws.ts                         # WS channel for thread events
├── ws.test.ts
├── routes.ts                     # REST API endpoints
```

---

## 6. Voice Feature

Push-to-talk voice recording and TTS playback. All components, store, and audio utilities co-located in `features/voice/`.

### Requirements

#### 6.1 VoiceView

- The `VoiceView` component MUST provide a full-screen push-to-talk interface with:
  - A large central push-to-talk button (minimum 120px diameter on mobile, 80px on desktop).
  - Status text below the button showing `voiceStatusText` from the voice store.
  - A recording timer showing `recordingTimerText` when recording is active.
- The push-to-talk button MUST trigger `startRecording()` on press and `stopRecording()` on release (or on second tap, toggle mode).
- The component MUST show distinct visual feedback for each `VoiceState`:
  - `idle` — static microphone icon, muted border. Status: "Tap to speak".
  - `listening` — pulsing microphone with `animate-mic-pulse` animation, accent border. Status: "Listening…".
  - `processing` — `<Spinner>` replacing the microphone, muted border. Status: "Processing…".
  - `speaking` — pulsing speaker icon with `animate-speak-pulse` animation, accent border. Status: "Speaking…".
- Tapping the button during `speaking` state MUST call `interruptPlayback()` and return to `idle`.
- All styling MUST use Tailwind utilities with `var(--c-*)` tokens.
- The component MUST center vertically in the available space.

#### 6.2 Audio Utilities (`audio.ts`)

- `createRecorder(): { start(): void, stop(): Promise<Blob>, cancel(): void }` — MUST manage `MediaRecorder` lifecycle. MUST use `audio/webm;codecs=opus` MIME type with fallback to `audio/webm`. MUST collect data chunks and return a single Blob on stop.
- `playAudio(blob: Blob): Promise<void>` — MUST play an audio blob through the default audio output. MUST resolve when playback completes. MUST support interruption (returns a cancel function).
- `unlockAudio(): void` — MUST create and play a silent audio buffer to unlock audio playback on iOS Safari. MUST be called on a user gesture (touch/click) event. MUST be called only once.
- `isAudioUnlocked(): boolean` — MUST return whether audio playback has been unlocked.

#### 6.3 RecordingView

- The `RecordingView` component MUST list past voice recordings with:
  - Date/time of recording.
  - Duration.
  - Playback controls (play/pause/stop).
  - A progress bar showing playback position.
  - Export button (download as `.webm` file).
  - Delete button with confirmation.
- Recordings MUST be stored in IndexedDB (key: `sovereign:recordings`).
- The list MUST be sorted by date, newest first.
- The component MUST support pagination or virtual scrolling for large recording lists.

#### 6.4 Voice Module (Server)

- The voice module MUST expose transcription and TTS via REST endpoints.
- `POST /api/voice/transcribe` — MUST accept an audio blob (`multipart/form-data` with field `audio`). MUST proxy the audio to the configured transcription service URL (`voice.transcribeUrl` from config). MUST return `{ text: string }`. MUST return 503 if no transcription URL is configured.
- `POST /api/voice/tts` — MUST accept `{ text: string, voice?: string }` JSON body. MUST proxy the text to the configured TTS service URL (`voice.ttsUrl` from config). MUST return the audio blob with appropriate `Content-Type` (e.g. `audio/wav`, `audio/mp3`). MUST return 503 if no TTS URL is configured.
- The voice module MUST support hot-reload of `voice.transcribeUrl` and `voice.ttsUrl` config values.
- The voice module MUST emit bus events: `voice.transcription.completed` with `{ text, durationMs }`, `voice.tts.completed` with `{ text, durationMs }`.

### Files

```
packages/client/src/features/voice/
├── store.ts
├── store.test.ts
├── VoiceView.tsx
├── VoiceView.test.ts
├── RecordingView.tsx
├── RecordingView.test.ts
├── audio.ts
├── audio.test.ts

packages/server/src/voice/
├── voice.ts
├── voice.test.ts
├── routes.ts
```

---

## 7. Dashboard Feature

The home screen for global threads. Shows activity across all workspaces. All components co-located in `features/dashboard/`.

### Requirements

#### 7.1 DashboardView

- The `DashboardView` MUST be the default view when the user is in a global thread (`main` or any bespoke thread with no entity binding).
- The dashboard MUST auto-refresh all sections via Phase 3 WS subscriptions (`status`, `notifications`, `threads` channels).
- All styling MUST use Tailwind utilities with `var(--c-*)` theme tokens.
- The dashboard MUST use a responsive grid layout: single column on mobile, two columns on tablet, three columns on desktop.

#### 7.2 Clock

- The dashboard MUST show the current time in large text at the top, auto-updating every second.
- The time format MUST respect the user's locale (`Intl.DateTimeFormat`).

#### 7.3 HealthPanel

- The `HealthPanel` component MUST show:
  - Agent backend connection status (using `<ConnectionBadge>`): connected/disconnected/error with color indicator.
  - Connected services: list of active server modules with their status (from the `status` WS channel).
  - Uptime: server uptime duration formatted as `Xd Xh Xm`.
- Each service MUST show a status dot: green for healthy, amber for degraded, red for error.
- The system module's `getHealth()` MUST accept an optional `getAgentBackendStatus` callback in its options. When provided, the health endpoint's `connection.agentBackend` field MUST reflect the return value of this callback. When not provided, it MUST default to `'disconnected'`. This allows the server wiring to inject the live agent backend connection status into health reports.

#### 7.4 ActivityFeed

- The `ActivityFeed` component MUST show recent events across all workspaces in a reverse-chronological stream.
- Events MUST include: commits (`git.status.changed`), active agents (`chat.status` with `working`/`thinking`), running tests (if CI events exist), open reviews (`review.created`, `review.updated`), issue updates (`issue.updated`, `issue.created`), worktree activity (`worktree.created`, `worktree.removed`).
- Each event entry MUST show: event icon, description text, workspace/project label, relative timestamp.
- Each event entry MUST be clickable — clicking MUST switch to the entity-bound thread for that event (via the thread store or prop callback).
- The feed MUST show a maximum of 50 events and MUST support "Load more" for pagination.

#### 7.5 Notifications Section

- The dashboard MUST show unread notifications grouped by thread/entity.
- NOTIFY-classified events MUST be shown with an action prompt (e.g. "Review requested on PR #42 — View").
- Clicking a notification MUST switch to the relevant thread.
- Read notifications MUST be visually distinguished (muted opacity).
- The notification section MUST subscribe to the `notifications` WS channel.

#### 7.6 Active Agents

- The dashboard MUST show a list of currently working agent sessions with:
  - Thread name / entity binding.
  - Current agent status (`working` / `thinking`).
  - Duration of current activity.
- Clicking an active agent entry MUST switch to that agent's thread.

#### 7.7 ThreadQuickSwitch

- The `ThreadQuickSwitch` component MUST show the 5 most recently active threads.
- Each entry MUST show: thread display name, entity icon, relative time of last activity.
- Clicking MUST switch to that thread.

#### 7.8 Optional Sections

- The dashboard SHOULD show weather information if configured (config key `dashboard.weatherLocation`).
- The dashboard MAY show a planning summary from the Phase 5 planning module (completion rates, blocked items count, critical path length).

### Files

```
packages/client/src/features/dashboard/
├── DashboardView.tsx
├── DashboardView.test.ts
├── ActivityFeed.tsx
├── HealthPanel.tsx
├── ThreadQuickSwitch.tsx
```

---

## 8. Nav Feature

Header, navigation, and settings. All components and store co-located in `features/nav/`.

### Requirements

#### 8.1 Header

- The `Header` component MUST render a fixed-position top bar with the following elements (left to right):
  - Thread drawer toggle `<IconButton>` (hamburger icon ☰). MUST call `setDrawerOpen(!drawerOpen)` on click.
  - `<ConnectionBadge>` from the connection feature (passed as prop, not imported).
  - Current thread name: MUST show the display name of the active thread. For entity-bound threads, MUST show the primary entity name (e.g. "feat-auth" for a branch, "Issue #42: Fix login" for an issue). When multiple entities are bound, MUST show a clickable "+N" indicator that expands to show all bound entities in a dropdown.
  - Subagent indicator: when subagents are active in the current thread, MUST show a `<Badge>` with the count of active subagents (e.g. "2 agents").
  - View switcher: tab-like buttons for each `ViewMode` (`chat`, `voice`, `dashboard`, `recording`). The active view MUST be visually highlighted with `var(--c-accent)` underline or background. Clicking MUST call `setViewMode()`.
  - Settings `<IconButton>` (⚙ icon). MUST call `setSettingsOpen(true)` on click.
- The header MUST use `var(--c-bg-raised)` background, `var(--c-border)` bottom border.
- The header MUST have safe-area inset padding at the top for mobile devices with notches (using `env(safe-area-inset-top)`).

#### 8.2 SettingsModal

- The `SettingsModal` component MUST open as a `<Modal>` when `settingsOpen` is `true`.
- The modal MUST include the following settings sections:
  - **Theme**: radio buttons or visual swatches for each theme (`default`, `light`, `ironman`, `jarvis`). Selecting a theme MUST call `setTheme()` on the theme store (passed as prop). The current theme MUST be visually indicated.
  - **Audio**: toggle for TTS enabled/disabled (persisted in `localStorage` key `sovereign:tts-enabled`). Voice selection dropdown (if multiple TTS voices are available from the server).
- The modal MUST NOT include gateway URL configuration — that is a server-side config managed via the Phase 3 config API, not a client setting.
- The modal MUST close on Escape key, backdrop click, or the close button.

### Files

```
packages/client/src/features/nav/
├── store.ts
├── store.test.ts
├── Header.tsx
├── Header.test.ts
├── SettingsModal.tsx
├── SettingsModal.test.ts
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 6 MUST include integration tests in `packages/server/src/__integration__/phase6.test.ts` covering:

- **Agent backend proxy round-trip:** Sovereign server connects to a mock OpenClaw gateway → client sends `chat.send` via Phase 3 WS → server proxies to backend → mock gateway responds with stream tokens → server proxies `chat.stream` + `chat.turn` back to client.
- **Thread auto-creation from worktree:** emit `worktree.created` bus event → thread manager creates a new thread → WS `thread.created` sent to subscribed clients.
- **Thread auto-creation from issue:** emit `issue.created` bus event → issue thread created.
- **Thread auto-creation from review:** emit `review.created` bus event → PR thread created.
- **Entity event routing:** emit `issue.updated` event → routed to correct issue thread → WS `thread.event.routed` sent to subscribed clients.
- **Multi-entity routing:** add two entities to same thread → events from both entities route to that thread.
- **Thread switching:** client sends `chat.session.switch` → server maps thread key to backend session key → backend `switchSession()` called → history loaded → `chat.session.info` sent to client.
- **Message forwarding:** `POST /api/threads/:key/forward` with `ForwardedMessage` → message delivered to target thread's backend session → `thread.message.forwarded` bus event emitted.
- **Voice transcription proxy:** `POST /api/voice/transcribe` with audio blob → proxied to mock transcription service → text returned.
- **Voice TTS proxy:** `POST /api/voice/tts` with text → proxied to mock TTS service → audio blob returned.
- **Rate limit handling:** mock gateway emits error with `retryAfterMs` → server forwards `chat.error` to client → server auto-retries after delay.
- **Config hot-reload:** change `agentBackend.openclaw.gatewayUrl` via config API → backend disconnects from old URL → reconnects to new URL → clients receive `backend.status` transitions.
- **Backend disconnection and reconnection:** mock gateway closes connection → server emits `backend.status: disconnected` → clients notified → mock gateway accepts reconnection → `backend.status: connected` → clients notified.
- **Session mapping persistence:** create session mapping → restart server (reload from disk) → mapping preserved.

### Dependencies (New)

**Client:**

- `marked` (or equivalent) — markdown → HTML rendering.
- `highlight.js` — syntax highlighting for code blocks in markdown.

**Server:**

- `@noble/ed25519` — Ed25519 keypair generation and signing for device identity (moved from client to server, since auth is server-side now).

### Module Registration (Server)

Server-side modules follow the established pattern:

```typescript
// Agent backend — factory function, returns AgentBackend interface
createOpenClawBackend(config: OpenClawConfig): AgentBackend

// Chat module — WS proxy + session mapping + bus integration
createChatModule(bus: EventBus, backend: AgentBackend, threadManager: ThreadManager): ChatModule

// Thread manager — registry, auto-creation, event routing, forwarding
createThreadManager(bus: EventBus, dataDir: string, deps: ThreadDeps): ThreadManager

// Voice module — transcription + TTS proxy
createVoiceModule(bus: EventBus, config: VoiceConfig): VoiceModule
```

Each MUST export `status(): ModuleStatus` for the status aggregator (Phase 1).

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1–5 directories)
├── threads/
│   └── registry.json          # Thread registry (key → entities, label, metadata)
├── agent-backend/
│   └── device-identity.json   # Ed25519 keypair for backend auth
├── chat/
│   └── session-map.json       # Thread key ↔ backend session key mapping
```

### Config Schema Addition

```typescript
// Added to Phase 3 config schema
agentBackend: {
  provider: 'openclaw'          // only option for now; Phase 8 adds 'native'
  openclaw: {
    gatewayUrl: string           // required, e.g. 'wss://localhost:3456/ws'
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
dashboard: {
  weatherLocation?: string       // optional, e.g. 'Melbourne, AU'
}
```

### Testing Strategy

- **Client feature tests:** Vitest with `environment: 'node'`. Each feature's store MUST be tested with a mocked WS connection. Components MUST be tested for reactive signal updates and rendering logic (signal changes → expected DOM output). Markdown rendering MUST be tested for all supported elements.
- **Server tests:** Mock `AgentBackend` for chat module tests. Mock `EventBus` for thread router tests. Mock `execFile` / HTTP for voice module tests. Mock file system for thread registry persistence tests.
- **Integration tests:** `packages/server/src/__integration__/phase6.test.ts` — full end-to-end scenarios as listed above.
- **No real gateway in tests:** All tests MUST use mock implementations. No real OpenClaw gateway, Whisper, or Kokoro connections in automated tests.
