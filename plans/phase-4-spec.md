# Phase 4: Diff, Issues, Review & Radicle — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-03-12

This document specifies the four modules of Phase 4. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 4 depends on Phases 1–3 (event bus, auth, orgs, projects, worktrees, files, git, config, WebSocket protocol). All new modules communicate via the event bus.

The diff engine provides pure computation for comparing files and structured formats. Issues and reviews are **provider-backed** — GitHub and Radicle are the sources of truth, with Sovereign providing a unified abstraction layer, local caching, and offline support. Projects support multiple remotes (e.g. GitHub + Radicle), and issues/reviews are aggregated across all configured remotes. Radicle repo management provides first-class `rad` CLI integration for managing decentralized repositories.

---

## Wave Strategy

**Wave 1 (parallel):** Diff Engine, Issue Tracker, Radicle Repo Management **Wave 2 (after wave 1):** Review System **Wave 3:** Client UI components + integration tests

---

## 1. Diff Engine

Core diff computation for files, structured formats, and change sets. Provides the data layer for the review system and for displaying diffs in the IDE.

### Requirements

- The diff engine MUST compute unified diffs between two strings or two file versions (by path + ref/commit).
- The diff engine MUST produce structured output: an array of **hunks**, each containing line-level changes with `added`, `removed`, and `context` line types.
- A **hunk** MUST have: `oldStart`, `oldLines`, `newStart`, `newLines`, `lines[]` where each line has `type` (`add` | `remove` | `context`), `content`, `oldLineNumber?`, `newLineNumber?`.
- The diff engine MUST support **file diffs** — diff between two commits for a given file path within a git repo. It MUST use the git module from Phase 2 to retrieve file content at specific refs.
- The diff engine MUST support **working tree diffs** — diff between HEAD and the current working tree (unstaged changes) and between index and working tree (staged vs unstaged).
- The diff engine MUST support **semantic diffs** for structured formats:
  - JSON: key-level changes (added key, removed key, changed value) with path notation
  - YAML: same as JSON (parse to object, diff objects)
  - TOML: same as JSON
  - Package.json: special handling for dependency version changes (show old → new version)
- Semantic diffs MUST fall back to text diff if the file fails to parse.
- The diff engine MUST support a **change set** model — a named group of related diffs that represents a logical unit of work (e.g. all changes in a worktree branch, or all changes in a PR).
- A **change set** MUST have: `id`, `title`, `description`, `orgId`, `projectId`, `worktreeId?`, `baseBranch`, `headBranch`, `files[]` (list of changed file paths with status: added/modified/deleted/renamed), `createdAt`, `updatedAt`, `status` (`open` | `reviewing` | `approved` | `merged` | `closed`).
- The diff engine MUST support creating a change set from a worktree (compares worktree branch to its base branch) and from two arbitrary refs.
- The diff engine MUST support **cross-project change sets** — a change set can span multiple projects within an org (e.g. when a worktree has linked worktrees in other projects).
- The diff engine MUST persist change sets as JSON files at `{dataDir}/reviews/{changeSetId}.json`.
- The diff engine MUST emit `changeset.created`, `changeset.updated`, `changeset.closed` events on the bus.
- The diff engine MUST expose a REST API:
  - `GET /api/diff?path=...&base=...&head=...&projectId=...` — compute diff for a file
  - `GET /api/diff/working?projectId=...&worktreeId=...` — working tree diff
  - `GET /api/diff/semantic?path=...&base=...&head=...` — semantic diff (JSON/YAML/TOML)
  - `POST /api/changesets` — create change set from worktree or refs
  - `GET /api/changesets?orgId=...&status=...` — list change sets
  - `GET /api/changesets/:id` — get change set with file list
  - `GET /api/changesets/:id/files/:path` — get diff for a specific file in the change set
  - `PATCH /api/changesets/:id` — update status/metadata
  - `DELETE /api/changesets/:id` — close/delete change set
