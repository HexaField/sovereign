# Phase 2: Orgs, Projects & Code — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-12

This document specifies the six modules of Phase 2. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 2 depends on Phase 1 (event bus, auth, notifications, scheduler, status). All new modules communicate via the event bus and are protected by the auth layer.

---

## 1. Org & Project Manager

Orgs are the top-level organising unit. Each org manages multiple projects (git repositories) with shared context and configuration.

### Requirements

- An **org** MUST have: `id`, `name`, `path` (root directory on disk), `config`, `createdAt`, `updatedAt`.
- A **project** MUST have: `id`, `orgId`, `name`, `repoPath` (absolute path to git repo on disk), `remote` (origin URL), `defaultBranch`, `createdAt`, `updatedAt`.
- A project MUST reference exactly one git repository. A git repository MUST NOT belong to multiple orgs.
- The org manager MUST persist org and project definitions to `{dataDir}/orgs/orgs.json` as the single source of truth.
- The org manager MUST support CRUD for orgs and projects at runtime without restart.
- Adding a project MUST validate that `repoPath` exists and is a git repository (contains `.git`).
- The org manager MUST emit `org.created`, `org.updated`, `org.deleted`, `project.created`, `project.updated`, `project.deleted` events on the bus.
- The org manager MUST detect monorepo structures within a project (pnpm workspace, npm workspaces, nx, turborepo) and expose the workspace package list.
- Per-org configuration MUST be stored at `{dataDir}/orgs/{orgId}/config.json` and MUST be hot-reloadable (Principle 4).
- The org manager MUST expose a REST API: `GET/POST /api/orgs`, `GET/PUT/DELETE /api/orgs/:orgId`, `GET/POST /api/orgs/:orgId/projects`, `GET/PUT/DELETE /api/orgs/:orgId/projects/:projectId`.
- The org manager MUST NOT create or modify files inside the user's git repositories — it only reads from them.
- The org manager SHOULD support an `active` org/project concept — the currently focused context — emitting `org.active.changed` and `project.active.changed` events.
- The org manager MAY support project-level config overrides stored at `{dataDir}/orgs/{orgId}/projects/{projectId}/config.json`.

### Interface

```typescript
interface Org {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

interface Project {
  id: string
  orgId: string
  name: string
  repoPath: string
  remote?: string
  defaultBranch: string
  monorepo?: {
    tool: 'pnpm' | 'npm' | 'nx' | 'turborepo'
    packages: string[]
  }
  createdAt: string
  updatedAt: string
}

interface OrgManager {
  // Orgs
  createOrg(data: { name: string; path: string }): Org
  updateOrg(orgId: string, patch: Partial<Org>): Org
  deleteOrg(orgId: string): void
  getOrg(orgId: string): Org | undefined
  listOrgs(): Org[]

  // Projects
  addProject(orgId: string, data: { name: string; repoPath: string }): Project
  updateProject(orgId: string, projectId: string, patch: Partial<Project>): Project
  removeProject(orgId: string, projectId: string): void
  getProject(orgId: string, projectId: string): Project | undefined
  listProjects(orgId: string): Project[]

  // Active context
  setActiveOrg(orgId: string): void
  setActiveProject(orgId: string, projectId: string): void
  getActiveOrg(): Org | undefined
  getActiveProject(): Project | undefined

  // Config
  getOrgConfig(orgId: string): Record<string, unknown>
  updateOrgConfig(orgId: string, patch: Record<string, unknown>): void
}
```

### Files

```
packages/server/src/orgs/
├── orgs.ts              # Core org & project management
├── orgs.test.ts         # Unit tests
├── types.ts             # Org, Project types
├── store.ts             # File-backed persistence
├── monorepo.ts          # Monorepo detection (pnpm, npm, nx, turbo)
├── monorepo.test.ts     # Monorepo detection tests
└── routes.ts            # Express REST API router

{dataDir}/orgs/
├── orgs.json            # Org & project registry
└── {orgId}/
    ├── config.json      # Per-org config
    └── projects/
        └── {projectId}/
            └── config.json  # Per-project config overrides
```

---

## 2. Worktree Manager

Git worktrees are the unit of parallel work. Every task that touches code gets its own worktree, isolated from other work.

### Requirements

