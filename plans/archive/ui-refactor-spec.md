# UI Refactor: Shell Integration — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-03-13

This document specifies the refactoring of Sovereign's client from a chat-first mobile app into a multi-workspace IDE with agent orchestration. All requirements use MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119). All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md).

---

## Design Philosophy

**IDE-first, agent-oriented.** Sovereign is a multi-workspace IDE where the primary workflow is agent-driven development. Chat threads are contextual communication channels bound to entities (branches, issues, PRs), not the primary UI surface. The file explorer, git status, planning DAG, and terminal are first-class panels — not hidden behind view toggles.

**Shell as the backbone.** The existing `shell/` scaffolding (tabs, panels, sidebar, commands, dividers, status bar) becomes the core layout system. All Phase 6 features (chat, threads, voice, dashboard) integrate into the shell as panels, tabs, or views.

**Existing styles preserved.** All CSS tokens (`var(--c-*)`) from `app.css`, all 4 themes (default, light, ironman, jarvis), all Tailwind utility patterns, and all animations MUST be preserved. The refactor changes layout composition, not visual identity.

**Progressive disclosure.** Desktop shows the full IDE. Mobile collapses to essential panels with swipe/tap navigation. The same components render in both — layout adapts, content doesn't.

---

## Prerequisite: Global Workspace

### §0.1 Global Workspace Bootstrap

The server MUST ensure a workspace with org ID `_global` exists on startup. If it does not exist, the server MUST create it with:

- `name: "Global"`
- `provider: "radicle"` (immutable — cannot be changed to `"github"`)

The server MUST reject any attempt to set the Global workspace's provider to `"github"`. The server MUST reject any attempt to delete the `_global` workspace.

The Global workspace MUST be treated identically to all other workspaces in terms of capabilities (projects, threads, planning, terminals, files). It is distinguished only by its reserved ID and provider constraint.

### §0.2 Active Workspace Store

The client MUST maintain an `activeWorkspace` store in `features/workspace/store.ts`:

```typescript
export interface WorkspaceContext {
  orgId: string
  orgName: string
  activeProjectId: string | null
  activeProjectName: string | null
}
```

- The store MUST expose `activeWorkspace(): WorkspaceContext | null`.
- The store MUST expose `setActiveWorkspace(orgId: string): void`.
- The store MUST expose `setActiveProject(projectId: string): void`.
- The store MUST persist the last active workspace to `localStorage` under key `sovereign:active-workspace`.
- The store MUST restore the last active workspace on init.
- If no workspace was previously selected, the store MUST default to `_global`.
- The store MUST emit on the event bus when the workspace changes: `workspace.switched` with `{ orgId, projectId }`.
- All workspace-scoped API calls in the client MUST read from this store. No hardcoded org IDs.

---

## §1 Top-Level Navigation

### §1.1 View Menu

The client MUST render a dropdown view selector in the top-right area of the header (consistent with the current voice-ui header dropdown pattern).

- The selector MUST be a button showing the current view label + icon, which opens a dropdown menu on click.
- The dropdown MUST list all 5 views:

| Key         | Icon | Label     | Shortcut |
| ----------- | ---- | --------- | -------- |
| `dashboard` | 🏠   | Dashboard | `Cmd+1`  |
| `workspace` | 📁   | Workspace | `Cmd+2`  |
| `canvas`    | ⬡    | Canvas    | `Cmd+3`  |
| `planning`  | 📊   | Planning  | `Cmd+4`  |
| `system`    | ⚙️   | System    | `Cmd+5`  |

- Each item MUST show icon, label, and keyboard shortcut hint (muted text, right-aligned).
- The active view MUST show a check mark or `var(--c-accent)` highlight.
- The dropdown MUST use `var(--c-menu-bg)` background with `var(--c-border)` border.
- Clicking an item MUST switch views and close the dropdown.
- Clicking outside MUST close the dropdown.
- The navigation MUST support keyboard shortcuts `Cmd+1` through `Cmd+5` to switch views.
- The current view MUST persist to `localStorage` under key `sovereign:active-view`.
- The navigation MUST restore the last active view on init.
- If no view was previously selected, the client MUST default to `dashboard`.

### §1.2 Navigation Store

The client MUST maintain navigation state in `features/nav/store.ts`:

- `activeView(): NavView` — the currently active top-level view.
- `setActiveView(view: NavView): void` — switch views.
- `type NavView = 'dashboard' | 'workspace' | 'canvas' | 'planning' | 'system'`

The existing `viewMode` signal MUST be replaced by `activeView`. The existing `ViewMode` type MUST be removed.

### §1.3 App Root

`App.tsx` MUST be restructured:

```
┌──────────────────────────────────────────┐
│  Header  [workspace ▾] [...] [View ▾]   │
├──────────────────────────────────────────┤
│                                          │
│           Active View                    │
│   (dashboard | workspace |               │
│    canvas | planning | system)           │
│                                          │
└──────────────────────────────────────────┘
```

- `App.tsx` MUST render a shared header bar and a `<Switch>` over `activeView()`.
- The header MUST contain: workspace selector (left), connection badge, view menu dropdown (right).
- `App.tsx` MUST NOT contain feature-specific state (no chat signals, no thread signals in App.tsx).
- Each view MUST be a lazy-loaded component (`lazy(() => import(...))`) to avoid loading all views upfront.
- The theme class MUST be applied to `document.documentElement` (already done by theme store).

