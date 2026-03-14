# Sovereign — E2E Test Plan

> Date: 2026-03-14 | Status: Draft | Tooling: Playwright

---

## 1. Overview

### Purpose

This document defines every user-facing scenario that must work for the Sovereign alpha release. Each user story maps to a Playwright `test.todo()` stub ready for implementation.

### Scope

All features across Phases 1–8: five views (Dashboard, Workspace, Canvas, Planning, System), cross-cutting concerns (navigation, themes, voice, threads, chat, meetings, recordings, settings, mobile, WebSocket).

### Philosophy

- **Happy paths first.** Every feature gets at least one P0/P1 test proving the core flow works.
- **Stubs only.** No implementations yet — this plan establishes coverage targets.
- **Real routes, real components.** IDs reference actual components in the codebase (e.g. `DashboardView`, `MeetingsPanel`, `FileViewerTab`).

### Tooling

- **Playwright** (`@playwright/test ^1.40.0`) — already installed in `@sovereign/client`
- **Config:** `packages/client/playwright.config.ts` — `e2e/` test dir, Chromium + iPhone 14 projects
- **Dev server:** auto-started via `npm run dev` on `https://localhost:3000`

---

## 2. Test Infrastructure

### Running Tests

```bash
pnpm --filter @sovereign/client test          # all E2E tests
pnpm --filter @sovereign/client exec playwright test --project=chromium
pnpm --filter @sovereign/client exec playwright test --project=mobile
pnpm --filter @sovereign/client exec playwright test dashboard.spec.ts
```

### Global Setup (`e2e/setup/global-setup.ts`)

1. Start dev server (handled by Playwright `webServer` config)
2. Seed test data: create test org, test thread, test recording/meeting
3. Store auth/session state for reuse

### Global Teardown (`e2e/setup/global-teardown.ts`)

1. Clean up test data (delete test org, meetings, recordings)
2. Close connections

### Test Data (`e2e/fixtures/test-data.ts`)

- Test org: `{ id: 'test-org', name: 'Test Workspace' }`
- Test thread: `{ key: 'test-thread', title: 'Test Thread' }`
- Test meeting: `{ title: 'Test Meeting', duration: 300000 }`
- Test recording audio (tiny WebM blob)

---

## 3. User Stories by View

### 3.1 Dashboard View

Components: `DashboardView`, `WorkspaceCard`, `GlobalChat`, `VoiceWidget`, `NotificationFeed`, `HealthPanel`, `MeetingWidget`, `ActivityFeed`, `ThreadQuickSwitch`

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-DASH-001 | As a user, I open Sovereign and see workspace cards with activity | At least one org exists | 1. Navigate to `/` (dashboard) | Workspace cards render with org name, git status summary, agent thread count | P0 |
| US-DASH-002 | As a user, I can chat with my agent from the dashboard | WebSocket connected | 1. Type message in GlobalChat 2. Press Enter | Message appears in chat, agent response streams in | P0 |
| US-DASH-003 | As a user, I use voice-only mode from the dashboard | Microphone permission granted | 1. Tap VoiceWidget record button 2. Speak 3. Stop recording | Audio transcribed, sent as message, TTS response plays | P1 |
| US-DASH-004 | As a user, I see all notifications across workspaces | Notifications exist | 1. View NotificationFeed on dashboard | Notifications grouped by workspace, clickable to jump to context | P1 |
| US-DASH-005 | As a user, I quick-switch into a workspace from its card | Multiple orgs exist | 1. Click workspace card | Navigates to workspace view scoped to that org | P0 |
| US-DASH-006 | As a user, I see system health status on the dashboard | Server running | 1. Load dashboard | HealthPanel shows connection status (connected/disconnected) | P0 |
| US-DASH-007 | As a user, I see recent meetings in the dashboard widget | Meetings exist | 1. Load dashboard | MeetingWidget shows last 5 meetings with summaries | P1 |
| US-DASH-008 | As a user, I see pending transcription count in meeting widget | Pending transcriptions exist | 1. Load dashboard | MeetingWidget shows pending count | P2 |
| US-DASH-009 | As a user, I see action items needing attention | Open action items exist | 1. Load dashboard | MeetingWidget shows open/overdue action items | P2 |
| US-DASH-010 | As a user, I see activity feed with recent events | Events exist | 1. Load dashboard | ActivityFeed shows recent workspace activity | P1 |
| US-DASH-011 | As a user, I quick-switch threads from dashboard | Multiple threads exist | 1. Click thread in ThreadQuickSwitch | Opens thread in appropriate context | P1 |

