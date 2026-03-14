# Voice-UI Parity Spec

Status: Draft | Revision: 1 | Date: 2026-03-14

## 1. Overview

This document is a comprehensive gap analysis between the **voice-ui** client/server codebase (`~/.openclaw/voice-ui/`) and the **Sovereign** codebase (`~/Desktop/sovereign/`). Its purpose is to catalog every feature, interaction, and UI element present in voice-ui that is missing, incomplete, or inadequately ported in Sovereign.

Sovereign was designed as a from-scratch rebuild with a different architecture (multi-org workspaces, WS pub/sub, feature-based modules). Many voice-ui features have Sovereign equivalents but with reduced functionality. Some are entirely absent.

### Scope

- Client-side: all components, stores, lib utilities
- Server-side: all REST endpoints, proxy routes, server utilities
- UI/UX: polish, theming, interaction patterns

### Relationship to Existing Phases

This spec is additive to phases 1–8. It is labeled §P (Parity) with sub-sections §P.1–§P.9. Implementation waves (§12) respect dependencies from earlier phases.

---

## 2. Architecture View (§P.1)

Voice-ui's `ArchitectureView.tsx` is **3,057 lines** — a massive operational dashboard. Sovereign's `ArchitectureTab.tsx` is **~130 lines** showing only module cards with status badges.

### §P.1.1 Overview Tab

**Voice-ui has:**

- Full `GET /api/architecture` endpoint returning: config, models, channels, sessions, cron jobs, skills, hooks, prompts, notifications, webhooks, devices, credentials, scripts, system info, plans sync status, thread health, events pipeline, context management
- Tabbed interface: Overview | Flow | Health | Logs | Plans
- Auto-refresh polling (5s) with WS live updates
- `SectionCard` component with collapsible content, badge counts, status indicators

**Sovereign has:**

- `GET /api/system/architecture` returning `{ modules: ModuleNode[] }` — name, status, subscribes, publishes
- Grid of module cards — no tabs, no section cards, no detail views

**MUST implement:**

- Expand `/api/system/architecture` to return the full system state object matching voice-ui's schema
- Add tabbed interface to `SystemView.tsx` (Overview, Flow, Health already exist as tabs)
- Implement `SectionCard` reusable component with collapsible body + badge
- Add the following section cards to the Overview tab:

| #   | Card               | Voice-ui source line | Data source                            |
| --- | ------------------ | -------------------- | -------------------------------------- |
| 1   | Thread Health      | L1710                | `GET /api/architecture` → `sessions`   |
| 2   | Models             | L1833                | `config.models`                        |
| 3   | Channels           | L1848                | `channels[]`                           |
| 4   | Sessions           | L1857                | `sessions` with counts by kind         |
| 5   | Cron Jobs          | L1880                | `cron` with active/paused/error counts |
| 6   | Skills             | L1973                | `skills` with enabled/total            |
| 7   | LLM Context        | L2086                | `prompts[]`                            |
| 8   | Hooks              | L2165                | `hooks[]`                              |
| 9   | Context Management | L2239                | Compaction stats, token budgets        |
| 10  | Notifications      | L2391                | `notifications.pending`                |
| 11  | Events             | L2447                | `webhooks.pending`                     |
| 12  | Events Pipeline    | L2566                | Queue depth, processing rate           |
| 13  | Security & Devices | L2947                | `devices[]`, `credentials[]`           |
| 14  | Scripts            | L2980                | `scripts[]`                            |
| 15  | System             | L2999                | OS, uptime, memory, CPU                |
| 16  | Plans Sync         | L1044                | Plans status from filesystem           |

### §P.1.2 System Flow Graph

**Voice-ui has:** `SystemFlowGraph.tsx` — interactive SVG/canvas graph showing data flow between gateway components (WS → agent → tools → response). Animated edges show live message flow.

**Sovereign has:** Nothing equivalent.

**SHOULD implement:**

- Port `SystemFlowGraph` component
- Wire to WS `system.flow` events for live animation
- Render as tab within SystemView