---

## §2 Dashboard View

`features/dashboard/DashboardView.tsx`

The Dashboard is the home screen — a grid of cards showing workspace summaries, global threads, and quick actions.

### §2.1 Layout

- The Dashboard MUST render as a scrollable single-column (mobile) or multi-column grid (desktop) layout.
- The Dashboard MUST NOT render a sidebar or bottom panel — it is full-width content.
- The background MUST be `var(--c-bg)`.
- Cards MUST use `var(--c-bg-raised)` background with `var(--c-border)` border and 8px border-radius.
- Cards MUST have 16px padding and 12px gap between cards.

### §2.2 Workspace Cards

- The Dashboard MUST fetch all orgs via `GET /api/orgs` on mount.
- For each org, the Dashboard MUST render a workspace card showing:
  - Org name as heading (`var(--c-text-heading)`, font-weight 600).
  - **Git summary**: count of projects with uncommitted changes, branches ahead/behind. Data from `GET /api/orgs/:orgId/projects` + per-project `GET /api/git/status?project=:projectId`.
  - **Thread summary**: count of active threads, count with unread messages, count with error/stuck status. Data from `GET /api/threads?orgId=:orgId` (new query param — see §9.1).
  - **Notification count**: unread notifications for this workspace. Data from the existing notification WS channel.
  - A click on the card MUST switch to the Workspace view with that org selected (`setActiveWorkspace(orgId)` then `setActiveView('workspace')`).
- The `_global` workspace card MUST render with a distinct label "Global" and a lock icon (🔒) indicating private/Radicle-only.
- Workspace cards MUST show a colored activity indicator: green (active agents), amber (pending notifications), grey (idle).

### §2.3 Global Chat

- The Dashboard MUST render a compact chat panel for the `main` thread of the `_global` workspace.
- This MUST show the last 5 messages (truncated), agent status indicator, and an input area.
- Sending a message MUST go through the same `chat.send` WS flow as the full ChatView.
- Clicking the chat panel header MUST switch to Workspace view → `_global` → main thread tab.

### §2.4 Voice Widget

- The Dashboard MUST render a voice interaction widget.
- The widget MUST show a large mic button (reuse `VoiceView` internals).
- Tapping MUST start recording; releasing or tapping again MUST stop and transcribe.
- Transcription text and agent response MUST appear inline below the button.
- Voice interaction MUST default to the `_global` main thread context.

### §2.5 Notification Feed

- The Dashboard MUST render a notification feed panel.
- Notifications MUST be sourced from the `notifications` WS channel (already implemented).
- Each notification MUST show: icon, workspace name, summary text, relative timestamp.
- Clicking a notification MUST navigate to the correct workspace + entity context.
- The feed MUST show a "Mark all read" action.

### §2.6 System Status Strip

- The Dashboard MUST render a small system status strip at the top or bottom.
- MUST show: connection status (dot: green/amber/red), agent backend status, active job count.
- Data from existing `status` WS channel.

---

## §3 Workspace View

The Workspace view is the full IDE. It uses a three-column layout on desktop: left sidebar, center content, right chat panel.

### §3.1 Desktop Layout

```
┌──────────────────────────────────────────────────────┐
│  [Tab] [Tab] [Tab] [Tab]  ← sidebar tab bar          │
├────────┬──────────────────────┬──────────────────────┤
│        │                      │                      │
│  Side  │   Main Content       │   Chat Panel         │
│  bar   │   (file viewer)      │   (thread chat)      │
│        │                      │                      │
│ 260px  │     flex-1           │     360px            │
│        │                      │                      │
├────────┴──────────────────────┴──────────────────────┤
│  (no status bar)                                      │
└──────────────────────────────────────────────────────┘
```

- The Workspace MUST render three columns: sidebar (left), main content (center), chat panel (right).
- The sidebar MUST have a tab bar at the top. Tabs switch the sidebar content. Tabs include:
  - **Files** — file explorer tree
  - **Git** — git status, branches, changes
  - **Threads** — thread list for the workspace
  - **Planning** — compact planning summary
  - **Notifications** — workspace notifications
  - **Terminal** — embedded terminal(s)
  - **Recordings** — audio recordings
  - **Logs** — event/log stream
- Only one sidebar tab is visible at a time.
- The main content area MUST show the file viewer (or diff viewer, issue detail, planning DAG — based on what the user opens from the sidebar).
- The main content area MUST support multiple open tabs (tab bar at top).
- The right panel MUST show the chat interface for the active thread.
- There MUST be NO status bar.
- All panels MUST scope their data to the active workspace (`orgId`) and active project (`projectId`).

### §3.2 Expand Chat Mode

- The chat panel MUST have a button (top-right of chat panel, e.g., expand icon ⤢) to expand chat to fill the entire workspace view area.
- When expanded, the chat MUST look and behave identically to the current voice-ui chat interface — same layout, same components, same styling.
- The expanded chat MUST show a button to return to the multi-panel workspace view (e.g., collapse icon ⤡ or "Back to Workspace").
- The expanded/collapsed state MUST be stored in the workspace store.
- The expanded chat MUST include the full header, input area, message list, voice controls, and thread drawer — exactly as the current voice-ui renders them.
- Keyboard shortcut: `Cmd+Shift+E` to toggle expand/collapse.