- The diff engine MUST NOT shell out to `diff` — use a JavaScript diff library or implement Myers' algorithm. Git diffs are retrieved via `git diff` through the Phase 2 git module.
- The diff engine SHOULD support rename/move detection (matching file content across different paths).
- The diff engine SHOULD support binary file detection (report as binary, no line diff).
- The diff engine MAY support word-level diff within changed lines (highlight the specific characters that changed).

### Interface

```typescript
interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

interface FileDiff {
  path: string
  oldPath?: string // if renamed
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

interface SemanticChange {
  path: string // JSON path, e.g. "dependencies.express"
  type: 'added' | 'removed' | 'changed'
  oldValue?: unknown
  newValue?: unknown
}

interface SemanticDiff {
  format: 'json' | 'yaml' | 'toml'
  changes: SemanticChange[]
  fallbackTextDiff?: FileDiff // if parsing failed
}

interface ChangeSet {
  id: string
  title: string
  description: string
  orgId: string
  projectId: string
  worktreeId?: string
  baseBranch: string
  headBranch: string
  files: { path: string; status: string; additions: number; deletions: number }[]
  status: 'open' | 'reviewing' | 'approved' | 'merged' | 'closed'
  createdAt: string
  updatedAt: string
}

interface DiffEngine {
  diffText(oldText: string, newText: string): DiffHunk[]
  diffFile(projectPath: string, filePath: string, base: string, head: string): Promise<FileDiff>
  diffWorking(projectPath: string, opts?: { staged?: boolean }): Promise<FileDiff[]>
  diffSemantic(oldText: string, newText: string, format: string): SemanticDiff

  createChangeSet(data: {
    orgId: string
    projectId: string
    worktreeId?: string
    baseBranch: string
    headBranch: string
    title: string
    description?: string
  }): Promise<ChangeSet>
  getChangeSet(id: string): ChangeSet | undefined
  listChangeSets(filter?: { orgId?: string; status?: string }): ChangeSet[]
  updateChangeSet(id: string, patch: Partial<ChangeSet>): ChangeSet
  deleteChangeSet(id: string): void
  getChangeSetFileDiff(changeSetId: string, filePath: string): Promise<FileDiff>
}
```

### Files

```
packages/server/src/diff/
├── diff.ts              # Core text diff (Myers' algorithm or library wrapper)
├── diff.test.ts         # Text diff tests
├── types.ts             # DiffHunk, FileDiff, ChangeSet, SemanticChange types
├── file-diff.ts         # File diff via git (uses git module)
├── file-diff.test.ts    # File diff tests
├── semantic.ts          # Semantic diff for JSON/YAML/TOML
├── semantic.test.ts     # Semantic diff tests
├── changeset.ts         # Change set management (CRUD, persistence)
├── changeset.test.ts    # Change set tests
└── routes.ts            # Express REST API router
```

---

## 2. Issue Tracker

A provider-backed issue tracker. GitHub Issues and Radicle Issues are the sources of truth. Sovereign provides a unified API and local cache for performance and offline access.

### Requirements