### 3.2 Workspace View

Components: `WorkspaceView`, `WorkspaceHeader`, sidebar panels (`FileExplorerPanel`, `GitPanel`, `ThreadsPanel`, `PlanningPanel`, `NotificationsPanel`, `TerminalPanel`, `RecordingsPanel`, `LogsPanel`), main content tabs (`FileViewerTab`, `DiffViewerTab`, `EntityDetailTab`, `PlanningTab`, `ChatThreadTab`)

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-WS-001 | As a user, I select a workspace and see projects in sidebar | Org with projects exists | 1. Navigate to workspace view 2. Select org | FileExplorerPanel shows project tree with git status indicators | P0 |
| US-WS-002 | As a user, I open a file and view it with syntax highlighting | Project with files exists | 1. Click file in FileExplorerPanel | FileViewerTab opens with syntax-highlighted content and git diff markers | P0 |
| US-WS-003 | As a user, I open a terminal scoped to a project | Workspace selected | 1. Click Terminal sidebar tab | TerminalPanel opens with embedded PTY | P1 |
| US-WS-004 | As a user, I see active threads with status indicators | Threads exist for workspace | 1. Click Threads sidebar tab | ThreadsPanel shows threads with busy/unread/stuck/error indicators | P0 |
| US-WS-005 | As a user, I open a thread in the chat panel | Thread exists | 1. Click thread in ThreadsPanel | ChatThreadTab shows chat history and live events | P0 |
| US-WS-006 | As a user, I see planning overview in sidebar | Planning items exist | 1. Click Planning sidebar tab | PlanningPanel shows ready/blocked/in-progress counts | P1 |
| US-WS-007 | As a user, I view diffs in main content | File changes exist | 1. Open diff from git panel | DiffViewerTab shows side-by-side or unified diff | P1 |
| US-WS-008 | As a user, I have multiple tabs open in main content | — | 1. Open a file 2. Open a diff 3. Open planning | Multiple tabs visible, switchable, chat panel remains | P0 |
| US-WS-009 | As a user, I switch between projects without losing tab state | Multiple projects in org | 1. Open tabs in project A 2. Switch to project B 3. Switch back | Tab state preserved per project | P1 |
| US-WS-010 | As a user, I record audio and it auto-transcribes | Microphone available | 1. Click Recordings sidebar tab 2. Record audio 3. Stop | Recording saved to server, transcription starts automatically | P1 |
| US-WS-011 | As a user, I expand chat to full-screen mode | Chat panel visible | 1. Click expand button (or Cmd+Shift+E) | Chat fills entire workspace area, back button visible | P0 |
| US-WS-012 | As a user, I collapse expanded chat back to panel | Chat in expanded mode | 1. Click back button (or Cmd+Shift+E) | Returns to multi-panel workspace layout | P0 |
| US-WS-013 | As a user, I resize the chat panel | Workspace view active | 1. Drag chat panel divider | Panel resizes between 280px–600px | P2 |
| US-WS-014 | As a user, I see git status in sidebar | Git repo with changes | 1. Click Git sidebar tab | GitPanel shows branches, staging area, commit history | P0 |
| US-WS-015 | As a user, I see notifications scoped to workspace | Workspace notifications exist | 1. Click Notifications sidebar tab | NotificationsPanel shows workspace-scoped notifications | P1 |
| US-WS-016 | As a user, I see logs for the workspace | Log events exist | 1. Click Logs sidebar tab | LogsPanel shows filterable agent/build/event logs | P1 |
| US-WS-017 | As a user, I switch sidebar tabs | Workspace view active | 1. Click different sidebar tab icons | Only one panel visible at a time, correct panel shows | P0 |
| US-WS-018 | As a user, I see the workspace header with breadcrumb | Workspace selected | 1. Load workspace view | Header shows Org > Project breadcrumb, workspace selector | P0 |
| US-WS-019 | As a user, I view entity details (issue/PR) | Issue/PR exists | 1. Click issue/PR link | EntityDetailTab opens with full details, comments, linked threads | P1 |