### §3.3 Sidebar Tabs

The sidebar MUST use a vertical tab bar at the top of the sidebar area. Each tab is an icon + label.

#### §3.3.1 Files Tab — File Explorer

`features/workspace/panels/FileExplorerPanel.tsx`

- MUST render a tree view of the active project's filesystem.
- MUST fetch file tree from `GET /api/files/tree?project=:projectId`.
- MUST subscribe to `files` WS channel (scoped to project) for live updates.
- Each tree node MUST show: file icon (based on extension — reuse existing `file-icons.ts`), filename, git status indicator (M/A/D/U/? as colored badge).
- Clicking a file MUST open it in a main content tab (FileViewerTab).
- Clicking a directory MUST expand/collapse it.
- Right-clicking a file MUST show a context menu: Open, Open Diff, Copy Path, Reveal in Terminal.
- The panel header MUST show the active project name with a dropdown to switch projects within the org.
- MUST show "No project selected" placeholder if no project is active.

#### §3.3.2 Git Tab

`features/workspace/panels/GitPanel.tsx`

- MUST show git status for the active project, fetched from `GET /api/git/status?project=:projectId`.
- MUST subscribe to `git` WS channel (scoped to project) for live status updates.
- MUST show: current branch name, ahead/behind counts, list of changed files (staged/unstaged/untracked).
- Each changed file MUST be clickable → opens diff in a main content tab.
- MUST show active worktrees for this project.
- SHOULD show branch selector dropdown for quick branch switching.
- SHOULD show quick-action buttons: Stage All, Commit, Push.

#### §3.3.3 Threads Tab

`features/workspace/panels/ThreadsPanel.tsx`

- MUST list all threads for the active workspace.
- MUST fetch from `GET /api/threads?orgId=:orgId` (see §9.1).
- MUST subscribe to `threads` WS channel for live thread updates.
- Threads MUST be grouped into sections:
  - **Entity-Bound**: threads linked to a branch, issue, or PR. Show entity type icon + reference.
  - **User Threads**: manually created threads. Show label.
  - **Agent Threads**: auto-created by agent orchestration. Show label + agent status.
- Each thread row MUST show: icon, label/entity ref, status indicator, unread message count badge.
- Clicking a thread MUST switch the right-panel chat to that thread.
- The panel MUST show a "New Thread" button.
- Hidden threads MUST be in a collapsible "Hidden" section.

#### §3.3.4 Planning Tab

`features/workspace/panels/PlanningPanel.tsx`

- MUST show a compact planning summary for the active workspace.
- MUST fetch from `GET /api/orgs/:orgId/planning/completion`.
- MUST show: total items, ready count, blocked count, in-progress count.
- Clicking "View Full DAG" MUST open a PlanningTab in main content area.
- MUST subscribe to `planning` WS channel for live updates.

#### §3.3.5 Notifications Tab

`features/workspace/panels/NotificationsPanel.tsx`

- MUST show workspace-scoped notifications.
- MUST subscribe to `notifications` WS channel.
- Each notification: icon, summary, relative timestamp, read/unread indicator.
- Clicking MUST navigate to the relevant entity (open the right tab in main content).
- MUST show "Mark all read" action.

#### §3.3.6 Terminal Tab

`features/workspace/panels/TerminalPanel.tsx`

- MUST render embedded terminal(s) using the existing `components/terminal/` components.
- MUST support multiple terminal instances as sub-tabs within the panel.
- Each terminal MUST be scoped to a project directory within the active workspace.
- MUST use the `terminal` WS channel for PTY data.
- "New Terminal" button MUST create a terminal and subscribe to its data stream.
- MUST support terminal resize on panel resize.

#### §3.3.7 Recordings Tab

`features/workspace/panels/RecordingsPanel.tsx`

- MUST show a list of audio recordings for the active workspace.
- Each recording: timestamp, duration, transcript preview, thread binding.
- MUST support playback inline.
- MUST support starting a new recording.
- Recordings MUST be persisted to `{dataDir}/recordings/{orgId}/`.

#### §3.3.8 Logs Tab

`features/workspace/panels/LogsPanel.tsx`

- MUST show a live event/log stream for the active workspace.
- MUST subscribe to relevant bus events via the WS protocol.
- Each log entry: timestamp, level (icon/color), module name, message.
- MUST support filtering by level and module.
- MUST auto-scroll to bottom unless user has scrolled up.

### §3.4 Main Content Tabs

The main content area uses a tab bar at the top. Tabs are opened from sidebar interactions.

#### §3.4.1 File Viewer Tab

`features/workspace/tabs/FileViewerTab.tsx`

- MUST display file content with syntax highlighting.
- MUST fetch file content from `GET /api/files?path=:path&project=:projectId`.
- MUST use a monospace font.
- MUST show line numbers.
- MUST show git diff markers in the gutter when the file has uncommitted changes.
- SHOULD support basic syntax highlighting (MAY defer to a later phase and show plain text initially).
- The tab title MUST show the filename with file-type icon.
- The tab MUST be closable.
- Read-only initially — MUST show a "Read Only" indicator.