- The issue tracker MUST define a **provider interface** that abstracts issue operations. Two providers MUST be implemented: `GitHubIssueProvider` (via `gh` CLI) and `RadicleIssueProvider` (via `rad issue` CLI).
- Each project in an org MUST support **multiple remotes**, each with its own provider. Remotes are configured in config: `projects.{projectId}.remotes: [{ name: 'origin', provider: 'github', repo: 'owner/repo' }, { name: 'rad', provider: 'radicle', rid: 'rad:z...' }]`. A project MAY have one or both provider types.
- The issue tracker MUST aggregate issues across all configured remotes for a project. Each issue carries a `remote` field identifying which remote it belongs to.
- When creating an issue, the caller MUST specify which remote to create it on (or default to the first remote). When listing, all remotes are queried and results merged.
- Cross-remote issue references SHOULD be supported — an issue on GitHub can reference a Radicle issue by ID and vice versa (display only, no automatic linking).
- A **unified issue** MUST have: `id` (provider-native ID), `projectId`, `orgId`, `title`, `body` (markdown), `state` (`open` | `closed`), `labels` (string[]), `assignees` (string[]), `author`, `createdAt`, `updatedAt`, `commentCount`, `providerUrl` (link to GitHub/Radicle web view), `providerMeta` (opaque provider-specific data).
- An **issue comment** MUST have: `id`, `issueId`, `author`, `body` (markdown), `createdAt`, `updatedAt`.
- The issue tracker MUST support: `list` (with filters: state, label, assignee, search), `get`, `create`, `update` (title, body, state, labels, assignees), `addComment`, `listComments`.
- All write operations MUST proxy to the provider — the provider is authoritative. Sovereign MUST NOT maintain its own issue state beyond a cache.
- The issue tracker MUST maintain a **local cache** at `{dataDir}/issues/{orgId}/{projectId}/` — JSON files mirroring provider data. Cache MUST be refreshed on explicit sync, on webhook receipt (if configured), or on TTL expiry (configurable, default 5 minutes).
- The issue tracker MUST support **offline reads** — when the provider is unreachable, serve from cache with a staleness indicator.
- The issue tracker MUST support **queued writes** — when offline, write operations are queued to `{dataDir}/issues/queue.jsonl` and replayed when connectivity returns.
- The `GitHubIssueProvider` MUST use the `gh` CLI for all operations: `gh issue list`, `gh issue view`, `gh issue create`, `gh issue edit`, `gh issue comment`.
- The `RadicleIssueProvider` MUST use the `rad issue` CLI: `rad issue list`, `rad issue open`, `rad issue comment`, `rad issue label`, `rad issue assign`.
- The issue tracker MUST emit events on the bus: `issue.created`, `issue.updated`, `issue.comment.added`, `issue.synced`.
- The issue tracker MUST support **cross-project views** — list issues across all projects in an org, with project as a filterable field.
- The issue tracker MUST expose a REST API:
  - `GET /api/orgs/:orgId/issues?projectId=...&remote=...&state=...&label=...&assignee=...&q=...` — list issues (cross-project if no projectId, cross-remote if no remote)
  - `GET /api/orgs/:orgId/projects/:projectId/issues/:id` — get issue
  - `POST /api/orgs/:orgId/projects/:projectId/issues` — create issue
  - `PATCH /api/orgs/:orgId/projects/:projectId/issues/:id` — update issue
  - `GET /api/orgs/:orgId/projects/:projectId/issues/:id/comments` — list comments
  - `POST /api/orgs/:orgId/projects/:projectId/issues/:id/comments` — add comment
  - `POST /api/orgs/:orgId/projects/:projectId/issues/sync` — force sync from provider
- The issue tracker MUST listen for `config.changed` events to pick up provider changes.
- The issue tracker SHOULD support **webhooks** — when a GitHub webhook fires for issue events, update the cache immediately (via the Phase 1 webhook module).
- The issue tracker MAY support label and assignee autocomplete (cached from provider).

### Interface

```typescript
interface Issue {
  id: string
  projectId: string
  orgId: string
  remote: string // which remote this issue belongs to (e.g. 'origin', 'rad')
  provider: 'github' | 'radicle'
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  author: string
  createdAt: string
  updatedAt: string
  commentCount: number
  providerUrl?: string
  providerMeta?: Record<string, unknown>
}

interface IssueComment {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
  updatedAt?: string
}

interface IssueFilter {
  projectId?: string
  remote?: string // filter to specific remote
  state?: 'open' | 'closed'
  label?: string
  assignee?: string
  q?: string
  limit?: number
  offset?: number
}

interface IssueProvider {
  list(repoPath: string, filter?: IssueFilter): Promise<Issue[]>
  get(repoPath: string, issueId: string): Promise<Issue | undefined>
  create(
    repoPath: string,
    data: { title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  update(
    repoPath: string,
    issueId: string,
    patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  listComments(repoPath: string, issueId: string): Promise<IssueComment[]>
  addComment(repoPath: string, issueId: string, body: string): Promise<IssueComment>
}

interface IssueTracker {
  list(orgId: string, filter?: IssueFilter): Promise<Issue[]>
  get(orgId: string, projectId: string, issueId: string): Promise<Issue | undefined>
  create(
    orgId: string,
    projectId: string,
    data: { remote: string; title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  update(
    orgId: string,
    projectId: string,
    issueId: string,
    patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  listComments(orgId: string, projectId: string, issueId: string): Promise<IssueComment[]>
  addComment(orgId: string, projectId: string, issueId: string, body: string): Promise<IssueComment>
  sync(orgId: string, projectId: string): Promise<{ synced: number; errors: number }>
  flushQueue(): Promise<{ replayed: number; failed: number }>
}
```