### 3.3 Holonic Canvas View

Components: `CanvasView`, canvas store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-CANVAS-001 | As a user, I see all workspaces as nodes on a canvas | Multiple orgs exist | 1. Navigate to Canvas view | Workspace nodes render with health/activity indicators | P1 |
| US-CANVAS-002 | As a user, I pan and zoom the canvas | Canvas loaded | 1. Drag to pan 2. Scroll to zoom | Canvas pans and zooms smoothly | P1 |
| US-CANVAS-003 | As a user, I click a workspace to zoom in | Canvas loaded | 1. Click workspace node | Zooms to show internal structure (projects, agents, threads) | P2 |
| US-CANVAS-004 | As a user, I see real-time event flow between workspaces | Cross-workspace events occurring | 1. Observe canvas | Animated connections show event flow | P2 |
| US-CANVAS-005 | As a user, I see the event stream overlay | Canvas loaded | 1. Open event stream | Live event feed filterable by workspace/type | P2 |

### 3.4 Global Planning View

Components: `GlobalPlanningView`, planning store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-PLAN-001 | As a user, I see all planned work across workspaces | Planning items exist | 1. Navigate to Planning view | Unified view shows items from all orgs | P1 |
| US-PLAN-002 | As a user, I identify the critical path | Dependencies defined | 1. View DAG | Critical path highlighted across workspaces | P2 |
| US-PLAN-003 | As a user, I see blocked items and their blockers | Blocked items exist | 1. View planning | Blocked items prominently displayed with blocker info | P1 |
| US-PLAN-004 | As a user, I create an issue from planning view | Workspace exists | 1. Click create 2. Fill details 3. Save | Issue created in target workspace | P1 |
| US-PLAN-005 | As a user, I switch between DAG/kanban/list/tree views | Planning items exist | 1. Click view toggle | View switches between DAG, kanban, list, tree | P1 |
| US-PLAN-006 | As a user, I filter by workspace/status/assignee | Multiple items exist | 1. Apply filters | Items filtered accordingly | P1 |

### 3.5 System View

Components: `SystemView`, `ArchitectureTab`, `LogsTab`, `HealthTab`, `ConfigTab`, `DevicesTab`, `JobsTab`, `EventStreamTab`

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-SYS-001 | As a user, I see module architecture with health indicators | System running | 1. Navigate to System view | ArchitectureTab shows module graph with green/yellow/red status | P1 |
| US-SYS-002 | As a user, I search and filter logs | Log entries exist | 1. Click Logs tab 2. Enter search term 3. Apply filters | Filtered log entries displayed | P1 |
| US-SYS-003 | As a user, I edit configuration and see it applied | Config loaded | 1. Click Config tab 2. Edit value 3. Save | Config updates immediately (hot-reload) | P1 |
| US-SYS-004 | As a user, I see scheduled jobs and run history | Jobs exist | 1. Click Jobs tab | Job list with next run times, recent history | P2 |
| US-SYS-005 | As a user, I manage device pairing | Devices connectable | 1. Click Devices tab | Connected devices listed, pairing UI available | P2 |
| US-SYS-006 | As a user, I see system health overview | System running | 1. Click Health tab | Connection status, resources, error rates displayed | P0 |
| US-SYS-007 | As a user, I switch between system tabs | System view active | 1. Click different tabs | Correct tab content renders | P0 |
| US-SYS-008 | As a user, I see the event stream in real time | Events flowing | 1. Click Event Stream tab | Live events displayed, filterable | P1 |

---

## 4. Cross-Cutting User Stories

### 4.1 Navigation