- The worktree manager MUST create worktrees via `git worktree add` within a project's repository.
- The worktree manager MUST list all worktrees for a project, including: branch name, path, creation time, assigned agent (if any), and status (active/merged/stale).
- The worktree manager MUST remove worktrees via `git worktree remove` and prune the branch if merged.
- Worktrees MUST be created in a configurable location, defaulting to `{repoPath}/.worktrees/{name}`.
- The worktree manager MUST run `pnpm install --frozen-lockfile` (or the appropriate package manager install command) after creating a worktree, using the shared pnpm store.
- The worktree manager MUST persist worktree metadata (assignments, status) to `{dataDir}/orgs/{orgId}/projects/{projectId}/worktrees.json`.
- The worktree manager MUST emit `worktree.created`, `worktree.removed`, `worktree.assigned`, `worktree.merged` events on the bus.
- The worktree manager MUST support cross-project worktree synchronisation within an org — creating a "linked set" of worktrees across multiple projects that share a work stream (e.g. a feature spanning two repos).
- A linked worktree set MUST have a shared `linkId` and MUST be tracked in `{dataDir}/orgs/{orgId}/worktree-links.json`.
- The worktree manager MUST NOT modify the main/default branch's working tree — worktrees are always on feature branches.
- The worktree manager MUST detect stale worktrees (no commits for a configurable period) and emit `worktree.stale` events.
- The worktree manager MUST expose a REST API: `GET/POST /api/orgs/:orgId/projects/:projectId/worktrees`, `DELETE /api/orgs/:orgId/projects/:projectId/worktrees/:worktreeId`, `POST /api/orgs/:orgId/worktree-links`.
- The worktree manager SHOULD support automatic cleanup of merged worktree branches on a schedule.
- The worktree manager MUST NOT allow creation of worktrees on the default branch.
- The worktree manager MAY support worktree templates (pre-configured .env files, build scripts).

### Interface

```typescript
interface Worktree {
  id: string
  projectId: string
  orgId: string
  branch: string
  path: string
  baseBranch: string
  assignedAgent?: string
  linkId?: string
  status: 'active' | 'merged' | 'stale'
  createdAt: string
  lastCommitAt?: string
}

interface WorktreeLink {
  id: string
  orgId: string
  name: string
  description?: string
  worktreeIds: string[]
  createdAt: string
}

interface WorktreeManager {
  create(orgId: string, projectId: string, data: { branch: string; baseBranch?: string }): Promise<Worktree>
  remove(orgId: string, projectId: string, worktreeId: string, opts?: { pruneBranch?: boolean }): Promise<void>
  list(orgId: string, projectId: string): Worktree[]
  get(orgId: string, projectId: string, worktreeId: string): Worktree | undefined
  assign(orgId: string, projectId: string, worktreeId: string, agentId: string): Worktree
  unassign(orgId: string, projectId: string, worktreeId: string): Worktree

  // Cross-project linking
  createLink(orgId: string, data: { name: string; worktreeIds: string[] }): WorktreeLink
  getLink(orgId: string, linkId: string): WorktreeLink | undefined
  listLinks(orgId: string): WorktreeLink[]
  removeLink(orgId: string, linkId: string): void

  // Maintenance
  detectStale(orgId: string, projectId: string, maxAgeDays?: number): Worktree[]
  cleanupMerged(orgId: string, projectId: string): Promise<string[]>
}
```

### Files

```
packages/server/src/worktrees/
├── worktrees.ts         # Core worktree management
├── worktrees.test.ts    # Unit tests
├── types.ts             # Worktree, WorktreeLink types
├── store.ts             # File-backed persistence
├── git.ts               # Git worktree CLI wrapper (git worktree add/remove/list)
├── git.test.ts          # Git wrapper tests
├── links.ts             # Cross-project worktree linking
├── links.test.ts        # Link tests
└── routes.ts            # Express REST API router
```

---

## 3. IDE Shell

The application shell providing the layout structure for all UI panels. Mobile-first with progressive disclosure.

### Requirements

