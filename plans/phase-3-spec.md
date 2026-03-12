# Phase 3: Config, Protocol, Memory, Diff, Issues & Review — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-03-12

This document specifies the six modules of Phase 3. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 3 depends on Phase 1 (event bus, auth, notifications, scheduler, status) and Phase 2 (orgs, projects, worktrees, files, git, terminal, IDE shell). All new modules communicate via the event bus.

Phase 3 builds the infrastructure layer while OpenClaw remains the agent runtime. Config management establishes the foundation all modules depend on. The typed WebSocket protocol replaces the raw status connection and enables real-time push for all existing server-side modules. Memory & embeddings provides project knowledge search. The diff engine provides pure computation for comparing files and structured formats. Issues and reviews are **provider-backed** — GitHub and Radicle are the sources of truth, with Sovereign providing a unified abstraction layer, local caching, and offline support.

Session store, context compaction, and system prompt assembly are deferred to Phase 5 (Agent Core) — they require owning the conversation state, which OpenClaw still manages.

---

## Wave Strategy

**Wave 1 (parallel):** Config, WebSocket Protocol, Memory & Embeddings **Wave 2 (after wave 1):** Diff Engine, Issue Tracker (parallel) **Wave 3 (after Diff Engine + Issues):** Review System **Wave 4:** Client UI components + integration tests

---

## 1. Config Management

A unified configuration system. Every other module reads its settings from here. Schema-validated, hot-reloadable, environment-overridable.

### Requirements

- The config store MUST maintain all Sovereign configuration in a single JSON file at `{dataDir}/config.json`.
- The config MUST be validated against a JSON Schema definition before every write. Invalid config writes MUST be rejected with detailed validation errors.
- The config store MUST support **hot-reload** — changes applied via the API update the in-memory config object and emit events. No process restarts, no connection drops, no interrupted in-flight work. Modules pick up new values on their next read or via bus subscription.
- The config store MUST support **namespaced access** using dot-path notation: `get('memory.ollama.url')`, `set('memory.ollama.url', 'http://...')`.
- The config store MUST support **patch** operations — partial updates deep-merged into existing config.
- The config store MUST support **defaults** — every config key has a default value. `get()` returns the merged result of defaults + user overrides.
- The config store MUST emit `config.changed` events on the bus with `{ path, oldValue, newValue }`.
- The config store MUST maintain a **change history** at `{dataDir}/config-history.jsonl` — each change logged with timestamp, key path, old value, new value, and source (`api` | `file` | `env` | `startup`).
- The config store MUST support **environment variable overrides** — env vars like `SOVEREIGN_MEMORY__OLLAMA__URL` (double underscore as path separator) override config file values. Env overrides take precedence over file values but are NOT written to disk.
- The config store MUST NOT apply invalid config — validation happens before write, failed validation returns the errors to the caller.
- The config store MUST load and validate on startup, applying defaults for any missing keys.
- The config store MUST expose a REST API:
  - `GET /api/config` — full resolved config (defaults + file + env)
  - `GET /api/config/:path` — namespaced read (dot-path in URL, e.g. `/api/config/memory.ollama.url`)
  - `PATCH /api/config` — partial update (validate, merge, write, emit)
  - `GET /api/config/schema` — JSON Schema definition
  - `GET /api/config/history` — change history with pagination
  - `POST /api/config/export` — download full config
  - `POST /api/config/import` — upload, validate, apply
- The config store SHOULD support config presets — named configurations (e.g. `"development"`, `"production"`) that can be applied as a batch.
- The config store MAY support config diffing — show differences between current and proposed config before applying.

### Default Config Schema