Components: `Header`, `ViewMenu`, nav store, `useKeyboardShortcuts`

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-NAV-001 | As a user, I navigate between views via dropdown menu | App loaded | 1. Click view menu in header 2. Select view | View switches, menu highlights active view | P0 |
| US-NAV-002 | As a user, I use Cmd+1 through Cmd+5 to switch views | App loaded | 1. Press Cmd+1 | Switches to Dashboard | P0 |
| US-NAV-003 | As a user, I use Cmd+Shift+E to toggle expanded chat | In workspace view | 1. Press Cmd+Shift+E | Chat toggles between expanded/panel mode | P0 |
| US-NAV-004 | As a user, I use Cmd+B to toggle sidebar | In workspace view | 1. Press Cmd+B | Sidebar toggles visibility | P1 |
| US-NAV-005 | As a user, I see the connection badge in header | App loaded | 1. Observe header | Connection badge shows connected/disconnected | P0 |

### 4.2 Theme Switching

Components: theme store, `themes.ts`

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-THEME-001 | As a user, I switch between themes | App loaded | 1. Open settings 2. Select theme (default/light/ironman/jarvis) | UI updates with new color scheme | P1 |
| US-THEME-002 | As a user, my theme preference persists | Theme changed | 1. Change theme 2. Reload page | Same theme applied on reload | P1 |

### 4.3 Voice Interaction

Components: `VoiceView`, `VoiceWidget`, `ThreadVoice`, voice store, audio utils

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-VOICE-001 | As a user, I record voice in dashboard VoiceWidget | Mic available | 1. Click record 2. Speak 3. Stop | Audio captured, transcription initiated | P1 |
| US-VOICE-002 | As a user, I toggle voice mode in a thread | In thread chat | 1. Click mic icon in input area | Input switches to push-to-talk mode | P1 |
| US-VOICE-003 | As a user, I hear TTS for agent responses | Voice mode on, agent responded | 1. Agent sends response | TTS plays response audio (per §8.5.2) | P1 |
| US-VOICE-004 | As a user, I click play on an assistant message | Message exists | 1. Click play button on message | TTS synthesizes and plays, stop button appears | P1 |
| US-VOICE-005 | As a user, I hear an immediate acknowledgment after voice input | Voice mode on, ackDelayMs not exceeded | 1. Send voice message 2. Wait | Acknowledgment plays within ackDelayMs if agent hasn't responded (per §8.5.2.2) | P2 |
| US-VOICE-006 | As a user, TTS only plays on my device | Multiple devices connected | 1. Send voice message from device A | TTS plays only on device A, text syncs to all devices (per §8.5.2.0) | P2 |

### 4.4 Thread Management

Components: `ThreadDrawer`, `ThreadsPanel`, `ForwardDialog`, threads store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-THREAD-001 | As a user, I create a new thread | Workspace selected | 1. Click create thread 2. Enter title | New thread appears in list | P0 |
| US-THREAD-002 | As a user, I switch between threads | Multiple threads exist | 1. Click different thread | Chat panel switches to selected thread | P0 |
| US-THREAD-003 | As a user, I see entity-bound threads | Entity threads exist | 1. View threads panel | Threads categorized: entity-bound, user-created, agent-spawned | P1 |
| US-THREAD-004 | As a user, I forward a message to another thread | Message exists | 1. Click forward 2. Select target thread | Message forwarded, appears in target thread | P1 |

### 4.5 Chat

Components: `ChatView`, `InputArea`, `MessageBubble`, `MarkdownContent`, `WorkSection`, `VoiceMessage`, chat store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-CHAT-001 | As a user, I send a text message | Thread active | 1. Type message 2. Press Enter | Message appears in chat | P0 |
| US-CHAT-002 | As a user, I see agent response streaming in | Message sent | 1. Wait for response | Agent response streams with thinking indicator | P0 |
| US-CHAT-003 | As a user, I see thinking blocks in responses | Agent uses thinking | 1. Observe response | Thinking blocks collapsible/expandable | P1 |
| US-CHAT-004 | As a user, I see work sections in responses | Agent performs work | 1. Observe response | Work items displayed with status | P1 |
| US-CHAT-005 | As a user, I export a conversation | Messages exist | 1. Click export | Conversation exported as text/markdown | P2 |
| US-CHAT-006 | As a user, I see markdown rendered in messages | Agent sends markdown | 1. Observe response | Markdown renders correctly (headers, code, links, lists) | P0 |
| US-CHAT-007 | As a user, I see voice-originated messages with audio player | Voice message sent | 1. View message | VoiceMessage component shows audio player + transcript | P1 |