**File:** `packages/client/src/features/system/FlowGraph.tsx` (new)

### §P.1.3 Health Timeline

**Voice-ui has:** `HealthTimeline.tsx` — time-series chart of system health metrics (memory, CPU, response times, error rates) over configurable windows (1h/6h/24h/7d). Rendered with canvas.

**Sovereign has:** `HealthTab.tsx` exists but implementation is minimal — likely placeholder.

**MUST implement:**

- Port `HealthTimeline` component with canvas rendering
- Add health metric polling endpoint (`GET /api/system/health/history`)
- Support configurable time windows

**File:** `packages/client/src/features/system/HealthTimeline.tsx` (new)

### §P.1.4 Section Cards

**Voice-ui has:** Generic `SectionCard` component (L188–L240 of ArchitectureView.tsx):

```typescript
interface SectionCardProps {
  title: string
  icon: string
  badge?: string | number
  children: JSX.Element
}
```

Collapsible, with animated expand/collapse, badge count, and icon.

**Sovereign has:** No equivalent reusable component.

**MUST implement:**

```typescript
// packages/client/src/ui/SectionCard.tsx
export interface SectionCardProps {
  title: string
  icon: string
  badge?: string | number
  defaultOpen?: boolean
  children: JSX.Element
}
```

---

## 3. Context Budget Modal (§P.2)

**Voice-ui has:** `ContextBudgetModal.tsx` (511 lines) — triggered from Header, shows:

- System prompt size breakdown (project context vs non-project)
- Injected workspace files with char counts, truncation status
- Skills with block char counts
- Tool list with schema sizes and property counts
- Total budget utilization bar
- Data fetched from `GET /api/architecture` → `contextBudget` field

**Sovereign has:** Nothing.

**MUST implement:**

- `ContextBudgetModal.tsx` component
- Server endpoint `GET /api/system/context-budget` (or embed in architecture response)
- Modal trigger in Header (button or menu item)

**Interfaces:**

```typescript
interface WorkspaceFile {
  name: string
  path: string
  missing: boolean
  rawChars: number
  injectedChars: number
  truncated: boolean
}
interface ToolEntry {
  name: string
  summaryChars: number
  schemaChars: number
  propertiesCount?: number
}
interface SkillEntry {
  name: string
  blockChars: number
}
interface ContextReport {
  source: string
  generatedAt: number
  provider: string
  model: string
  workspaceDir: string
  bootstrapMaxChars: number
  sandbox: { mode: string; sandboxed: boolean }
  systemPrompt: { chars: number; projectContextChars: number; nonProjectContextChars: number }
  injectedWorkspaceFiles: WorkspaceFile[]
  skills: { promptChars: number; entries: SkillEntry[] }
  tools: { listChars: number; schemaChars: number; entries: ToolEntry[] }
}
```

**File:** `packages/client/src/features/system/ContextBudgetModal.tsx` (new)

---

## 4. Chat System Enhancements (§P.3)

### §P.3.1 Abort/Cancel In-Flight

**Voice-ui has:** `abortChat()` in `lib/gateway.ts` (L550) — sends WS `abort` request, suppresses lifecycle events for 30s to prevent status flicker, clears streaming state.

**Sovereign has:** `abortChat()` in `features/chat/store.ts` — sends `chat.abort` via WS, sets status to idle. Missing lifecycle suppression.

**MUST implement:**

- Add `suppressLifecycleUntil` timestamp to prevent status flicker after abort
- Clear streaming HTML, live work, and thinking text on abort
- Add visual confirmation (brief "Cancelled" status text)

### §P.3.2 Rate Limit Retry with Countdown

**Voice-ui has:** Full retry system in `lib/gateway.ts` (L1063–L1098):

- Detects 429/rate-limit errors
- Calls `POST /api/retry` with `{ sessionKey, delayMs }` to schedule server-side retry
- Shows countdown timer via `startRetryCountdown(retryAtMs)`
- Countdown renders in InputArea as "Retrying in Xs…"

**Sovereign has:** `startRetryCountdown` / `clearRetryCountdown` signals in `chat/store.ts` and handles `chat.error` with `retryAfterMs`. Missing server-side retry endpoint.