- The IDE shell MUST provide a resizable multi-panel layout: sidebar (left), main content (center), and bottom panel.
- On mobile (viewport < 768px), the shell MUST render a single panel at a time with navigation to switch between panels.
- On tablet/desktop, the shell MUST render multiple panels simultaneously with draggable dividers for resizing.
- The shell MUST support a tab system in the main content area — each tab can be a file, diff, terminal, or any panel component.
- Tabs MUST support: open, close, reorder (drag), pin, and split (open in side-by-side within main).
- The shell MUST persist layout state (panel sizes, open tabs, active tab) to `localStorage` and restore on reload.
- The shell MUST support keyboard shortcuts: `Cmd+P` (command palette / file search), `Cmd+Shift+F` (org-wide search), `` Cmd+` `` (toggle bottom panel/terminal), `Cmd+W` (close tab), `Cmd+1-9` (switch to tab N).
- The shell MUST expose a command palette (triggered by `Cmd+P`) that lists available actions and supports fuzzy search.
- The shell MUST NOT depend on any server-side state for layout — layout is purely client-side.
- The shell MUST integrate the StatusBar from Phase 1 at the fixed bottom position.
- The shell MUST provide a header bar with: org switcher, project selector, and notification bell (wired to Phase 1 notifications).
- The shell SHOULD support theming (dark/light) stored in `localStorage`.
- The shell MUST accommodate future extension — new panel types MUST be registrable without modifying the shell itself (plugin-friendly).
- The sidebar MUST be collapsible with a toggle button, and MUST remember collapsed state.

### Interface

```typescript
// Panel registration system
interface PanelDefinition {
  id: string
  title: string
  icon: string
  component: Component
  position: 'sidebar' | 'main' | 'bottom'
  defaultVisible?: boolean
}

interface TabData {
  id: string
  title: string
  icon?: string
  component: Component
  closable: boolean
  pinned: boolean
  data?: Record<string, unknown>
}

interface ShellState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  bottomHeight: number
  bottomVisible: boolean
  tabs: TabData[]
  activeTabId: string | null
  theme: 'dark' | 'light'
}

// Command palette
interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
  category?: string
}
```

### Files

```
packages/client/src/shell/
├── Shell.tsx             # Root layout component
├── Shell.test.tsx        # Component tests
├── Sidebar.tsx           # Collapsible sidebar
├── MainContent.tsx       # Tabbed main area
├── BottomPanel.tsx       # Resizable bottom panel
├── TabBar.tsx            # Tab management
├── CommandPalette.tsx    # Fuzzy-search command palette
├── Header.tsx            # Org switcher, project selector, notifications
├── Divider.tsx           # Draggable resize divider
├── shell-store.ts        # Reactive state (SolidJS store)
├── panels.ts             # Panel registration
├── commands.ts           # Command registry
└── types.ts              # Shell types
```

---

## 4. File Explorer

Multi-root file browser with tree navigation, file viewing, and editing.

### Requirements

- The file explorer MUST display a tree view of files for the active project's repository.
- The file explorer MUST support multiple roots — when an org has multiple projects, each project's repo appears as a root node.
- The tree MUST support expand/collapse of directories, with state persisted per-project in `localStorage`.
- Clicking a file MUST open it as a tab in the main content area.
- The file viewer MUST use Monaco editor for syntax-highlighted viewing and editing.
- The file explorer MUST support read mode (default) and edit mode (toggled explicitly), with save via `PUT /api/files`.
- The server MUST expose a file API: `GET /api/files?path=...&project=...` (read file), `PUT /api/files` (write file), `GET /api/files/tree?path=...&project=...` (directory listing).
- The file API MUST validate that requested paths are within the project's repository — path traversal MUST be rejected with 403.
- The file API MUST be protected by the auth middleware from Phase 1.
- The file explorer MUST show file type icons based on extension.
- The file explorer MUST support right-click context menu: new file, new folder, rename, delete, copy path.
- File creation and deletion MUST emit `file.created` and `file.deleted` events on the bus.
- The file explorer MUST NOT load entire directory trees upfront — it MUST lazy-load children on expand (for performance with large repos).
- The file explorer SHOULD support a "reveal in tree" action when a file tab is active.
- The file explorer SHOULD integrate with the worktree manager — a worktree selector at the top switches which worktree's file tree is displayed.
- The file explorer SHOULD show git status indicators (modified/staged/untracked) on files when git integration is available.
- The file explorer MAY support file watching via WebSocket for live tree updates when files change on disk.
- Diff viewing MUST be supported — selecting two files or viewing a modified file's diff MUST open a Monaco diff editor tab.

### Interface

```typescript
// Server API types
interface FileTreeNode {
  name: string
  path: string // relative to repo root
  type: 'file' | 'directory'
  size?: number
  children?: FileTreeNode[] // only for directories, lazy-loaded
}

interface FileContent {
  path: string
  content: string
  encoding: 'utf-8' | 'base64'
  size: number
  language?: string // detected language for Monaco
}

// Client component
interface FileExplorerProps {
  orgId: string
  projectId: string
  worktreeId?: string
  onFileSelect: (path: string) => void
}
```

### Files

```
packages/server/src/files/
├── files.ts             # File read/write logic
├── files.test.ts        # Unit tests
├── routes.ts            # Express REST API router
├── tree.ts              # Directory tree builder (lazy)
├── tree.test.ts         # Tree tests
├── watcher.ts           # File system watcher (optional, for live updates)
└── types.ts             # FileTreeNode, FileContent types