### 4.6 Meetings (per Phase 8, §8.9)

Components: `MeetingsPanel`, `MeetingDetail`, `MeetingCard`, `TranscriptView`, `ActionItems`, `SpeakerTimeline`, `ImportDialog`, meetings store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-MEET-001 | As a user, I see meeting list in workspace sidebar | Meetings exist | 1. Click Meetings sidebar tab | MeetingsPanel shows meetings sorted by date with status badges | P0 |
| US-MEET-002 | As a user, I open a meeting detail view | Meeting exists | 1. Click meeting card | MeetingDetail opens in main content with Summary/Transcript/Action Items/Audio tabs | P0 |
| US-MEET-003 | As a user, I view a timestamped transcript with speaker labels | Transcript completed | 1. Open meeting 2. Click Transcript tab | TranscriptView shows color-coded speaker segments with timestamps | P1 |
| US-MEET-004 | As a user, I rename a speaker label | Transcript with speakers exists | 1. Click speaker label 2. Enter name | Speaker label updated across meeting | P1 |
| US-MEET-005 | As a user, I manage action items | Summary completed | 1. Click Action Items tab 2. Toggle item done/open | ActionItems checklist updates status | P1 |
| US-MEET-006 | As a user, I import an external meeting | — | 1. Click Import 2. Upload file 3. Fill title | ImportDialog accepts file, meeting created with transcription/summarization pipeline | P1 |
| US-MEET-007 | As a user, I search meetings | Multiple meetings exist | 1. Type in search bar | Results filter by title, summary, transcript text | P1 |
| US-MEET-008 | As a user, I see the speaker timeline | Diarized transcript exists | 1. Click Audio tab | SpeakerTimeline shows colored bars per speaker with waveform | P2 |
| US-MEET-009 | As a user, I click a timestamp to seek audio | Audio + transcript exists | 1. Click timestamp in transcript | Audio player seeks to that position | P2 |
| US-MEET-010 | As a user, I re-trigger transcription | Meeting with failed/no transcript | 1. Click re-transcribe button | Transcription restarts, status updates in real time | P2 |
| US-MEET-011 | As a user, I re-trigger summarization | Transcript exists, no summary | 1. Click re-summarize button | Summarization starts, summary appears when complete | P2 |

### 4.7 Recordings

Components: `RecordingsPanel`, `VoiceView`, `RecordingView`, voice store

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-REC-001 | As a user, I start/stop a recording in workspace | Mic available | 1. Click Record in RecordingsPanel 2. Speak 3. Stop | Recording saved to server, appears in list | P1 |
| US-REC-002 | As a user, recording auto-creates a meeting | autoTranscribe enabled | 1. Complete a recording | Meeting auto-created, transcription starts | P1 |
| US-REC-003 | As a user, I play back a recording | Recording exists | 1. Click play on recording | Audio plays with seek support | P1 |
| US-REC-004 | As a user, I see transcription status on recordings | Recording being transcribed | 1. View recording list | Status badge shows none/pending/completed/failed | P1 |

### 4.8 Settings

Components: `SettingsModal`

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-SET-001 | As a user, I open the settings modal | App loaded | 1. Open settings (via menu or shortcut) | SettingsModal opens with configuration options | P1 |
| US-SET-002 | As a user, I change a setting and it applies | Settings open | 1. Change setting 2. Close modal | Setting applied immediately | P1 |

### 4.9 Responsive / Mobile

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-MOB-001 | As a mobile user, I swipe between workspace panels | Mobile viewport | 1. Swipe left/right | Panels switch one at a time, filling viewport | P1 |
| US-MOB-002 | As a mobile user, I see only one panel at a time | Mobile viewport | 1. Load workspace view | Single panel fills screen, tab strip for switching | P1 |
| US-MOB-003 | As a mobile user, tapping a file switches to file viewer | In Files panel | 1. Tap file | Auto-switches to file viewer panel | P1 |
| US-MOB-004 | As a mobile user, tapping a thread switches to chat | In Threads panel | 1. Tap thread | Auto-switches to chat panel | P1 |
| US-MOB-005 | As a mobile user, I use touch pan/zoom on canvas | Canvas view, touch device | 1. Pinch/pan | Canvas responds to touch gestures | P2 |