#### §3.4.2 Diff Viewer Tab

`features/workspace/tabs/DiffViewerTab.tsx`

- MUST display file diffs in unified or side-by-side format.
- MUST fetch diff data from `GET /api/diff?path=:path&project=:projectId`.
- MUST show added lines (green), removed lines (red), context lines.
- The tab MUST be closable.
- SHOULD support toggling between unified and side-by-side view.

#### §3.4.3 Issue/PR Detail Tab

`features/workspace/tabs/EntityDetailTab.tsx`

- MUST display full details of an issue or PR/patch.
- MUST show: title, status, author, body (markdown rendered), comments list, labels, linked threads.
- MUST show an "Open Thread" button that switches the right-panel chat to the entity-bound thread.
- The tab MUST be closable.

#### §3.4.4 Planning DAG Tab

`features/workspace/tabs/PlanningTab.tsx`

- MUST display the full planning DAG for the active workspace.
- MUST fetch from `GET /api/orgs/:orgId/planning/graph`.
- MUST render nodes as cards connected by directed edges.
- Critical path MUST be highlighted.
- Blocked nodes MUST show a red/amber indicator. Ready nodes MUST show green.
- Clicking a node MUST open its issue/thread.
- MUST subscribe to `planning` WS channel for live updates.
- SHOULD support pan and zoom.

### §3.5 Right Panel — Chat

The right panel renders the full chat interface for the currently selected thread.

- MUST reuse the existing `ChatView`, `InputArea`, `MessageBubble`, `MarkdownContent`, `WorkSection` components from `features/chat/`.
- MUST subscribe to `chat` WS channel scoped to the active thread key.
- The panel header MUST show the thread label/entity binding and the expand button (§3.2).
- MUST support message forwarding (open `ForwardDialog`).
- Selecting a thread in the Threads sidebar tab (§3.3.3) MUST update the right panel.
- The right panel MUST have a resizable width (drag divider between main content and chat).
- Default width: 360px. Min: 280px. Max: 600px.

---

## §4 Canvas View

`features/canvas/CanvasView.tsx`

The Holonic Canvas — a spatial, zoomable view of all workspaces as interconnected membranes.

### §4.1 Canvas Layout

- The Canvas MUST render as a full-viewport `<canvas>` element (or SVG) with pan and zoom.
- Pan MUST be supported via click-and-drag (desktop) and touch-drag (mobile).
- Zoom MUST be supported via scroll wheel (desktop) and pinch (mobile).
- The canvas MUST have a dark background (`var(--c-bg)`).

### §4.2 Workspace Nodes

- The Canvas MUST fetch all orgs via `GET /api/orgs`.
- Each org MUST be rendered as a bounded membrane (rounded rectangle or organic shape).
- Each membrane MUST show:
  - Org name (centered, `var(--c-text-heading)`).
  - Health indicator: colored border or glow (green = healthy, amber = warnings, red = errors).
  - Activity pulse: subtle animation when events are flowing (CSS `@keyframes` pulse).
  - Badge counts: projects, active agents, unread notifications.
- The `_global` workspace MUST be visually distinct (e.g., larger, centered, or different shape/color).

### §4.3 Event Flow

- The Canvas MUST subscribe to a global event stream via the WS protocol.
- When an event crosses workspace boundaries (e.g., cross-project dependency resolution), an animated line/particle MUST flow between the relevant membranes.
- Events within a single workspace MUST cause that workspace's membrane to briefly pulse or glow.
- The Canvas SHOULD show an event type label on the animated flow (e.g., "issue.synced", "review.merged").

### §4.4 Zoom & Drill-Down

- Clicking a workspace membrane MUST zoom into it, showing internal structure:
  - Projects as sub-nodes within the membrane.
  - Active agent threads as small dots or icons.
  - Active worktrees as branch indicators.
- Double-clicking a project within an expanded membrane MUST switch to the Workspace view with that org + project selected.
- A breadcrumb or "zoom out" button MUST be available to return to the overview.

### §4.5 Event Sidebar

- The Canvas SHOULD show a collapsible sidebar (right edge) with a live event stream.
- Events MUST be filterable by workspace and event type.
- Each event: timestamp, workspace badge, event type icon, summary text.
- Clicking an event SHOULD highlight the relevant workspace membrane.

---

## §5 Global Planning View

`features/planning/GlobalPlanningView.tsx`

Cross-workspace planning — the DAG spans all orgs.

### §5.1 Layout

- The Planning view MUST render a full-viewport planning surface with a toolbar at the top.
- The toolbar MUST contain: view mode selector (DAG/kanban/list/tree), filter controls, search.

### §5.2 Multi-Workspace Graph

- The Planning view MUST fetch planning graphs for all orgs: `GET /api/orgs/:orgId/planning/graph` for each org.
- Nodes MUST be color-coded by workspace (each org gets a distinct hue).
- Edges MUST show dependencies, including cross-workspace edges (visually distinct — dashed or different color).
- The critical path MUST be highlighted (bold edges, brighter nodes).
- Blocked nodes MUST show a red indicator. Ready nodes MUST show green. In-progress MUST show amber.

### §5.3 View Modes

