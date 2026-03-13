# Sovereign — Views & User Stories

> Date: 2026-03-13 Revision: 2 Status: Draft

## Core Concept: Everything is a Workspace

Sovereign is a **multi-workspace IDE for agent orchestration, planning, and code**. Every view operates within the context of a workspace (org). There is always a special **Global** workspace — a private Radicle-backed workspace that is never connected to GitHub. It holds personal notes, cross-workspace planning, and private threads.

Each workspace (org) contains projects (git repos), and each project has branches, worktrees, issues, PRs, and planning items. The workspace is the membrane — it defines the boundary of shared context, shared planning, and shared agent orchestration.

---

## Views

### 1. Dashboard

The home screen. Shows a condensed overview of everything that matters right now.

**Layout:** Grid/card layout, responsive. No sidebar — full-width content.

**Content:**

- **Active Workspaces** — one card per org with active work. Each card shows:
  - Git status summary across all projects (uncommitted changes, ahead/behind, active branches)
  - Active agent threads (count, latest activity, any stuck/error)
  - Unread notifications (grouped: review requests, CI failures, mentions)
  - Quick-switch to workspace view
- **Global Threads** — the main chat thread and any user-created global threads. Shows recent messages, agent status (idle/working/error). Click to open in-place.
- **Notifications** — unified feed across all workspaces. Entity-scoped: click a notification to jump to the thread/workspace/entity.
- **Quick Actions** — create workspace, start voice chat, open planning view
- **Voice Chat** — dedicated voice-only interaction area. Always available from dashboard. Tap to speak, transcription shown inline, agent responds with TTS. No text input area — pure voice.
- **System Status** — connection health, agent status, disk usage, active jobs

**User Stories:**

- US-D1: As a user, I open Sovereign and immediately see which workspaces have activity (uncommitted changes, running agents, notifications).
- US-D2: As a user, I can chat with my agent from the dashboard without entering a workspace context.
- US-D3: As a user, I can use voice-only mode from the dashboard — tap to speak, hear the response, no keyboard needed.
- US-D4: As a user, I see all notifications across all workspaces in one feed, and clicking one takes me to the right context.
- US-D5: As a user, I can quickly switch into any workspace from its dashboard card.

---

### 2. Workspace

The IDE view. Full development environment scoped to a single org.

**Desktop Layout:** Three columns — sidebar (left, 260px), main content (center, tabbed), chat panel (right, 360px resizable). Header with workspace breadcrumb and selector. No status bar. No bottom panel — terminal, logs, and recordings are sidebar tabs.

**Sidebar Tabs** (icon + label, one visible at a time):

- **Files** — tree view of the active project's filesystem. Click to open file in a main content tab. Shows git status indicators (modified, added, deleted, untracked) per file. Project selector dropdown in tab header.
- **Git** — branch list, status summary, staging area, commit history. Multi-project: grouped by project. Shows worktree status (which agent is working where). Quick actions: create branch, switch branch, stage, commit.
- **Threads** — all threads for this workspace. Categorised: entity-bound (branch/issue/PR threads), user-created, agent-spawned. Shows status indicators (busy, unread, stuck, error). Click to switch the right-panel chat to that thread.
- **Planning** — mini planning view for this workspace. Shows ready/blocked/in-progress counts. Click item to jump to its issue or open "View Full DAG" in main content.
- **Notifications** — workspace-scoped notifications. Review requests, CI results, mentions, agent completions.
- **Terminal** — embedded PTY terminals. Multiple instances as sub-tabs. Scoped to workspace/project/worktree.
- **Recordings** — workspace-scoped recording & transcription tool. Record audio, auto-transcribe, searchable transcript archive. Recordings bound to workspace context (optionally to a specific thread/entity). Export as audio or text.
- **Logs** — agent logs, build output, event stream for this workspace. Filterable by level and module.

**Main Content** (tabbed):

- **File Viewer** — syntax-highlighted file view. Read-only initially (agent does the editing). Git diff markers in gutter for uncommitted changes.
- **Diff View** — side-by-side or unified diff for files, PRs, worktree changes.
- **Issue/PR Detail** — full view of an issue or PR with comments, status, linked threads. "Open Thread" button switches right-panel chat.
- **Planning DAG** — interactive dependency graph for this workspace.

**Right Panel — Chat:**

- Always-visible chat interface for the active thread (selected via Threads sidebar tab).
- Full chat: messages, streaming agent response, work items, thinking blocks, input area, forwarding.
- Resizable width (drag divider). Default 360px, min 280px, max 600px.
- **Expand button** — expands chat to fill the entire workspace view area, looking identical to the current voice-ui chat interface (same layout, components, styling). A back button returns to multi-panel workspace view. Toggle with `Cmd+Shift+E`.

**Header:**