### 4.10 WebSocket / Real-time

| ID | Story | Preconditions | Steps | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- |
| US-WS-RT-001 | As a user, I see real-time updates via WebSocket | WS connected | 1. Another source triggers an event | UI updates without refresh | P0 |
| US-WS-RT-002 | As a user, the connection auto-reconnects | WS disconnected | 1. Connection drops 2. Wait | Connection re-establishes, status updates | P0 |
| US-WS-RT-003 | As a user, I see meeting updates in real time | Meeting transcription running | 1. Observe meetings panel | Status badges update as transcript/summary complete | P1 |

---

## 5. API Happy Paths

Key REST endpoints exercised through UI interactions (not tested directly — validated by the user stories above):

| Endpoint                                       | Exercised By             |
| ---------------------------------------------- | ------------------------ |
| `GET /api/orgs`                                | US-DASH-001, US-WS-001   |
| `GET /api/orgs/:orgId/files`                   | US-WS-002                |
| `GET /api/orgs/:orgId/git/*`                   | US-WS-014                |
| `POST /api/chat/message`                       | US-CHAT-001              |
| `GET /api/threads`                             | US-THREAD-001, US-WS-004 |
| `POST /api/threads`                            | US-THREAD-001            |
| `GET /api/orgs/:orgId/meetings`                | US-MEET-001              |
| `GET /api/orgs/:orgId/meetings/:id`            | US-MEET-002              |
| `POST /api/orgs/:orgId/meetings/import`        | US-MEET-006              |
| `PATCH /api/orgs/:orgId/meetings/:id/speakers` | US-MEET-004              |
| `GET /api/orgs/:orgId/recordings`              | US-REC-001               |
| `POST /api/orgs/:orgId/recordings`             | US-REC-001               |
| `GET /api/orgs/:orgId/recordings/:id/audio`    | US-REC-003               |
| `POST /api/voice/transcribe`                   | US-VOICE-001             |
| `POST /api/voice/tts`                          | US-VOICE-003             |
| `GET /api/config`                              | US-SYS-003               |
| `PATCH /api/config`                            | US-SYS-003               |
| `GET /api/system/modules`                      | US-SYS-001               |
| `GET /api/notifications`                       | US-DASH-004              |
| `GET /api/orgs/:orgId/planning`                | US-PLAN-001              |
| `GET /api/orgs/:orgId/diff/*`                  | US-WS-007                |
| `GET /api/orgs/:orgId/issues`                  | US-WS-019                |
| `GET /api/system/transcription/queue`          | US-MEET-010              |

---

## 6. Edge Cases & Error States

These are lower-priority but important for robustness:

| Scenario                                | Expected Behavior                                   | Priority |
| --------------------------------------- | --------------------------------------------------- | -------- |
| Server unreachable on load              | Dashboard shows disconnected state, retry indicator | P1       |
| WebSocket drops mid-chat                | Reconnection attempt, pending messages queued       | P1       |
| Recording upload exceeds 100MB          | 413 error, user-friendly message                    | P2       |
| Transcription fails                     | Status badge shows "failed", retry button available | P1       |
| Import unsupported file format          | 400 error with supported formats listed             | P2       |
| Empty workspace (no projects)           | Helpful empty state with "add project" prompt       | P1       |
| Theme switch during animation           | No visual glitch, clean transition                  | P2       |
| Keyboard shortcut conflict with browser | Sovereign shortcuts take precedence in-app          | P2       |

---

## Summary

- **Total user stories:** 96
- **P0 (critical):** 24
- **P1 (important):** 52
- **P2 (nice to have):** 20
- **Views covered:** 5 (Dashboard, Workspace, Canvas, Planning, System)
- **Cross-cutting areas:** 10 (Navigation, Themes, Voice, Threads, Chat, Meetings, Recordings, Settings, Mobile, WebSocket)