- **DAG** (default): directed graph layout. Nodes positioned by dependency depth. Pan and zoom.
- **Kanban**: columns by status (open, in-progress, review, done). Cards within columns, grouped by workspace.
- **List**: sortable table — columns: title, workspace, project, status, assignee, priority, dependencies. Click column headers to sort.
- **Tree**: hierarchical tree — epics/parent issues at top, sub-issues nested. Expand/collapse.

### §5.4 Actions

- Clicking a node/card/row MUST open the issue/PR detail as a tab in the Workspace view (switches to workspace view, selects the right org).
- The toolbar MUST have an "Assign to Agent" button that opens a dialog: select issue, confirm → creates thread + worktree.
- The toolbar MUST have a "Create Issue" button → dialog with workspace/project selector, title, description, dependencies.
- Drag-to-link between nodes SHOULD create a dependency edge (calls `POST /api/orgs/:orgId/planning/issues` with dependency ref).

### §5.5 Filters

- Filter by: workspace (multi-select), project (multi-select), status, assignee, label, priority.
- Filters MUST be shown as pills/chips that can be removed.
- Filter state MUST persist to `localStorage`.
- A text search MUST filter nodes by title/body content.

---

## §6 System View

`features/system/SystemView.tsx`

Administration and observability, rendered as a tabbed layout.

### §6.1 System Tabs

The System view MUST render a horizontal tab bar at the top with tabs:

| Tab            | Label        | Content                 |
| -------------- | ------------ | ----------------------- |
| `architecture` | Architecture | Module graph            |
| `logs`         | Logs         | Structured log viewer   |
| `health`       | Health       | System health dashboard |
| `config`       | Config       | Live config editor      |
| `devices`      | Devices      | Device management       |
| `jobs`         | Jobs         | Scheduled jobs          |

### §6.2 Architecture Tab

- MUST show a graph of all registered server modules and their event subscriptions.
- Nodes: module name, status badge (healthy/degraded/error).
- Edges: event bus subscriptions (which module listens to which event patterns).
- MUST update live — modules glow or pulse when events pass through them.
- Data source: new server endpoint `GET /api/system/architecture` (see §9.2).

### §6.3 Logs Tab

- MUST show a scrollable, filterable log viewer.
- Data source: `logs` WS channel (new — see §9.3).
- Each entry: timestamp (HH:MM:SS.mmm), level badge (DEBUG grey, INFO blue, WARN amber, ERROR red), module name, message text.
- MUST support filtering by level (checkboxes) and module (dropdown).
- MUST support text search.
- MUST auto-scroll to bottom unless user has scrolled up.
- MUST show a "Clear" button that clears the visible buffer (not server-side).

### §6.4 Health Tab

- MUST show system health metrics in a card grid layout.
- Cards:
  - **Connection**: WS status, agent backend status, uptime.
  - **Resources**: disk usage (data dir), memory usage (if available via API).
  - **Jobs**: active scheduled jobs, last run status, next run time.
  - **Cache**: cache hit rates for issues/reviews if available.
  - **Errors**: error count in last hour, last 5 errors with timestamps.
- Data source: `GET /api/system/health` (see §9.2).

### §6.5 Config Tab

- MUST show the current configuration as an editable form.
- MUST fetch config from `GET /api/config`.
- MUST show config schema (types, descriptions, defaults) from `GET /api/config/schema`.
- MUST support editing values inline with type-appropriate inputs (text, number, boolean toggle, select).
- Saving MUST call `PATCH /api/config` and show success/error feedback.
- MUST show change history (from `GET /api/config/history`) as a collapsible timeline.
- Changes MUST apply immediately (hot-reload — no restart required).

### §6.6 Devices Tab

- MUST show connected devices and pending pairing requests.
- Data source: existing auth device management endpoints.
- Each device: name, ID, status (connected/disconnected), last seen.
- Pending requests: approve/reject buttons.

### §6.7 Jobs Tab

- MUST show all scheduled jobs.
- Data source: existing scheduler endpoints.
- Each job: name, schedule (cron expression or interval), last run time + status, next run time.
- Actions: trigger now, enable/disable, view run history.

---

## §7 Mobile Adaptations

### §7.1 Responsive Breakpoints

- `< 768px`: Mobile layout.
- `≥ 768px`: Desktop layout.
- The client MUST detect width on mount and on resize.

### §7.2 Dashboard (Mobile)

- Cards MUST stack vertically (single column).
- Voice widget MUST be full-width.

### §7.3 Workspace (Mobile) — Swipeable Tab Strip

On mobile, the Workspace view MUST collapse all panels into a single swipeable tab strip:

- The header MUST show the active tab name. Swiping left/right on the header MUST switch between tabs.
- Tapping the header tab name MUST open a dropdown listing all available tabs (Files, File Viewer, Chat, Git, Threads, Planning, Notifications, Terminal, Recordings, Logs).
- Only ONE tab MUST be visible at a time — it fills the full viewport below the header.
- The tab order MUST be: Files → File Viewer → Chat → Git → Threads → Planning → Notifications → Terminal → Recordings → Logs.
- Swipe gestures MUST animate the transition (slide left/right).
- The active tab MUST persist to `localStorage`.
- When a file is tapped in the Files tab, the view MUST auto-switch to the File Viewer tab showing that file.
- When a thread is tapped in the Threads tab, the view MUST auto-switch to the Chat tab showing that thread.