- Workspace breadcrumb: Org > Project (clickable to switch)
- Workspace selector dropdown (switch orgs)
- Search (files, issues, threads — scoped to workspace)
- Connection badge

**Mobile Layout:**

- All panels (Files, File Viewer, Chat, Git, Threads, Planning, Notifications, Terminal, Recordings, Logs) collapse into a swipeable tab strip.
- Header shows active tab name. Swipe left/right to switch tabs. Tap header for dropdown of all tabs.
- Only one tab visible at a time, filling the viewport below the header.
- Tapping a file in Files auto-switches to File Viewer. Tapping a thread auto-switches to Chat.

**User Stories:**

- US-W1: As a user, I select a workspace and see my projects listed in the sidebar with git status at a glance.
- US-W2: As a user, I open a file from the explorer and view it in a tab with syntax highlighting and git diff markers.
- US-W3: As a user, I open a terminal in the sidebar scoped to a project's worktree and run commands.
- US-W4: As a user, I see all active threads for this workspace — I can tell which ones have agents working, which have unread messages, which are stuck.
- US-W5: As a user, I open an entity-bound thread in the right panel and see both the chat history and the live events flowing in.
- US-W6: As a user, I see the planning overview in the sidebar showing ready/blocked items, and can expand to see the full DAG in main content.
- US-W7: As a user, I can view diffs for any file, PR, or worktree in a main content tab.
- US-W8: As a user, I can have multiple tabs open in main content (a file, a diff, a planning view) while chatting in the right panel.
- US-W9: As a user, I assign work to an agent from a thread ("fix issue #42") and see it create a worktree, make changes, and push — all visible in the sidebar git panel and chat.
- US-W10: As a user, I can switch between projects within the same workspace without losing my tab state.
- US-W11: As a user, I can record audio within a workspace, have it auto-transcribed, and search/export the transcripts later.
- US-W12: As a user, I can expand the chat to full-screen for a focused conversation, then collapse back to the multi-panel IDE when I need to see files/git/planning alongside.
- US-W13: On mobile, I swipe between Files, Chat, Terminal and other panels — one at a time, full screen.

---

### 3. Holonic Canvas

A zoomed-out, spatial view of all workspaces as interconnected organisms.

**Layout:** Full-screen canvas (pan/zoom). Each workspace is a node (membrane). Events flow between them visually.

**Content:**

- **Workspace Nodes** — each org rendered as a bounded region (membrane) on the canvas. Shows:
  - Health indicators (green/yellow/red)
  - Activity level (pulse/glow for active work)
  - Project count, active agent count
  - Latest event summary
- **Event Flow** — real-time animated connections between workspaces when events cross boundaries (e.g., cross-project dependency resolution, shared agent context).
- **Expand** — click a workspace membrane to zoom in and see its internal structure: projects as sub-nodes, agents as moving dots, event streams as flowing lines.
- **Global Context** — the Global workspace is always visible, shown as the background or a distinct central node.
- **Event Stream** — a live sidebar or overlay showing the event bus in real time, filterable by workspace/type.

**Mobile:** Touch pan and pinch zoom. Tap a workspace membrane for a bottom sheet with details (no sidebar).

**User Stories:**

- US-H1: As a user, I see all my workspaces at a glance with visual health/activity indicators.
- US-H2: As a user, I see events flowing between workspaces in real time (cross-project dependencies resolving, agents completing work that unblocks another workspace).
- US-H3: As a user, I click a workspace to zoom in and see its internal structure — projects, agents, active threads.
- US-H4: As a user, I can observe the full event stream across all workspaces, filtered by type or workspace.
- US-H5: As a user, I use this view to understand the health and relationships between my workspaces at a systems level.

---

### 4. Global Planning

Cross-workspace planning view. The DAG spans all orgs.

**Layout:** Full-screen DAG/kanban/list with workspace/project grouping.

**Content:**

- **Multi-Workspace DAG** — dependency graph that spans all orgs. Nodes are issues/tasks colored by workspace. Edges show dependencies, including cross-workspace ones.
- **Filters** — by workspace, project, status, assignee (agent or human), priority, label.
- **Views** — DAG (graph), kanban (columns by status), list (sortable table), tree (hierarchical).
- **Critical Path** — highlighted path across all workspaces showing the longest dependency chain.
- **Blocked Items** — prominent display of items blocked on cross-workspace dependencies.
- **Actions** — create issue, decompose task, assign to agent, link dependencies — all cross-workspace.

**Mobile:** Default to List view. Kanban scrolls horizontally. DAG available but limited interactivity.

**User Stories:**

- US-P1: As a user, I see all planned work across all workspaces in a unified view.
- US-P2: As a user, I identify the critical path across my entire portfolio of work.
- US-P3: As a user, I see which items are blocked and what's blocking them, even across workspaces.
- US-P4: As a user, I create a new issue in any workspace from the planning view and link it as a dependency.
- US-P5: As a user, I switch between DAG, kanban, list, and tree views depending on what I need.
- US-P6: As a user, I assign work to an agent directly from the planning view, which creates the thread and worktree automatically.