```typescript
interface SovereignConfig {
  server: {
    port: number // default: 3001
    host: string // default: 'localhost'
  }
  memory: {
    enabled: boolean // default: true
    ollama: {
      url: string // default: 'http://localhost:11434'
      model: string // default: 'nomic-embed-text'
    }
    chunkSize: number // default: 512
    chunkOverlap: number // default: 64
    watchDirs: string[] // default: []
    watchDebounceMs: number // default: 2000
    excludePatterns: string[] // default: ['node_modules', '.git', 'dist', 'build']
  }
  terminal: {
    shell: string // default: process.env.SHELL || '/bin/zsh'
    gracePeriodMs: number // default: 30000
    maxSessions: number // default: 10
  }
  worktrees: {
    staleDays: number // default: 14
    autoCleanupMerged: boolean // default: false
  }
  git: {
    protectedBranches: string[] // default: ['main', 'master', 'dev']
  }
  review: {
    autoAssign: boolean // default: false
    requireApproval: boolean // default: true
  }
}
```

### Interface

```typescript
interface ConfigStore {
  get<T = unknown>(path?: string): T
  set(path: string, value: unknown): void
  patch(partial: Record<string, unknown>): void
  getSchema(): object
  getHistory(opts?: { limit?: number; offset?: number }): ConfigChange[]
  exportConfig(): SovereignConfig
  importConfig(config: unknown): void // validates, then applies
  onChange(path: string, handler: (change: ConfigChange) => void): () => void
}

interface ConfigChange {
  timestamp: string
  path: string
  oldValue: unknown
  newValue: unknown
  source: 'api' | 'file' | 'env' | 'startup'
}
```

### Files

```
packages/server/src/config/
├── config.ts            # Core config store (get/set/patch, hot-reload)
├── config.test.ts       # Unit tests
├── types.ts             # SovereignConfig, ConfigChange types
├── schema.ts            # JSON Schema definition + validation
├── schema.test.ts       # Schema validation tests
├── defaults.ts          # Default values
├── env.ts               # Environment variable override resolution
├── env.test.ts          # Env override tests
├── history.ts           # Change history (JSONL append)
└── routes.ts            # Express REST API router
```

---

## 2. WebSocket Protocol

A typed, multiplexed WebSocket protocol replacing the raw status connection. All real-time communication between client and server flows through this single connection.

### Requirements

- The server MUST expose a single WebSocket endpoint at `/ws`, replacing the current raw status-only WS from Phase 2.
- All WebSocket messages MUST be JSON objects with a `type` string discriminator.
- The protocol MUST support these server → client message types:
  - `status.update` — system status (connection state, active jobs, unread notifications)
  - `session.message` — new message in a subscribed session
  - `notification.new` — new notification
  - `file.changed` — file change event (path, kind: created/modified/deleted)
  - `terminal.data` — terminal output (sessionId + base64-encoded data)
  - `git.status` — git status changed for a project
  - `worktree.update` — worktree state change
  - `review.update` — review status change
  - `error` — server-side error with code and message
  - `pong` — keepalive response
- The protocol MUST support these client → server message types:
  - `subscribe` — subscribe to event channels for a scope (`{ channels: ['terminal', 'files', 'git'], scope?: { orgId, projectId, sessionId } }`)
  - `unsubscribe` — unsubscribe from channels
  - `terminal.input` — terminal input data (sessionId + base64 data)
  - `terminal.resize` — terminal resize (sessionId + cols + rows)
  - `ping` — keepalive
- The server MUST support **multiplexing** — a single WS connection carries all event types. Events are scoped by optional `orgId`, `projectId`, or `sessionId` fields.
- The server MUST track **subscriptions** per connection — only send events the client has subscribed to. Default subscriptions on connect: `['status']`.
- The server MUST respond to `ping` with `pong`.
- The server MUST authenticate WebSocket connections using the auth module (token as query parameter `?token=...` or in the first message).
- The server MUST bridge existing bus events to WebSocket messages — when `file.created` fires on the bus, connected clients subscribed to `files` receive a `file.changed` message.
- The server MUST gracefully handle disconnections — clean up subscriptions, detach terminal sessions, emit `ws.disconnected` on the bus.
- The server MUST emit `ws.connected` and `ws.disconnected` events on the bus with the device ID.
- Binary frames MUST be supported for terminal data — binary frames use a 1-byte channel ID prefix followed by payload. Channel 0 = terminal.
- The client MUST implement automatic reconnection with exponential backoff (initial 1s, max 30s, jitter).
- The client MUST provide a **reactive SolidJS store** that components subscribe to for specific event types. Components MUST NOT manage their own WebSocket connections.
- The client MUST re-subscribe to all active channels on reconnection.
- The protocol SHOULD support message acknowledgement — optional `ackId` field on critical messages, server responds with `{ type: 'ack', ackId }`.
- The protocol MAY support per-message compression (permessage-deflate).