### §7.4 Canvas (Mobile)

- Touch pan and pinch zoom MUST work.
- Tapping a workspace membrane MUST show a bottom sheet with details (no event sidebar).

### §7.5 Planning (Mobile)

- Default to List view (most usable on small screens).
- Kanban MUST scroll horizontally.
- DAG SHOULD be available but MAY be limited in interactivity.

### §7.6 System (Mobile)

- Tabs MUST scroll horizontally if they don't fit.
- Config editor MUST stack fields vertically.

---

## §8 Keyboard Shortcuts

All shortcuts MUST be registered via the existing `shell/commands.ts` command system.

| Shortcut      | Action                   | Context                                  |
| ------------- | ------------------------ | ---------------------------------------- |
| `Cmd+1`       | Switch to Dashboard      | Global                                   |
| `Cmd+2`       | Switch to Workspace      | Global                                   |
| `Cmd+3`       | Switch to Canvas         | Global                                   |
| `Cmd+4`       | Switch to Planning       | Global                                   |
| `Cmd+5`       | Switch to System         | Global                                   |
| `Cmd+Shift+W` | Open workspace picker    | Global                                   |
| `Cmd+P`       | Command palette / search | Workspace                                |
| `Cmd+B`       | Toggle sidebar           | Workspace                                |
| `Cmd+\``      | Toggle bottom panel      | Workspace                                |
| `Cmd+W`       | Close active tab         | Workspace                                |
| `Cmd+Shift+T` | Reopen last closed tab   | Workspace                                |
| `Cmd+1..9`    | Switch to tab N          | Workspace (when focused on main content) |
| `Cmd+N`       | New thread               | Workspace                                |
| `Cmd+Shift+N` | New terminal             | Workspace                                |

---

## §9 Server Additions

### §9.1 Thread Filtering

The existing `GET /api/threads` endpoint MUST support an optional `orgId` query parameter to filter threads by workspace.

- `GET /api/threads` — returns all threads (existing behavior).
- `GET /api/threads?orgId=:orgId` — returns threads whose entities belong to the specified org.
- Global threads (no entity binding) MUST be returned when `orgId=_global` OR when no `orgId` is specified.

### §9.2 System Endpoints

New endpoints for the System view:

- `GET /api/system/architecture` — returns module graph: `{ modules: Array<{ name, status, subscribes: string[], publishes: string[] }> }`.
- `GET /api/system/health` — returns health metrics: `{ uptime, connections: { ws, agentBackend }, jobs: { active, lastErrors }, disk: { dataDir, usedBytes } }`.

The server MUST expose module registration metadata. Each module's `status()` function (already required by convention) provides health data. The architecture endpoint aggregates these.

### §9.3 Logs WS Channel

A new `logs` WS channel MUST be registered.

- The server MUST capture structured log entries (level, module, message, timestamp) and broadcast them to `logs` channel subscribers.
- The server MUST buffer the last 1000 log entries and send them to new subscribers on connect.
- Log entries MUST include: `{ timestamp: number, level: 'debug' | 'info' | 'warn' | 'error', module: string, message: string }`.

### §9.4 Recording Endpoints

New endpoints for workspace-scoped recordings:

- `GET /api/orgs/:orgId/recordings` — list recordings.
- `POST /api/orgs/:orgId/recordings` — upload a new recording (multipart: audio file + metadata).
- `GET /api/orgs/:orgId/recordings/:id` — recording metadata.
- `GET /api/orgs/:orgId/recordings/:id/audio` — download audio file.
- `GET /api/orgs/:orgId/recordings/:id/transcript` — get transcript.
- `DELETE /api/orgs/:orgId/recordings/:id` — delete recording.
- `POST /api/orgs/:orgId/recordings/:id/transcribe` — trigger transcription.

Storage: `{dataDir}/recordings/{orgId}/{id}.webm` (audio) + `{dataDir}/recordings/{orgId}/{id}.json` (metadata + transcript).

### §9.5 Global Workspace Bootstrap

On server startup, the org module MUST check if `_global` exists. If not, create it:

```typescript
const globalOrg = orgs.get('_global')
if (!globalOrg) {
  orgs.create({ id: '_global', name: 'Global', provider: 'radicle' })
}
```

The orgs module MUST reject `update` or `delete` for `id === '_global'` with a 403 status and error message.

---

## §10 Migration from Current Layout

### §10.1 Files to Restructure