---

### 5. System

Administration and observability.

**Layout:** Tabbed view — Architecture, Logs, Health, Config, Devices, Jobs.

**Content:**

- **Architecture** — module dependency graph. Shows all registered modules, their status (healthy/degraded/error), event subscriptions, and connection topology. Live — modules lighting up as events flow through them.
- **Logs** — structured log viewer. Filterable by module, level, time range. Searchable. Shows bus events alongside application logs.
- **Health** — system health dashboard. Connection status (WS, agent backend, Radicle peers), resource usage (disk, memory), job queue depth, cache hit rates, error rates.
- **Config** — live config editor. Shows current config values, edit with validation, see change history. Hot-reload — changes apply immediately.
- **Devices** — connected devices, pending pairing requests, device identity management.
- **Jobs** — scheduled job list, run history, next run times. Manual trigger, enable/disable.

**Mobile:** Tabs scroll horizontally. Config editor stacks fields vertically.

**User Stories:**

- US-S1: As a user, I see the system's module architecture with live health indicators.
- US-S2: As a user, I search and filter logs across all modules.
- US-S3: As a user, I edit configuration and see it applied immediately without restart.
- US-S4: As a user, I see all scheduled jobs and their recent run history.
- US-S5: As a user, I manage device pairing and see connected devices.
- US-S6: As a user, I see overall system health — connections, resources, error rates.

---

## The Global Workspace

The "Global" context is a first-class workspace with a reserved org ID (`_global`). It has all the same capabilities as any other workspace:

- Its own projects (Radicle repos only — **never GitHub**)
- Its own planning items
- Its own threads (including the "main" thread)
- Its own file storage, notes, memory
- Its own terminal sessions

The Global workspace is where:

- Cross-workspace coordination happens
- Personal notes and memory live
- The main agent thread lives
- Voice chat defaults to
- Dashboard global threads are bound to

**Constraint:** Global workspace projects MUST use Radicle as their provider. GitHub provider MUST NOT be configurable for the Global workspace. This ensures personal/private data never touches centralised infrastructure.

---

## Navigation

Top-level navigation between the 5 views via a **dropdown menu in the top-right area of the header** (consistent with the voice-ui header dropdown pattern):

1. **Dashboard** — 🏠 / `Cmd+1`
2. **Workspace** — 📁 / `Cmd+2`
3. **Canvas** — ⬡ / `Cmd+3`
4. **Planning** — 📊 / `Cmd+4`
5. **System** — ⚙️ / `Cmd+5`

The header is shared across all views. It contains: workspace selector (left), connection badge, view menu dropdown (right). The dropdown shows icon, label, and keyboard shortcut for each view with the active view highlighted.

---

## Relationship to Existing Code

### Keep (integrate into views)

- `shell/` — Shell.tsx, shell-store, panels, commands, tabs, sidebar, dividers (status bar removed)
- All Phase 1–5 server modules (event bus, scheduler, auth, notifications, orgs, files, git, terminal, worktrees, config, WS protocol, diff, issues, review, radicle, planning)
- Phase 6 server modules (agent-backend, threads, chat, voice)
- Phase 6 client stores (chat, threads, voice, connection, theme, nav)

### Restructure (adapt to new layout)

- `features/chat/` — ChatView, InputArea, MessageBubble, etc. become the right-panel chat in workspace view (and expand to full-screen mode matching current voice-ui)
- `features/threads/` — ThreadDrawer becomes a sidebar tab panel, not an overlay
- `features/voice/` — VoiceView becomes a dashboard widget + voice controls in expanded chat
- `features/dashboard/` — DashboardView rewritten with workspace cards, voice widget, notification feed
- `features/nav/` — Header updated with view menu dropdown; SettingsModal moves to System view config tab
- `components/file-explorer/` — wrapped as sidebar Files tab
- `components/git-panel/` — wrapped as sidebar Git tab
- `components/terminal/` — wrapped as sidebar Terminal tab
- `components/status-bar/` — removed (no status bar)

### Build New

- **View menu dropdown** — top-level view switcher in header
- **Workspace selector** — org picker in header
- **Sidebar tab bar** — tab strip for switching sidebar panels
- **Chat right panel** — always-visible chat with expand/collapse to full-screen
- **File viewer tab** — main content tab with syntax highlighting
- **Diff viewer tab** — main content tab using Phase 4 diff module
- **Recordings panel** — sidebar tab for workspace-scoped audio recording/transcription
- **Logs panel** — sidebar tab for live event/log stream
- **Holonic canvas** — new view
- **Global planning view** — new view extending Phase 5
- **System view** — new view with architecture, logs, health, config, devices, jobs tabs