### Interface

```typescript
// Shared types (in @template/core)
interface WsMessage {
  type: string
  timestamp?: string
  ackId?: string
}

interface WsStatusUpdate extends WsMessage {
  type: 'status.update'
  status: { connected: boolean; activeJobs: number; unreadNotifications: number }
}

interface WsFileChanged extends WsMessage {
  type: 'file.changed'
  orgId: string
  projectId: string
  path: string
  kind: 'created' | 'modified' | 'deleted'
}

interface WsTerminalData extends WsMessage {
  type: 'terminal.data'
  sessionId: string
  data: string // base64
}

interface WsTerminalInput extends WsMessage {
  type: 'terminal.input'
  sessionId: string
  data: string // base64
}

interface WsSubscribe extends WsMessage {
  type: 'subscribe'
  channels: string[]
  scope?: { orgId?: string; projectId?: string; sessionId?: string }
}

interface WsError extends WsMessage {
  type: 'error'
  code: string
  message: string
}

// Server-side
interface WsHandler {
  handleConnection(ws: WebSocket, deviceId: string): void
  broadcast(msg: WsMessage): void
  broadcastToChannel(channel: string, msg: WsMessage, scope?: object): void
  sendTo(deviceId: string, msg: WsMessage): void
  getConnectedDevices(): string[]
}

// Client-side
interface WsStore {
  connected: Accessor<boolean>
  subscribe(channels: string[], scope?: object): void
  unsubscribe(channels: string[]): void
  on<T extends WsMessage>(type: string, handler: (msg: T) => void): () => void
  send(msg: WsMessage): void
}
```

### Files

```
packages/core/src/ws/
├── types.ts             # All WsMessage types (shared client + server)
├── protocol.ts          # Message validation, type guards, channel constants
└── protocol.test.ts     # Protocol validation tests

packages/server/src/ws/
├── handler.ts           # WebSocket connection handler + auth
├── handler.test.ts      # Handler tests
├── subscriptions.ts     # Per-connection subscription tracking
├── subscriptions.test.ts
├── bridge.ts            # Bus event → WS message bridging
├── bridge.test.ts       # Bridge tests
└── binary.ts            # Binary frame encoding/decoding

packages/client/src/ws/
├── ws-store.ts          # Reactive SolidJS WebSocket store
├── ws-store.test.ts     # Store tests
├── reconnect.ts         # Exponential backoff reconnection
└── reconnect.test.ts    # Reconnection tests
```

---

## 3. Memory & Embeddings

A local-first semantic memory system. Index project files, search them by keyword or meaning. Uses SQLite for storage, FTS5 for keyword search, sqlite-vec for vector similarity, and Ollama for local embeddings.

### Requirements

- The memory store MUST use a single SQLite database at `{dataDir}/memory/memory.db`.
- The database MUST have tables:
  - `documents` — `id TEXT PK`, `path TEXT UNIQUE`, `orgId TEXT`, `hash TEXT`, `chunk_count INTEGER`, `updated_at TEXT`
  - `chunks` — `id TEXT PK`, `document_id TEXT FK`, `content TEXT`, `start_line INTEGER`, `end_line INTEGER`, `token_count INTEGER`
  - `embeddings` — `chunk_id TEXT FK`, `vector BLOB` (sqlite-vec float32 array)
  - `chunks_fts` — FTS5 virtual table on `chunks.content` for BM25 keyword search