packages/client/src/components/file-explorer/
├── FileExplorer.tsx     # Root component
├── FileExplorer.test.tsx
├── FileTree.tsx         # Recursive tree view
├── FileTreeNode.tsx     # Individual node (file/dir)
├── FileViewer.tsx       # Monaco-based file viewer/editor
├── DiffViewer.tsx       # Monaco diff editor
├── ContextMenu.tsx      # Right-click context menu
├── file-icons.ts        # Extension → icon mapping
└── types.ts
```

---

## 5. Git Integration Panel

A UI panel for interacting with git state: changes, staging, commits, branches, and history.

### Requirements

- The git panel MUST show the current branch for the active worktree/project.
- The git panel MUST list changed files grouped by status: staged, modified (unstaged), and untracked.
- The git panel MUST support staging and unstaging individual files or all files.
- The git panel MUST support creating commits with a message, using the authenticated device's identity for the commit author.
- The git panel MUST support push and pull operations, with real-time progress display.
- The git panel MUST support branch switching and branch creation.
- Clicking a changed file MUST open a diff tab in the main content area.
- The server MUST expose a git API: `GET /api/git/status`, `POST /api/git/stage`, `POST /api/git/unstage`, `POST /api/git/commit`, `POST /api/git/push`, `POST /api/git/pull`, `GET /api/git/branches`, `POST /api/git/checkout`, `GET /api/git/log`.
- All git API endpoints MUST accept `orgId`, `projectId`, and optional `worktreeId` parameters to scope the operation.
- The git API MUST validate that operations are performed within a known project — arbitrary paths MUST be rejected.
- The git panel MUST emit `git.commit`, `git.push`, `git.pull`, `git.branch.created`, `git.branch.switched` events on the bus.
- The git panel MUST NOT allow push to default/protected branches — the server MUST reject pushes where the current branch matches the project's `defaultBranch`.
- The git panel MUST show a commit log view with commit graph (linear for Phase 2, graph rendering MAY come later).
- The git panel SHOULD support stash operations (stash, pop, list).
- The git panel SHOULD show the push/pull status (ahead/behind remote).
- The git panel MUST NOT store git credentials — it MUST use the system's existing git credential configuration.

### Interface

```typescript
interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: FileChange[]
  modified: FileChange[]
  untracked: string[]
}

interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string // for renames
}

interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs?: string[] // branch/tag names
}

interface GitService {
  status(orgId: string, projectId: string, worktreeId?: string): Promise<GitStatus>
  stage(orgId: string, projectId: string, paths: string[], worktreeId?: string): Promise<void>
  unstage(orgId: string, projectId: string, paths: string[], worktreeId?: string): Promise<void>
  commit(orgId: string, projectId: string, message: string, worktreeId?: string): Promise<CommitInfo>
  push(orgId: string, projectId: string, worktreeId?: string): Promise<void>
  pull(orgId: string, projectId: string, worktreeId?: string): Promise<void>
  branches(orgId: string, projectId: string): Promise<string[]>
  checkout(orgId: string, projectId: string, branch: string, create?: boolean): Promise<void>
  log(orgId: string, projectId: string, limit?: number, worktreeId?: string): Promise<CommitInfo[]>
  diff(orgId: string, projectId: string, path: string, worktreeId?: string): Promise<string>
}
```

### Files

```
packages/server/src/git/
├── git.ts               # Git CLI wrapper (executes git commands)
├── git.test.ts          # Unit tests (uses temp repos)
├── service.ts           # GitService implementation with validation
├── service.test.ts      # Service tests
├── routes.ts            # Express REST API router
└── types.ts             # GitStatus, FileChange, CommitInfo types