### Files

```
packages/server/src/issues/
├── issues.ts            # Core issue tracker (orchestrates providers + cache)
├── issues.test.ts       # Unit tests
├── types.ts             # Issue, IssueComment, IssueFilter, IssueProvider types
├── github.ts            # GitHub provider (gh CLI wrapper)
├── github.test.ts       # GitHub provider tests (mocked CLI)
├── radicle.ts           # Radicle provider (rad issue CLI wrapper)
├── radicle.test.ts      # Radicle provider tests (mocked CLI)
├── cache.ts             # Local JSON cache + queue management
├── cache.test.ts        # Cache tests
└── routes.ts            # Express REST API router
```

---

## 3. Review System

A provider-backed code review system. GitHub Pull Requests and Radicle Patches are the sources of truth. Sovereign provides a unified review abstraction that combines local diff computation (from section 4) with provider-managed review state.

### Requirements

- The review system MUST define a **provider interface** that abstracts review operations. Two providers MUST be implemented: `GitHubReviewProvider` (wraps `gh pr` CLI) and `RadicleReviewProvider` (wraps `rad patch` CLI).
- Each project MUST support multiple remotes for reviews, matching the issue tracker's remote configuration. A review (PR/patch) is created on a specific remote.
- When listing reviews, all remotes are queried and results merged. Each review carries a `remote` field.
- A **unified review** MUST have: `id` (provider-native ID, e.g. PR number or patch ID), `changeSetId` (local change set from diff engine), `projectId`, `orgId`, `title`, `description`, `status` (`open` | `approved` | `changes_requested` | `merged` | `closed`), `author`, `reviewers[]`, `baseBranch`, `headBranch`, `createdAt`, `updatedAt`, `mergedAt?`, `providerUrl`, `providerMeta`.
- A **review comment** MUST have: `id`, `reviewId`, `filePath`, `lineNumber`, `endLineNumber?`, `side` (`old` | `new`), `body` (markdown), `author`, `createdAt`, `resolved`, `replyTo?` (thread parent), `providerCommentId` (for sync).
- The review system MUST support creating a review from a worktree branch:
  1. Create a local change set (diff engine)
  2. Push the branch to the remote (if not already pushed)
  3. Create a PR/patch via the provider
  4. Link the local change set to the provider review
- The review system MUST support **review actions** — all proxied to the provider:
  - `approve` — approve via provider (`gh pr review --approve` / `rad patch review --accept`)
  - `request-changes` — request changes via provider with comment
  - `comment` — add review comment (not approval/rejection)
  - `merge` — merge via provider (`gh pr merge` / `rad patch merge`)
- On **merge**, the review system MUST also:
  1. Clean up the local worktree (if linked) via the worktree module
  2. Update the local change set status to `merged`
  3. Emit `review.merged` event on the bus
- **Inline comments** MUST be synced bidirectionally:
  - Local comment → pushed to provider (creates PR comment / patch comment)
  - Provider comments → pulled into local cache on sync
  - Comment resolution state synced where supported (GitHub supports resolved; Radicle may not)