**MUST implement:**

- Server endpoint `POST /api/chat/retry` that schedules delayed retry
- Client-side countdown display in InputArea
- Visual retry indicator (progress bar or countdown text)

**File:** `packages/server/src/chat/retry.ts` (new)

### §P.3.3 Pending Turn Persistence

**Voice-ui has:** Persists pending (unconfirmed) user turns to `localStorage` so they survive page refresh. On reconnect, merges persisted pending turns with server history, deduplicating by content text (L875–L887).

**Sovereign has:** Optimistic turns in memory only — lost on refresh.

**SHOULD implement:**

- `localStorage` persistence key `sovereign:pending-turns:{threadKey}`
- On `chat.session.info` (history load), merge persisted pending turns
- Deduplicate by content match against confirmed history

### §P.3.4 Draft Persistence

**Voice-ui has:** `loadDraft(sk)` / `saveDraft(sk, text)` in `stores/app.ts` (L87–L108) — saves input value to `localStorage` on every keystroke, restores on thread switch.

**Sovereign has:** `saveScratchpad` / `restoreScratchpad` / `clearScratchpad` in `InputArea.tsx` — exists and appears functional.

**Status:** ✅ Implemented (verify scratchpad entry persistence vs simple draft text)

### §P.3.5 Streaming HTML

**Voice-ui has:** `streamingHtml` signal with thinking-block stripping (`stripThinkingBlocks`), real-time markdown rendering during streaming, and incremental DOM updates.

**Sovereign has:** `streamingHtml` signal exists, receives `chat.stream` events and concatenates text.

**SHOULD implement:**

- `stripThinkingBlocks()` function to remove `<think>`, `<thinking>`, `<thought>`, `<antThinking>` tags
- Protect code blocks from false matches
- Handle unclosed blocks (streaming mid-thought)

**File:** `packages/client/src/features/chat/strip-thinking.ts` (new)

### §P.3.6 Compaction Status

**Voice-ui has:** `compacting` signal, displayed in InputArea and status bar when context compaction is in progress. Triggered by `stream === 'compaction'` events.

**Sovereign has:** `compacting` signal exists, handled via `chat.compacting` WS event.

**Status:** ✅ Implemented at store level. SHOULD verify UI renders compaction indicator.

### §P.3.7 Optimistic User Turns

**Voice-ui has:** Adds user message to turns immediately before server confirmation. On `chat.turn` for user role, replaces the optimistic entry. Handles edge cases (multiple pending, server reorder).

**Sovereign has:** `sendMessage` adds optimistic turn with `pending: true`. `chat.turn` handler replaces first pending user turn.

**Status:** ✅ Implemented. SHOULD verify edge cases (multiple pending turns, out-of-order confirmation).

---

## 5. Dashboard Enhancements (§P.4)

**Voice-ui has:** `DashboardView.tsx` — single-page view with:

- Connection status bar
- Quick-access buttons for views
- Agent status indicator
- Session info summary
- Recent activity feed
- Voice widget

**Sovereign has:** `DashboardView.tsx` with:

- System status strip (connection, agent status, job count)
- Workspace cards grid (multi-org)
- Global chat widget
- Voice widget
- Meeting widget
- Notification feed

**Status:** Sovereign's dashboard is more advanced than voice-ui's in several ways (multi-org, meeting widget). Key gaps:

**SHOULD implement:**

