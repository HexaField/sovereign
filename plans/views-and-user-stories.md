# Sovereign — Views & User Stories

> Date: 2026-03-13  
> Status: Draft

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

**Layout:** Classic IDE — sidebar (left), main content (center, tabbed), bottom panel (terminal/logs), header with breadcrumbs and workspace selector.

**Sidebar Sections** (collapsible, reorderable):

- **File Explorer** — tree view of the active project's filesystem. Click to open file in a tab. Shows git status indicators (modified, added, deleted, untracked) per file. Multi-project: tabs or dropdown to switch between projects within the org.
- **Git** — branch list, status summary, staging area, commit history. Multi-project: grouped by project. Shows worktree status (which agent is working where). Quick actions: create branch, switch branch, stage, commit.
- **Threads** — all threads for this workspace. Categorised: entity-bound (branch/issue/PR threads), user-created, agent-spawned. Shows status indicators (busy, unread, stuck, error). Click to open thread in main content.
- **Planning** — mini planning view for this workspace. Shows ready/blocked/in-progress counts. Expand for DAG overview. Click item to jump to its thread or issue.
- **Notifications** — workspace-scoped notifications. Review requests, CI results, mentions, agent completions.

**Main Content** (tabbed):

- **File Viewer/Editor** — syntax-highlighted file view. Read-only initially (agent does the editing). Later: editing with conflict resolution when agent is also modifying.
- **Chat Thread** — a thread tab. Shows messages, streaming agent response, work items, thinking blocks. Input area at bottom. Thread is bound to its entity — events route in automatically.
- **Diff View** — side-by-side or unified diff for files, PRs, worktree changes.
- **Issue/PR Detail** — full view of an issue or PR with comments, status, linked threads.
- **Planning DAG** — interactive dependency graph for this workspace.

**Bottom Panel** (toggle with Cmd+\`):

- **Terminal** — embedded PTY terminals. Multiple instances, split panes. Scoped to workspace/project/worktree.
- **Logs** — agent logs, build output, event stream for this workspace.
- **Problems** — lint errors, type errors, test failures from CI.
- **Recordings** — workspace-scoped recording & transcription tool. Record audio, auto-transcribe, searchable transcript archive. Recordings bound to workspace context (optionally to a specific thread/entity). Export as audio or text.

**Header:**

- Workspace breadcrumb: Org > Project (clickable to switch)
- Workspace selector dropdown (switch orgs)
- Search (files, issues, threads — scoped to workspace)
- Command palette (Cmd+P)

**User Stories:**

- US-W1: As a user, I select a workspace and see my projects listed in the sidebar with git status at a glance.
- US-W2: As a user, I open a file from the explorer and view it in a tab with syntax highlighting and git diff markers.
- US-W3: As a user, I open a terminal scoped to a project's worktree and run commands.
- US-W4: As a user, I see all active threads for this workspace — I can tell which ones have agents working, which have unread messages, which are stuck.
- US-W5: As a user, I open an entity-bound thread (e.g., for issue #42) and see both the chat history and the live events (CI results, review comments) flowing in.
- US-W6: As a user, I see the planning overview in the sidebar showing ready/blocked items, and can expand to see the full DAG.
- US-W7: As a user, I can view diffs for any file, PR, or worktree in a tab.
- US-W8: As a user, I can have multiple tabs open: a file, a thread, a diff, and a planning view — all within the same workspace.
- US-W9: As a user, I assign work to an agent from a thread ("fix issue #42") and see it create a worktree, make changes, and push — all visible in the workspace's git panel and thread.
- US-W10: As a user, I can switch between projects within the same workspace without losing my tab state.
- US-W11: As a user, I can record audio within a workspace, have it auto-transcribed, and search/export the transcripts later. Recordings are associated with the workspace and optionally with a specific thread.

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

**Layout:** Tabbed view — Architecture, Logs, Health, Config.

**Content:**

- **Architecture** — module dependency graph. Shows all registered modules, their status (healthy/degraded/error), event subscriptions, and connection topology. Live — modules lighting up as events flow through them.
- **Logs** — structured log viewer. Filterable by module, level, time range. Searchable. Shows bus events alongside application logs.
- **Health** — system health dashboard. Connection status (WS, agent backend, Radicle peers), resource usage (disk, memory), job queue depth, cache hit rates, error rates.
- **Config** — live config editor. Shows current config values, edit with validation, see change history. Hot-reload — changes apply immediately.
- **Devices** — connected devices, pending pairing requests, device identity management.
- **Jobs** — scheduled job list, run history, next run times. Manual trigger, enable/disable.

**User Stories:**

- US-S1: As a user, I see the system's module architecture with live health indicators.
- US-S2: As a user, I search and filter logs across all modules.
- US-S3: As a user, I edit configuration and see it applied immediately without restart.
- US-S4: As a user, I see all scheduled jobs and their recent run history.
- US-S5: As a user, I manage device pairing and see connected devices.
- US-S6: As a user, I see overall system health — connections, resources, error rates.

---

## The Global Workspace

The "Global" context is a first-class workspace with a reserved org ID (e.g., `_global`). It has all the same capabilities as any other workspace:

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

Top-level navigation between the 5 views:

1. **Dashboard** — home icon / `D`
2. **Workspace** — folder icon / `W` (opens last-used workspace, or workspace picker)
3. **Canvas** — hexagon icon / `C`
4. **Planning** — graph icon / `P`
5. **System** — gear icon / `S`

Navigation bar: left side on desktop (vertical icon rail), bottom on mobile (horizontal tab bar). Always visible, minimal — just icons with labels on hover.

Keyboard: `Cmd+1` through `Cmd+5` to switch views. `Cmd+Shift+W` for workspace picker.

---

## Relationship to Existing Code

### Keep (integrate into Shell)

- `shell/` — Shell.tsx, shell-store, panels, commands, tabs, sidebar, dividers, status bar
- All Phase 1–5 server modules (event bus, scheduler, auth, notifications, orgs, files, git, terminal, worktrees, config, WS protocol, diff, issues, review, radicle, planning)
- Phase 6 server modules (agent-backend, threads, chat, voice)
- Phase 6 client stores (chat, threads, voice, connection, theme, nav)
- StatusBar component

### Restructure (adapt to Shell panels/tabs)

- `features/chat/` — ChatView, InputArea, MessageBubble, etc. become tab content, not standalone views
- `features/threads/` — ThreadDrawer becomes a sidebar panel, not an overlay
- `features/voice/` — VoiceView becomes a dashboard widget + command palette action
- `features/dashboard/` — DashboardView becomes the Dashboard top-level view
- `features/nav/` — Header replaced by Shell header; SettingsModal moves to System view or command palette

### Build New

- **Navigation rail** — top-level view switcher
- **Workspace selector** — org picker in header
- **File explorer panel** — sidebar panel using Phase 2 files module
- **Git panel** — sidebar panel using Phase 2 git module
- **Planning panel** — sidebar panel using Phase 5 planning module
- **Terminal tab** — tab content using Phase 2 terminal module
- **File viewer tab** — tab content with syntax highlighting
- **Diff viewer tab** — tab content using Phase 4 diff module
- **Holonic canvas** — new view (Phase 7)
- **Global planning view** — new view extending Phase 5
- **System view** — new view (Phase 7)