| Current | New Location | Change |
| --- | --- | --- |
| `App.tsx` | `App.tsx` | Rewrite: header + view menu dropdown + view Switch |
| `features/nav/Header.tsx` | `features/nav/Header.tsx` | Add view menu dropdown (right side) |
| `features/nav/store.ts` | `features/nav/store.ts` | Replace `viewMode` with `activeView: NavView` |
| `features/nav/SettingsModal.tsx` | `features/system/ConfigTab.tsx` | Move to System view config tab |
| `features/threads/ThreadDrawer.tsx` | `features/workspace/panels/ThreadsPanel.tsx` | Overlay → sidebar panel |
| `features/dashboard/DashboardView.tsx` | `features/dashboard/DashboardView.tsx` | Rewrite with workspace cards |
| `features/voice/VoiceView.tsx` | `features/dashboard/VoiceWidget.tsx` | Extract voice widget for dashboard |
| `features/voice/RecordingView.tsx` | `features/workspace/panels/RecordingsPanel.tsx` | View → sidebar tab panel |
| `shell/Shell.tsx` | `features/workspace/WorkspaceView.tsx` | Rename + integrate workspace context |
| `shell/Header.tsx` | `features/workspace/WorkspaceHeader.tsx` | Extend with breadcrumbs + search |
| `components/file-explorer/*` | `features/workspace/panels/FileExplorerPanel.tsx` | Wrap existing as sidebar tab |
| `components/git-panel/*` | `features/workspace/panels/GitPanel.tsx` | Wrap existing as sidebar tab |
| `components/terminal/*` | `features/workspace/panels/TerminalPanel.tsx` | Wrap existing as sidebar tab |
| `components/status-bar/StatusBar.tsx` | Removed | No status bar in workspace view |

### §10.2 Files to Keep Unchanged

- `features/chat/*` — ChatView, InputArea, MessageBubble, MarkdownContent, WorkSection, store, types (reused in ChatThreadTab)
- `features/connection/*` — ConnectionBadge, store (reused in headers)
- `features/theme/*` — store, themes (global, not view-specific)
- `features/voice/store.ts`, `features/voice/audio.ts` — voice state management (reused by VoiceWidget)
- `shell/shell-store.ts`, `shell/commands.ts`, `shell/panels.ts`, `shell/types.ts` — shell infrastructure
- `shell/TabBar.tsx`, `shell/MainContent.tsx`, `shell/BottomPanel.tsx`, `shell/Sidebar.tsx`, `shell/Divider.tsx`, `shell/CommandPalette.tsx` — shell UI components
- `ui/*` — design system components
- `lib/*` — shared utilities
- `app.css` — theme tokens, animations, scrollbar styles
- `ws/*` — WebSocket store and reconnect logic

### §10.3 New Files

| File                                                   | Purpose                                  |
| ------------------------------------------------------ | ---------------------------------------- |
| `features/nav/ViewMenu.tsx`                            | View menu dropdown component             |
| `features/nav/ViewMenu.test.ts`                        | ViewMenu tests                           |
| `features/workspace/store.ts`                          | Active workspace context                 |
| `features/workspace/store.test.ts`                     | Workspace store tests                    |
| `features/workspace/WorkspaceView.tsx`                 | Shell wrapper with workspace context     |
| `features/workspace/WorkspaceView.test.ts`             | WorkspaceView tests                      |
| `features/workspace/WorkspaceHeader.tsx`               | Breadcrumb + search header               |
| `features/workspace/WorkspaceHeader.test.ts`           | Header tests                             |
| `features/workspace/panels/FileExplorerPanel.tsx`      | File tree sidebar panel                  |
| `features/workspace/panels/FileExplorerPanel.test.ts`  | File explorer tests                      |
| `features/workspace/panels/GitPanel.tsx`               | Git status sidebar panel                 |
| `features/workspace/panels/GitPanel.test.ts`           | Git panel tests                          |
| `features/workspace/panels/ThreadsPanel.tsx`           | Thread list sidebar panel                |
| `features/workspace/panels/ThreadsPanel.test.ts`       | Threads panel tests                      |
| `features/workspace/panels/PlanningPanel.tsx`          | Planning summary sidebar panel           |
| `features/workspace/panels/PlanningPanel.test.ts`      | Planning panel tests                     |
| `features/workspace/panels/NotificationsPanel.tsx`     | Notification list sidebar panel          |
| `features/workspace/panels/NotificationsPanel.test.ts` | Notification panel tests                 |
| `features/workspace/tabs/FileViewerTab.tsx`            | File viewer tab content                  |
| `features/workspace/tabs/FileViewerTab.test.ts`        | File viewer tests                        |
| `features/workspace/tabs/ChatThreadTab.tsx`            | Thread chat tab content                  |
| `features/workspace/tabs/ChatThreadTab.test.ts`        | Chat thread tab tests                    |
| `features/workspace/tabs/DiffViewerTab.tsx`            | Diff viewer tab content                  |
| `features/workspace/tabs/DiffViewerTab.test.ts`        | Diff viewer tests                        |
| `features/workspace/tabs/EntityDetailTab.tsx`          | Issue/PR detail tab content              |
| `features/workspace/tabs/EntityDetailTab.test.ts`      | Entity detail tests                      |
| `features/workspace/tabs/PlanningTab.tsx`              | Full planning DAG tab content            |
| `features/workspace/tabs/PlanningTab.test.ts`          | Planning tab tests                       |
| `features/workspace/panels/TerminalPanel.tsx`          | Terminal sidebar tab                     |
| `features/workspace/panels/TerminalPanel.test.ts`      | Terminal panel tests                     |
| `features/workspace/panels/LogsPanel.tsx`              | Log viewer sidebar tab                   |
| `features/workspace/panels/LogsPanel.test.ts`          | Logs panel tests                         |
| `features/workspace/panels/RecordingsPanel.tsx`        | Recordings sidebar tab                   |
| `features/workspace/panels/RecordingsPanel.test.ts`    | Recordings tests                         |
| `features/canvas/CanvasView.tsx`                       | Holonic canvas view                      |
| `features/canvas/CanvasView.test.ts`                   | Canvas tests                             |
| `features/canvas/store.ts`                             | Canvas state (zoom, pan, selected node)  |
| `features/canvas/store.test.ts`                        | Canvas store tests                       |
| `features/planning/GlobalPlanningView.tsx`             | Cross-workspace planning                 |
| `features/planning/GlobalPlanningView.test.ts`         | Global planning tests                    |
| `features/planning/store.ts`                           | Planning view state (filters, view mode) |
| `features/planning/store.test.ts`                      | Planning store tests                     |
| `features/system/SystemView.tsx`                       | System admin view                        |
| `features/system/SystemView.test.ts`                   | System view tests                        |
| `features/system/ArchitectureTab.tsx`                  | Module graph tab                         |
| `features/system/ArchitectureTab.test.ts`              | Architecture tests                       |
| `features/system/LogsTab.tsx`                          | Log viewer tab                           |
| `features/system/LogsTab.test.ts`                      | Logs tests                               |
| `features/system/HealthTab.tsx`                        | Health dashboard tab                     |
| `features/system/HealthTab.test.ts`                    | Health tests                             |
| `features/system/ConfigTab.tsx`                        | Config editor tab                        |
| `features/system/ConfigTab.test.ts`                    | Config tests                             |
| `features/system/DevicesTab.tsx`                       | Device management tab                    |
| `features/system/DevicesTab.test.ts`                   | Devices tests                            |
| `features/system/JobsTab.tsx`                          | Scheduled jobs tab                       |
| `features/system/JobsTab.test.ts`                      | Jobs tests                               |
| `features/dashboard/VoiceWidget.tsx`                   | Voice interaction widget                 |
| `features/dashboard/VoiceWidget.test.ts`               | Voice widget tests                       |
| `features/dashboard/WorkspaceCard.tsx`                 | Workspace summary card                   |
| `features/dashboard/WorkspaceCard.test.ts`             | Workspace card tests                     |
| `features/dashboard/NotificationFeed.tsx`              | Notification feed panel                  |
| `features/dashboard/NotificationFeed.test.ts`          | Notification feed tests                  |
| `features/dashboard/GlobalChat.tsx`                    | Compact global chat panel                |
| `features/dashboard/GlobalChat.test.ts`                | Global chat tests                        |