- The review system MUST maintain a **local cache** at `{dataDir}/reviews/{orgId}/{projectId}/` — JSON files mirroring provider state. Same TTL/sync model as the issue tracker.
- The review system MUST support **offline reads** from cache.
- The review system MUST emit events: `review.created`, `review.updated`, `review.comment.added`, `review.comment.resolved`, `review.approved`, `review.changes_requested`, `review.merged`.
- The `GitHubReviewProvider` MUST use `gh` CLI: `gh pr create`, `gh pr list`, `gh pr view`, `gh pr review`, `gh pr merge`, `gh pr comment`.
- The `RadicleReviewProvider` MUST use `rad` CLI: `rad patch create`, `rad patch list`, `rad patch show`, `rad patch review`, `rad patch merge`, `rad patch comment`.
- The review system MUST expose a REST API:
  - `POST /api/orgs/:orgId/projects/:projectId/reviews` — create review from worktree/branch
  - `GET /api/orgs/:orgId/reviews?projectId=...&remote=...&status=...` — list reviews (cross-project/cross-remote)
  - `GET /api/orgs/:orgId/projects/:projectId/reviews/:id` — get review with metadata
  - `GET /api/orgs/:orgId/projects/:projectId/reviews/:id/diff` — get local diff (from change set)
  - `POST /api/orgs/:orgId/projects/:projectId/reviews/:id/comments` — add inline comment
  - `GET /api/orgs/:orgId/projects/:projectId/reviews/:id/comments` — list comments (threaded)
  - `PATCH /api/orgs/:orgId/projects/:projectId/reviews/:id/comments/:commentId` — resolve/edit
  - `POST /api/orgs/:orgId/projects/:projectId/reviews/:id/approve` — approve
  - `POST /api/orgs/:orgId/projects/:projectId/reviews/:id/request-changes` — request changes
  - `POST /api/orgs/:orgId/projects/:projectId/reviews/:id/merge` — merge
  - `POST /api/orgs/:orgId/projects/:projectId/reviews/sync` — force sync from provider
- The review system MUST NOT directly import from git, worktree, or diff modules — all interaction via bus or injected dependencies.
- The review system SHOULD support **review assignment** — notify assignees via the notification module.
- The review system SHOULD detect when new commits are pushed to the head branch and refresh the change set diff.
- The review system MAY support cross-project reviews (linked worktrees spanning multiple projects).

### Interface

```typescript
interface Review {
  id: string
  changeSetId: string
  projectId: string
  orgId: string
  remote: string // which remote this review lives on
  provider: 'github' | 'radicle'
  title: string
  description: string
  status: 'open' | 'approved' | 'changes_requested' | 'merged' | 'closed'
  author: string
  reviewers: string[]
  baseBranch: string
  headBranch: string
  createdAt: string
  updatedAt: string
  mergedAt?: string
  providerUrl?: string
  providerMeta?: Record<string, unknown>
}

interface ReviewComment {
  id: string
  reviewId: string
  filePath: string
  lineNumber: number
  endLineNumber?: number
  side: 'old' | 'new'
  body: string
  author: string
  createdAt: string
  resolved: boolean
  replyTo?: string
  providerCommentId?: string
}

interface ReviewProvider {
  create(
    repoPath: string,
    data: { title: string; body?: string; baseBranch: string; headBranch: string }
  ): Promise<Review>
  list(repoPath: string, filter?: { status?: string }): Promise<Review[]>
  get(repoPath: string, reviewId: string): Promise<Review | undefined>
  approve(repoPath: string, reviewId: string, body?: string): Promise<void>
  requestChanges(repoPath: string, reviewId: string, body: string): Promise<void>
  merge(repoPath: string, reviewId: string): Promise<void>
  addComment(
    repoPath: string,
    reviewId: string,
    comment: { filePath: string; lineNumber: number; body: string; side: 'old' | 'new' }
  ): Promise<ReviewComment>
  listComments(repoPath: string, reviewId: string): Promise<ReviewComment[]>
  resolveComment(repoPath: string, reviewId: string, commentId: string): Promise<void>
}

interface ReviewDeps {
  removeWorktree: (worktreeId: string) => Promise<void>
  getChangeSet: (id: string) => ChangeSet | undefined
  updateChangeSet: (id: string, patch: Partial<ChangeSet>) => ChangeSet
  getProvider: (orgId: string, projectId: string) => ReviewProvider
}

interface ReviewSystem {
  create(
    orgId: string,
    projectId: string,
    data: {
      remote: string
      worktreeId?: string
      title: string
      description?: string
      baseBranch: string
      headBranch: string
      reviewers?: string[]
    }
  ): Promise<Review>
  get(orgId: string, projectId: string, reviewId: string): Promise<Review | undefined>
  list(orgId: string, filter?: { projectId?: string; status?: string }): Promise<Review[]>

  addComment(
    orgId: string,
    projectId: string,
    reviewId: string,
    comment: {
      filePath: string
      lineNumber: number
      endLineNumber?: number
      side: 'old' | 'new'
      body: string
      replyTo?: string
    }
  ): Promise<ReviewComment>
  listComments(orgId: string, projectId: string, reviewId: string): Promise<ReviewComment[]>
  resolveComment(orgId: string, projectId: string, reviewId: string, commentId: string): Promise<void>

  approve(orgId: string, projectId: string, reviewId: string, body?: string): Promise<Review>
  requestChanges(orgId: string, projectId: string, reviewId: string, body: string): Promise<Review>
  merge(orgId: string, projectId: string, reviewId: string): Promise<Review>
  sync(orgId: string, projectId: string): Promise<{ synced: number; errors: number }>
}
```