- Activity feed with live WS updates (vs Sovereign's static `NotificationFeed`)
- Thread quick-switch with keyboard shortcut (Cmd+K / Ctrl+K)
- Agent duration timer (how long agent has been working)

### §P.4.1 Thread Quick Switch

**Voice-ui has:** Keyboard shortcut Cmd+K to open thread switcher overlay with fuzzy search.

**Sovereign has:** `ThreadQuickSwitch.tsx` exists in dashboard.

**Status:** SHOULD verify keyboard shortcut binding and fuzzy search functionality.

---

## 6. Events/Pipeline View (§P.5)

**Voice-ui has:** `EventsView.tsx` — dedicated view showing:

- Webhook event queue with real-time updates
- Event details panel (payload, headers, timing)
- Filter by event type, source, status
- Retry failed events
- Event pipeline visualization (queue → process → deliver)
- `GET /api/events` endpoints via `createEventsRouter()`

**Sovereign has:** `EventStreamTab.tsx` in system features — likely a basic event log.

**MUST implement:**

- Full event queue visualization with filtering
- Event detail panel with payload inspection
- Retry mechanism for failed events
- Server endpoints: `GET /api/events`, `POST /api/events/:id/retry`

**Files:**

- `packages/client/src/features/system/EventsView.tsx` (enhance existing `EventStreamTab`)
- `packages/server/src/events/routes.ts` (new or enhance)

---

## 7. Files View Enhancements (§P.6)

**Voice-ui has:** `FilesView.tsx` — full IDE-like file browser:

- VSCode-style tree sidebar with recursive expansion
- Monaco editor integration for code editing
- Markdown preview mode
- Context menu (create file/folder, rename, delete)
- Edit/view mode toggle
- URL persistence (deep-link to files)
- Mobile drawer for tree
- Download file
- File size and modification date display

**Sovereign has:** `FileViewerTab.tsx` in workspace tabs and `FileExplorerPanel.tsx` in workspace panels.

**Status:** Sovereign has the feature split across workspace panels/tabs which is architecturally correct. Gaps:

**SHOULD implement:**

- Monaco editor integration (if not already present)
- Context menu (create/rename/delete)
- Markdown preview toggle
- File download

### §P.6.1 File Open from Chat

**Voice-ui has:** `openFile(filePath, mode)` function in `stores/app.ts` (L313) — allows agent messages to open files in the editor by clicking paths.

**Sovereign has:** Check if workspace store has equivalent file-open routing.

**SHOULD implement** if missing:

- Clickable file paths in chat messages that open in workspace file viewer

---

## 8. Recording/Voice Enhancements (§P.7)

**Voice-ui has:**

- `RecordingView.tsx` — full recording management UI:
  - Start/stop system audio + mic recording
  - List past recordings with size, date
  - Transcription with progress tracking
  - Speaker timeline visualization
  - Upload audio files for transcription
  - Accepted formats: mp3, m4a, aac, ogg, opus, flac, wav, webm, wma, amr, mp4
- `VoiceView.tsx` — live voice interaction:
  - Push-to-talk with timer
  - Voice-to-text transcription
  - Text-to-speech playback
  - Voice state machine (idle → listening → processing → speaking)
- Server: `recording/` module with start/stop/list/transcribe endpoints

**Sovereign has:**

- `RecordingView.tsx` in `features/voice/` — exists
- `VoiceView.tsx` in `features/voice/` — exists
- `ThreadVoice.tsx` — per-thread voice component
- Server: `recordings/` routes (list, upload, search, transcribe)

**Status:** Largely ported. Gaps:

**SHOULD implement:**

- Speaker timeline visualization (`SpeakerTimeline.tsx` exists in meetings — verify recording view uses it)
- Upload drag-and-drop for audio files
- Transcription progress polling
- Voice message playback in chat (`VoiceMessage.tsx` exists — verify integration)

---

## 9. UI Polish Issues (§P.8)

### §P.8.1 Menu/Navigation

**Voice-ui has:** `Header.tsx` with:

- View mode tabs (Chat, Dashboard, System, Files, Plans, Events, Recordings, Notifications)
- Thread drawer toggle
- Settings gear icon
- Context budget button
- Agent status indicator with spinner

**Sovereign has:** `Header.tsx` in `features/nav/` + `ViewMenu.tsx`

**SHOULD verify:**

- All view modes are accessible
- No duplicate labels in menu items
- Mobile-responsive header collapse

### §P.8.2 Theme System

**Voice-ui has:** 5 themes: light, dark, system, ironman, jarvis. Theme stored in localStorage, applied via CSS custom properties. `SettingsModal.tsx` with theme picker.

**Sovereign has:** `theme/store.ts` + `theme/themes.ts` — themes infrastructure exists.

**SHOULD verify:**

- All 5 themes are defined with complete CSS variable sets
- Theme picker in settings modal works
- System theme auto-detection (prefers-color-scheme)

### §P.8.3 Icon Rendering

**Voice-ui has:** Inline SVG icons throughout (no icon library dependency). Copy button on code blocks, tool call icons in WorkSection.

**Sovereign has:** `ui/icons.tsx` — centralized icon components.

**Status:** ✅ Better architecture. SHOULD verify all icons render correctly.

### §P.8.4 Markdown Rendering

**Voice-ui has:** `lib/markdown.ts` — custom markdown renderer with:

- Code syntax highlighting
- Copy button injection on `<pre>` blocks
- Inline code copy buttons
- HTML escaping
- Link target="\_blank"

**Sovereign has:** `features/chat/MarkdownContent.tsx`

**SHOULD verify:**

- Code block copy buttons work
- Inline code copy buttons work
- Syntax highlighting present

### §P.8.5 Message Bubble Context Menu

**Voice-ui has:** `MessageBubble.tsx` — right-click/long-press context menu with:

- Copy message text
- Copy as markdown
- Export as PDF
- Export thread as PDF
- Download as text
- Remove pending turn

**Sovereign has:** `MessageBubble.tsx` in `features/chat/`

**SHOULD verify:**

- Context menu with all export options
- Long-press support for mobile
- Position adjustment to stay in viewport

---

## 10. Server-Side Gaps (§P.9)

### §P.9.1 Missing Server Endpoints

| Endpoint | Voice-ui module | Sovereign status |
| --- | --- | --- |
| `GET /api/architecture` (full) | `architecture.ts` (1500+ lines) | Partial — modules only |
| `GET /api/context-budget` | `architecture.ts` | ❌ Missing |
| `POST /api/retry` | `retry.ts` | ❌ Missing |
| `GET /api/sessions/tree` | `sessions.ts` | ❌ Missing |
| `GET /api/logs` | `logs.ts` | ❌ Missing (Sovereign has LogsTab but unclear backend) |
| `GET /api/files/*` | `files.ts` | ❌ Missing (Sovereign has FileExplorer but unclear backend) |
| `GET /api/plans/*` | `plans.ts` | Sovereign has `/api/orgs/:orgId/planning/*` — different shape |
| `GET /api/events` | `events.ts` | ❌ Missing |
| `GET /api/export` | `export.ts` | ❌ Missing |
| `GET /api/notifications` | `notifications/` | ❌ Missing (Sovereign has NotificationFeed but unclear backend) |
| `GET /api/watchdog` | `index.ts` L69 | ❌ Missing |
| `POST /api/threads/clear-lock` | `index.ts` L138 | ❌ Missing |
| `POST /api/threads/switch-model` | `index.ts` L173 | ❌ Missing |
| `POST /api/threads/stop` | `index.ts` L219 | ❌ Missing |
| `GET /api/threads` | `index.ts` L248 | ❌ Missing |
| `GET /api/holons/*` | `holons/` | ❌ Missing |

### §P.9.2 Gateway Proxy

**Voice-ui has:** Full WebSocket proxy to OpenClaw gateway with:

- Device identity (keypair generation, signing)
- Token-based auth with device tokens
- Reconnection with exponential backoff
- Protocol versioning
- Session key management

**Sovereign has:** `ws/ws-store.ts` — generic WS pub/sub. No gateway proxy, no device identity.

**MUST implement** (if Sovereign needs to talk to OpenClaw gateway):

- Device identity system (`lib/device-identity.ts`)
- Gateway WS protocol handler
- Token refresh flow

### §P.9.3 Notifications System

**Voice-ui has:** `stores/notifications.ts` — full notification store with:

- Priority levels (critical, high, medium, low)
- Status tracking (pending, auto-handled, dismissed, responded)
- Auto-handled vs needs-input categorization
- Dismiss/respond actions
- Thread targeting (navigate to thread from notification)
- `NotificationsView.tsx` — dedicated view with sections

**Sovereign has:** `NotificationFeed.tsx` in dashboard, `NotificationsPanel.tsx` in workspace.

**SHOULD verify:**

- Notification store with priority/status tracking
- Server endpoint for fetching/managing notifications
- Real-time notification delivery via WS

### §P.9.4 Thread Management

**Voice-ui has:** `ThreadDrawer.tsx` with:

- Session tree (main, threads, cron, cron-runs, subagents, event-agents)
- Hidden threads (localStorage-backed)
- Thread status (tokens, updated time)
- Cron job association per thread
- Create new thread
- Switch thread
- Auto-refresh polling

**Sovereign has:** `ThreadDrawer.tsx` in `features/threads/`, `ThreadsPanel.tsx` in workspace.

**SHOULD verify:**

- Full session tree hierarchy
- Hidden thread management
- Cron job association
- Thread status display

### §P.9.5 Export System

**Voice-ui has:** `lib/export.ts` + `MessageBubble.tsx`:

- Export message as markdown/text/PDF
- Export entire thread as markdown/PDF
- Server-side export endpoint

**Sovereign has:** `features/chat/export.ts`

**SHOULD verify:** Export functions match voice-ui's capabilities.

---

## 11. File Structure

### New Files to Create

```
packages/client/src/
├── ui/
│   └── SectionCard.tsx                    # §P.1.4 — reusable collapsible card
├── features/
│   ├── system/
│   │   ├── ContextBudgetModal.tsx         # §P.2 — context budget overlay
│   │   ├── FlowGraph.tsx                  # §P.1.2 — system flow visualization
│   │   └── HealthTimeline.tsx             # §P.1.3 — health metrics chart
│   └── chat/
│       └── strip-thinking.ts             # §P.3.5 — thinking block stripping

packages/server/src/
├── chat/
│   └── retry.ts                          # §P.3.2 — rate limit retry endpoint
├── system/
│   ├── architecture-full.ts              # §P.1.1 — full architecture data
│   ├── context-budget.ts                 # §P.2 — context budget report
│   └── health-history.ts                 # §P.1.3 — health metrics history
├── events/
│   └── routes.ts                         # §P.5 — event queue endpoints
├── sessions/
│   └── tree.ts                           # §P.9.1 — session tree endpoint
└── threads/
    └── management.ts                     # §P.9.4 — thread lock/stop/switch
```

### Files to Modify

```
packages/client/src/features/system/SystemView.tsx    # Add Overview tab with SectionCards
packages/client/src/features/system/ArchitectureTab.tsx  # Expand with full data
packages/client/src/features/system/EventStreamTab.tsx   # Enhance with queue viz
packages/client/src/features/chat/store.ts            # Add lifecycle suppression, pending persistence
packages/client/src/features/chat/InputArea.tsx        # Add retry countdown display, compaction indicator
packages/client/src/features/chat/ChatView.tsx         # Add streaming thinking-block stripping
packages/client/src/features/nav/Header.tsx            # Add context budget button
packages/server/src/index.ts                           # Register new routes
```

---

## 12. Implementation Waves

### Wave 1: Core Infrastructure (no UI dependencies)

**Priority: MUST**

1. `SectionCard` UI component
2. `strip-thinking.ts` utility
3. Server: expand `/api/system/architecture` response
4. Server: `POST /api/chat/retry` endpoint
5. Chat store: lifecycle suppression after abort
6. Chat store: pending turn localStorage persistence

### Wave 2: System View Overhaul

**Priority: MUST**

7. SystemView Overview tab with 16 SectionCards
8. `ContextBudgetModal` + server endpoint
9. Header: context budget button
10. InputArea: retry countdown display + compaction indicator

### Wave 3: Operational Views

**Priority: SHOULD**

11. `HealthTimeline` component + server health history endpoint
12. `FlowGraph` component (system flow visualization)
13. Events view enhancement (queue viz, detail panel, retry)
14. Session tree endpoint + ThreadDrawer hierarchy

### Wave 4: Polish & Verification

**Priority: SHOULD/MAY**

15. Verify all theme variables complete across 5 themes
16. Verify markdown copy buttons (code blocks + inline)
17. Verify message context menu (export PDF, download)
18. Verify file explorer (create/rename/delete context menu)
19. Verify notification store + priority system
20. Verify voice recording upload + transcription progress
21. Thread management endpoints (clear-lock, switch-model, stop)

### Wave 5: Advanced Features

**Priority: MAY**

22. Device identity system (gateway auth)
23. Holons integration
24. Watchdog endpoint
25. Plans sync status card (cross-reference with planning feature)
26. Export system (thread PDF export)

---

## Appendix A: Feature Comparison Matrix

| Feature               | Voice-UI            | Sovereign           | Gap                           |
| --------------------- | ------------------- | ------------------- | ----------------------------- |
| Chat send/receive     | ✅                  | ✅                  | —                             |
| Abort in-flight       | ✅ Full             | ⚠️ Partial          | Lifecycle suppression missing |
| Rate limit retry      | ✅ Server+client    | ⚠️ Client only      | Server endpoint missing       |
| Pending turn persist  | ✅ localStorage     | ❌ Memory only      | Missing                       |
| Draft persistence     | ✅                  | ✅                  | —                             |
| Streaming HTML        | ✅ + strip thinking | ⚠️ No strip         | strip-thinking missing        |
| Compaction indicator  | ✅                  | ✅ Signal only      | UI render verification needed |
| Optimistic turns      | ✅                  | ✅                  | —                             |
| Architecture overview | ✅ 16 cards         | ❌ Module list only | Missing                       |
| System flow graph     | ✅                  | ❌                  | Missing                       |
| Health timeline       | ✅ Canvas charts    | ⚠️ Placeholder      | Missing                       |
| Context budget modal  | ✅ 511-line modal   | ❌                  | Missing                       |
| Thread drawer         | ✅ Session tree     | ✅                  | Verify hierarchy              |
| Thread quick-switch   | ✅ Cmd+K            | ✅ Component exists | Verify shortcut               |
| Notifications view    | ✅ Priority+status  | ⚠️ Feed only        | Store/priority missing        |
| Events view           | ✅ Queue+detail     | ⚠️ Stream only      | Queue viz missing             |
| Files view (editor)   | ✅ Monaco           | ⚠️ Viewer           | Context menu, Monaco TBD      |
| Recording view        | ✅                  | ✅                  | Minor gaps                    |
| Voice interaction     | ✅                  | ✅                  | —                             |
| 5 themes              | ✅                  | ✅                  | Verify completeness           |
| Message export        | ✅ PDF+MD+text      | ⚠️                  | Verify all formats            |
| Scratchpad            | ✅                  | ✅                  | —                             |
| Message history (↑↓)  | ✅                  | ✅                  | —                             |
| File attachments      | ✅ DnD+upload       | ✅                  | Verify DnD                    |
| Work section          | ✅ Tool pairs       | ✅                  | Verify rendering              |
| Settings modal        | ✅                  | ✅                  | Verify feature parity         |
| Plans view            | ✅ Canvas+Kanban    | ✅ Planning feature | Different architecture        |
| Logs view             | ✅ Filtered+search  | ✅ LogsTab          | Verify server backend         |
| Multi-org workspaces  | ❌                  | ✅                  | Sovereign exceeds             |
| Meeting management    | ❌                  | ✅                  | Sovereign exceeds             |
| Canvas/whiteboard     | ❌                  | ✅                  | Sovereign exceeds             |
| Radicle integration   | ❌                  | ✅                  | Sovereign exceeds             |
| Git panel             | ❌                  | ✅                  | Sovereign exceeds             |
| Terminal panel        | ❌                  | ✅                  | Sovereign exceeds             |

## Appendix B: RFC 2119 Keyword Summary

- **MUST:** 17 requirements (Waves 1–2)
- **SHOULD:** 19 requirements (Waves 3–4)
- **MAY:** 5 requirements (Wave 5)