- The memory store MUST support **document ingestion**: given a file path, read the file, split into chunks, compute embeddings via Ollama, store everything in a single transaction.
- **Chunking** MUST be content-aware:
  - Markdown: split on headings (`## `, `### `, etc.), keeping heading as chunk prefix
  - Code (TypeScript/JavaScript): split on top-level declarations (function, class, export)
  - Fallback: fixed-size token window
  - Default chunk size: 512 tokens, 64-token overlap (configurable via config module)
- The memory store MUST track file content hashes — re-ingestion skips unchanged files (hash comparison).
- **Keyword search** MUST use FTS5 BM25 ranking.
- **Semantic search** MUST use sqlite-vec cosine similarity over embedding vectors.
- **Hybrid search** MUST combine keyword and semantic results using Reciprocal Rank Fusion: `score = Σ 1/(k + rank_i)` where `k = 60` (configurable).
- Search MUST support filters: `search(query, { orgId?, paths?, minScore?, limit?, mode? })` where mode is `keyword`, `semantic`, or `hybrid` (default).
- Embeddings MUST be generated via Ollama API (`POST /api/embed` with model from config, default `nomic-embed-text`). The Ollama URL MUST come from the config module.
- The memory store MUST gracefully handle Ollama being unavailable — ingest the document and chunks without embeddings, log a warning, allow keyword-only search. Embeddings MUST be backfillable: `backfill()` processes all chunks missing embeddings.
- The memory store MUST listen for `config.changed` events on path `memory.ollama.*` and update its Ollama client accordingly (hot-reload).
- The memory store MUST emit `memory.document.ingested`, `memory.document.removed`, `memory.search` events on the bus.
- The memory store MUST expose a REST API:
  - `POST /api/memory/ingest` — body: `{ path: string }` or `{ directory: string, patterns?: string[], exclude?: string[] }`
  - `GET /api/memory/search?q=...&mode=...&limit=...&orgId=...`
  - `GET /api/memory/documents?orgId=...` — list indexed documents
  - `DELETE /api/memory/documents/:id` — remove a document and its chunks/embeddings
  - `POST /api/memory/reindex` — re-ingest all tracked documents
  - `POST /api/memory/backfill` — generate missing embeddings
- The memory store MUST NOT load entire files into memory for chunking — stream or read in bounded segments for large files.
- A **file watcher** SHOULD automatically re-ingest changed files within configured watch directories (from config `memory.watchDirs`). The watcher MUST debounce rapid changes (configurable, default 2s). The watcher MUST respect exclude patterns from config.
- The memory store SHOULD support batch ingestion with progress reporting (emit `memory.ingest.progress` events).
- The memory store MAY support multiple embedding models (configurable per org).

### Interface

```typescript
interface MemoryDocument {
  id: string
  path: string
  orgId?: string
  hash: string
  chunkCount: number
  updatedAt: string
}

interface MemoryChunk {
  id: string
  documentId: string
  content: string
  startLine: number
  endLine: number
  tokenCount: number
}

interface SearchResult {
  chunk: MemoryChunk
  document: MemoryDocument
  score: number
  matchType: 'keyword' | 'semantic' | 'hybrid'
}

interface SearchOptions {
  orgId?: string
  paths?: string[]
  minScore?: number
  limit?: number
  mode?: 'keyword' | 'semantic' | 'hybrid'
}

interface MemoryStore {
  ingest(filePath: string, orgId?: string): Promise<MemoryDocument>
  ingestDirectory(
    dirPath: string,
    opts?: { orgId?: string; patterns?: string[]; exclude?: string[] }
  ): Promise<MemoryDocument[]>
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
  listDocuments(opts?: { orgId?: string }): MemoryDocument[]
  getDocument(docId: string): MemoryDocument | undefined
  removeDocument(docId: string): void
  reindex(): Promise<void>
  backfill(): Promise<{ processed: number; failed: number }>
  startWatcher(): void
  stopWatcher(): void
}
```