### Files

```
packages/server/src/review/
├── review.ts            # Core review system (orchestrates providers + cache)
├── review.test.ts       # Unit tests
├── types.ts             # Review, ReviewComment, ReviewProvider types
├── github.ts            # GitHub provider (gh pr CLI wrapper)
├── github.test.ts       # GitHub provider tests (mocked CLI)
├── radicle.ts           # Radicle provider (rad patch CLI wrapper)
├── radicle.test.ts      # Radicle provider tests (mocked CLI)
├── cache.ts             # Local JSON cache for reviews
├── cache.test.ts        # Cache tests
├── merge.ts             # Merge orchestration (provider merge + local cleanup)
├── merge.test.ts        # Merge tests
└── routes.ts            # Express REST API router
```

---

## 4. Radicle Repo Management

First-class `rad` CLI integration for managing decentralized git repositories. Enables projects to use Radicle as a remote alongside (or instead of) GitHub.

### Requirements

- The module MUST provide Radicle repo operations by wrapping the `rad` CLI: `rad init`, `rad push`, `rad pull`, `rad clone`, `rad seed`.
- The module MUST support **identity management** — create/list Radicle DIDs, set default identity for signing.
- The module MUST provide a **repo dashboard** showing: peers connected, replication status, seed nodes, last sync time.
- The module MUST support **peer discovery** — list known peers, connect to new peers by Node ID, manage seed node configuration.
- The module MUST integrate with the project remote configuration from Phase 4's issue/review providers — when a project has a Radicle remote configured, Radicle repo management provides the push/pull/sync operations.
- The module MUST detect whether `rad` CLI is installed and available, gracefully degrading with clear error messages if not.
- The module MUST emit bus events: `radicle.repo.init`, `radicle.repo.pushed`, `radicle.repo.pulled`, `radicle.repo.cloned`, `radicle.peer.connected`, `radicle.peer.disconnected`.
- The module MUST expose a REST API:
  - `GET /api/radicle/status` — Radicle node status (running, identity, connected peers)
  - `POST /api/radicle/repos` — init a new Radicle repo
  - `GET /api/radicle/repos` — list Radicle repos
  - `POST /api/radicle/repos/:rid/push` — push to Radicle
  - `POST /api/radicle/repos/:rid/pull` — pull from Radicle
  - `GET /api/radicle/repos/:rid/peers` — list peers for a repo
  - `POST /api/radicle/repos/:rid/seed` — seed a repo
  - `GET /api/radicle/identity` — current Radicle identity
  - `POST /api/radicle/identity` — create/set Radicle identity
  - `GET /api/radicle/peers` — list known peers
  - `POST /api/radicle/peers` — connect to a peer