Server additions: | File | Purpose | |------|---------| | `packages/server/src/system/system.ts` | System module (architecture, health) | | `packages/server/src/system/system.test.ts` | System module tests | | `packages/server/src/system/routes.ts` | System REST endpoints | | `packages/server/src/system/ws.ts` | Logs WS channel | | `packages/server/src/system/ws.test.ts` | Logs WS tests | | `packages/server/src/recordings/recordings.ts` | Recording storage service | | `packages/server/src/recordings/recordings.test.ts` | Recording service tests | | `packages/server/src/recordings/routes.ts` | Recording REST endpoints |

---

## Wave Strategy

### Wave 1: Infrastructure (parallel)

- §0.1 Global Workspace bootstrap (server)
- §0.2 Active Workspace store (client)
- §1.1–1.3 View menu + navigation store + App.tsx restructure
- §9.1 Thread filtering by orgId
- §9.2 System endpoints
- §9.5 Global workspace server guard

### Wave 2: Workspace View — Sidebar + Chat (parallel, after Wave 1)

- §3.1 Three-column layout
- §3.2 Expand chat mode
- §3.3.1 Files tab (file explorer)
- §3.3.2 Git tab
- §3.3.3 Threads tab
- §3.3.4 Planning tab
- §3.3.5 Notifications tab
- §3.3.6 Terminal tab
- §3.3.7 Recordings tab
- §3.3.8 Logs tab
- §3.5 Right panel chat

### Wave 3: Workspace View — Main Content Tabs (parallel, after Wave 2)

- §3.4.1 File Viewer Tab
- §3.4.2 Diff Viewer Tab
- §3.4.3 Issue/PR Detail Tab
- §3.4.4 Planning DAG Tab
- §9.3 Logs WS channel
- §9.4 Recording endpoints

### Wave 4: Dashboard (after Wave 1)

- §2.1 Dashboard layout
- §2.2 Workspace cards
- §2.3 Global chat
- §2.4 Voice widget
- §2.5 Notification feed
- §2.6 System status strip

### Wave 5: Canvas & Planning (after Wave 2)

- §4.1–4.5 Canvas view
- §5.1–5.5 Global Planning view

### Wave 6: System (after Wave 3 for logs)

- §6.1–6.7 System view tabs

### Wave 7: Mobile & Polish (after all above)

- §7.1–7.6 Mobile adaptations
- §8 Keyboard shortcuts registration

### Wave 8: Integration Tests

- End-to-end: navigate views, open workspace, open file, switch thread, check terminal
- Cross-view: click notification in dashboard → lands in workspace with right tab
- Workspace switching: tabs clear appropriately, stores update, WS subscriptions change
- Global workspace: verify Radicle-only constraint, verify bootstrap