### Files

```
packages/server/src/memory/
├── memory.ts            # Core memory store (orchestrates ingest + search)
├── memory.test.ts       # Unit tests
├── types.ts             # MemoryDocument, MemoryChunk, SearchResult types
├── db.ts                # SQLite database setup (tables, FTS5, sqlite-vec)
├── db.test.ts           # Database tests
├── chunker.ts           # Content-aware text chunking
├── chunker.test.ts      # Chunker tests
├── embeddings.ts        # Ollama embedding client
├── embeddings.test.ts   # Embedding tests (mocked Ollama)
├── search.ts            # Hybrid search (FTS5 + vector + RRF fusion)
├── search.test.ts       # Search tests
├── watcher.ts           # File watcher for auto-reingestion
├── watcher.test.ts      # Watcher tests
└── routes.ts            # Express REST API router
```

---

## 4. Diff Engine

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

## 5. Issue Tracker

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

## 6. Review System

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

## Cross-Cutting Concerns

### Integration Tests

Phase 3 MUST include integration tests covering:

- Config change via API → module picks up new value (e.g. change `memory.ollama.url` → memory store uses new URL on next call)
- WebSocket subscribe to channel → bus event fires → client receives typed message
- WebSocket auth — reject connection without valid token
- File change → memory watcher re-ingests → search finds updated content
- Memory search returns results from ingested project files
- Create worktree → create change set from worktree → diff shows branch changes
- Issue create → synced to provider → list includes new issue
- Issue provider offline → reads from cache → writes queued → flushQueue replays
- Create review (PR/patch) from worktree → add comments → approve → merge → worktree cleaned up → change set `merged`
- Review comment bidirectional sync: local → provider, provider → local cache
- Cross-module event flow: review.merged → notification.created → ws push to client
- All new REST endpoints protected by auth middleware

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1 + 2 directories)
├── memory/
│   └── memory.db            # SQLite (documents, chunks, embeddings, FTS5)
├── issues/
│   ├── {orgId}/{projectId}/ # Cached issue JSON files
│   └── queue.jsonl          # Offline write queue
├── reviews/
│   ├── {orgId}/{projectId}/ # Cached review JSON files
│   └── {changeSetId}.json   # Local change set metadata
├── config.json              # Unified configuration
└── config-history.jsonl     # Config change log
```

### Dependencies (New)

**Server:**

- `better-sqlite3` + `@types/better-sqlite3` — synchronous SQLite driver
- `sqlite-vec` — vector similarity extension for SQLite
- `diff` + `@types/diff` — text diff computation (or implement Myers' directly)
- `js-yaml` — YAML parsing for semantic diffs
- `@iarna/toml` — TOML parsing for semantic diffs
- `ajv` — JSON Schema validation for config

**Core:**

- WebSocket protocol types (shared between client and server)

**Client:**

- No new external dependencies (SolidJS stores + existing infrastructure)

### Module Registration

All Phase 3 server modules MUST follow the established pattern:

- Export `create*(bus: EventBus, dataDir: string, ...deps)` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@template/core`
- Express routers mounted by the main server, not self-mounting
- Read configuration from the config module, not from environment directly (except config module itself, which reads env for bootstrapping)

### Testing

- Unit tests per module following established patterns (Vitest, temp directories, injectable bus).
- Integration tests in `packages/server/src/__integration__/phase3.test.ts`.
- Client WebSocket store tests using a mock WebSocket.
- Memory tests using in-memory SQLite (`:memory:`) for speed.
- Embedding tests mock the Ollama HTTP call (no real API calls in tests).
- Diff tests use inline string fixtures (no real git repos needed for text diff; file-diff tests use temp git repos as in Phase 2).
- Issue provider tests mock `gh` and `rad` CLI calls (no real GitHub/Radicle access in tests).
- Review provider tests mock `gh` and `rad` CLI calls. Merge tests use injected mock dependencies.