packages/client/src/components/git-panel/
├── GitPanel.tsx         # Root git panel component
├── GitPanel.test.tsx
├── ChangesList.tsx      # Staged/modified/untracked file groups
├── CommitForm.tsx       # Commit message input + submit
├── BranchSelector.tsx   # Branch switcher/creator
├── CommitLog.tsx        # Commit history list
└── types.ts
```

---

## 6. Embedded Terminal

xterm.js-based terminal connected to server-side PTY processes, scoped to worktrees.

### Requirements

- The terminal MUST render in the bottom panel of the IDE shell.
- The terminal MUST connect to a server-side PTY via WebSocket, providing full interactive terminal capability.
- The server MUST expose a WebSocket endpoint `ws://host/api/terminal` that creates or attaches to a PTY session.
- Each terminal session MUST have an `id`, a working directory (`cwd`), and a shell (default: user's `$SHELL` or `/bin/bash`).
- The terminal MUST support multiple concurrent terminal tabs, each with its own PTY session.
- When a worktree is active, new terminals MUST default their `cwd` to the worktree path.
- The terminal MUST support resize — client sends terminal dimensions on resize, server resizes the PTY.
- The terminal MUST emit `terminal.created`, `terminal.closed` events on the bus.
- PTY sessions MUST be cleaned up when the WebSocket disconnects (with a configurable grace period for reconnection).
- The terminal MUST NOT allow the client to set arbitrary `cwd` outside of known project/worktree paths — the server MUST validate.
- The terminal SHOULD support quick-run buttons detected from the active project's `package.json` scripts.
- The terminal SHOULD support search within terminal output.
- The terminal MAY support session persistence — reconnecting to a still-alive PTY after page reload.
- The terminal MUST handle binary data correctly (e.g. vim, htop, other full-screen TUI apps).

### Interface

```typescript
// Server-side
interface TerminalSession {
  id: string
  pid: number
  cwd: string
  shell: string
  cols: number
  rows: number
  createdAt: string
}

interface TerminalManager {
  create(opts: { cwd: string; shell?: string; cols?: number; rows?: number }): TerminalSession
  attach(sessionId: string): { onData: (cb: (data: string) => void) => void; write: (data: string) => void }
  resize(sessionId: string, cols: number, rows: number): void
  close(sessionId: string): void
  list(): TerminalSession[]
  get(sessionId: string): TerminalSession | undefined
}

// Client component
interface TerminalTabProps {
  sessionId: string
  onClose: () => void
}
```

### Files

```
packages/server/src/terminal/
├── terminal.ts          # PTY manager (uses node-pty)
├── terminal.test.ts     # Unit tests
├── ws.ts                # WebSocket handler for terminal I/O
├── types.ts             # TerminalSession types
└── routes.ts            # REST API for terminal session management

packages/client/src/components/terminal/
├── Terminal.tsx          # xterm.js wrapper component
├── Terminal.test.tsx
├── TerminalTabs.tsx      # Multi-tab terminal management
├── QuickRun.tsx          # Quick-run buttons from package.json
└── types.ts
```

---

## Cross-Cutting Concerns

### WebSocket Protocol (Phase 2 Extension)

Phase 2 extends the Phase 1 WS protocol with:

- `file.changed` — file watcher notifications
- `terminal.data` — bidirectional terminal I/O
- `terminal.resize` — terminal dimension changes
- `git.status.changed` — git status updates after file changes

The WS endpoint MUST support multiplexing — a single connection carries status updates, notifications, terminal I/O, and file events, distinguished by `type`.

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1 directories)
├── orgs/
│   ├── orgs.json
│   └── {orgId}/
│       ├── config.json
│       ├── worktree-links.json
│       └── projects/
│           └── {projectId}/
│               ├── config.json
│               └── worktrees.json
```

### Integration Tests

Phase 2 MUST include integration tests covering:

- Org creation → project addition → worktree creation → file access → git operations (full workflow)
- Worktree creation emits events → status aggregator reflects active worktrees
- Cross-project worktree links: creating linked worktrees across two projects within an org
- File API path traversal rejection (security)
- Git push to protected branch rejection (security)
- Terminal session lifecycle: create → data flow → resize → close
- Auth middleware applied to all new API endpoints

### Dependencies (New)

**Server:**

- `node-pty` — PTY spawning for terminal
- `chokidar` — file system watching (optional, for live file tree updates)

**Client:**

- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` — terminal emulator
- `monaco-editor` — code editor & diff viewer
- `solid-dnd` or equivalent — drag-and-drop for tabs

### Module Registration

All Phase 2 server modules MUST follow the Phase 1 pattern:

- Export `init(bus: EventBus, dataDir: string, ...deps): Module` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@sovereign/core`
- Express routers mounted by the main server, not self-mounting

### Testing

- Unit tests per module (same as Phase 1).
- Integration tests in a dedicated `packages/server/src/__integration__/` directory.
- Client component tests using Vitest + solid-testing-library where applicable.
- Playwright E2E tests for critical UI flows (file open → edit → save, terminal interaction) in `packages/client/tests/`.