- The module SHOULD support **repo seeding configuration** — control which repos are seeded and to which peers.
- The module SHOULD track sync history (last push/pull per repo + peer).
- The module MAY support Radicle node lifecycle management (start/stop the `radicle-node` daemon).

### Interface

```typescript
interface RadicleRepoInfo {
  rid: string // Radicle repo ID (rad:z...)
  name: string
  description?: string
  defaultBranch: string
  peers: RadiclePeer[]
  delegates: string[] // DIDs with write access
  seeding: boolean
  lastSynced?: string
}

interface RadiclePeer {
  nodeId: string
  alias?: string
  address?: string
  state: 'connected' | 'disconnected'
  lastSeen?: string
}

interface RadicleIdentity {
  did: string
  alias?: string
  nodeId: string
}

interface RadicleManager {
  getStatus(): Promise<{ running: boolean; identity?: RadicleIdentity; peers: number }>
  initRepo(path: string, opts?: { name?: string; description?: string }): Promise<RadicleRepoInfo>
  listRepos(): Promise<RadicleRepoInfo[]>
  push(rid: string): Promise<void>
  pull(rid: string): Promise<void>
  clone(rid: string, path: string): Promise<void>
  seed(rid: string): Promise<void>
  unseed(rid: string): Promise<void>
  listPeers(): Promise<RadiclePeer[]>
  connectPeer(nodeId: string, address?: string): Promise<void>
  getIdentity(): Promise<RadicleIdentity | undefined>
  createIdentity(alias: string): Promise<RadicleIdentity>
}
```

### Files

```
packages/server/src/radicle/
├── radicle.ts           # Core Radicle manager (wraps rad CLI)
├── radicle.test.ts      # Unit tests (mocked rad CLI)
├── types.ts             # RadicleRepoInfo, RadiclePeer, RadicleIdentity types
├── cli.ts               # rad CLI wrapper (exec + parse output)
├── cli.test.ts          # CLI wrapper tests
└── routes.ts            # Express REST API router
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 4 MUST include integration tests covering:

- Create worktree → create change set from worktree → diff shows branch changes
- Issue create → synced to provider → list includes new issue
- Issue provider offline → reads from cache → writes queued → flushQueue replays
- Cross-project issue listing aggregates across projects and remotes
- Create review (PR/patch) from worktree → add comments → approve → merge → worktree cleaned up → change set `merged`
- Review comment bidirectional sync: local → provider, provider → local cache
- Cross-module event flow: review.merged → notification.created → ws push to client
- Radicle init repo → push → list shows repo with peers
- Radicle CLI unavailable → graceful degradation with clear error
- All new REST endpoints protected by auth middleware

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1–3 directories)
├── issues/
│   ├── {orgId}/{projectId}/ # Cached issue JSON files per remote
│   └── queue.jsonl          # Offline write queue
├── reviews/
│   ├── {orgId}/{projectId}/ # Cached review JSON files per remote
│   └── {changeSetId}.json   # Local change set metadata
```

### Dependencies (New)

**Server:**

- `diff` + `@types/diff` — text diff computation (or implement Myers' directly)
- `js-yaml` — YAML parsing for semantic diffs
- `@iarna/toml` — TOML parsing for semantic diffs

**Client:**

- No new external dependencies

### Module Registration

All Phase 4 server modules MUST follow the established pattern:

- Export `create*(bus: EventBus, dataDir: string, ...deps)` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@template/core`
- Express routers mounted by the main server, not self-mounting
- Read configuration from the config module (Phase 3)

### Testing

- Unit tests per module following established patterns (Vitest, temp directories, injectable bus).
- Integration tests in `packages/server/src/__integration__/phase4.test.ts`.
- Diff tests use inline string fixtures (no real git repos needed for text diff; file-diff tests use temp git repos as in Phase 2).
- Issue provider tests mock `gh` and `rad` CLI calls (no real GitHub/Radicle access in tests).
- Review provider tests mock `gh` and `rad` CLI calls. Merge tests use injected mock dependencies.
- Radicle tests mock `rad` CLI calls (no real Radicle node in tests).
