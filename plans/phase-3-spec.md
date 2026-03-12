# Phase 3: Config, Protocol, Memory, Diff & Review — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-12

This document specifies the five modules of Phase 3. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 3 depends on Phase 1 (event bus, auth, notifications, scheduler, status) and Phase 2 (orgs, projects, worktrees, files, git, terminal, IDE shell). All new modules communicate via the event bus.

Phase 3 builds the infrastructure layer while OpenClaw remains the agent runtime. Config management establishes the foundation all modules depend on. The typed WebSocket protocol replaces the raw status connection and enables real-time push for all existing server-side modules. Memory & embeddings provides project knowledge search. The diff engine and review system bring code review workflows into the platform.

Session store, context compaction, and system prompt assembly are deferred to Phase 5 (Agent Core) — they require owning the conversation state, which OpenClaw still manages.

---

## Wave Strategy

**Wave 1 (parallel):** Config, WebSocket Protocol, Memory & Embeddings **Wave 2 (depends on Git + Files + Worktrees):** Diff Engine **Wave 3 (depends on Diff Engine):** Review System **Wave 4:** Client UI components + integration tests

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

## 5. Review System

A code review workflow built on change sets. Inline comments, review actions, merge triggers. Local-first — no GitHub dependency.

### Requirements

- A **review** MUST be attached to exactly one change set. Creating a review transitions the change set status to `reviewing`.
- A **review** MUST have: `id`, `changeSetId`, `status` (`pending` | `approved` | `changes_requested` | `merged`), `reviewers[]` (device IDs or names), `createdAt`, `updatedAt`, `mergedAt?`.
- The review system MUST support **inline comments** — comments attached to a specific file, line number, and optionally a range of lines within a change set.
- A **comment** MUST have: `id`, `reviewId`, `filePath`, `lineNumber`, `endLineNumber?` (for range), `side` (`old` | `new`), `content` (markdown), `author`, `createdAt`, `resolved` (boolean), `replyTo?` (parent comment ID for threads).
- Comments MUST support **threading** — replies to a comment form a thread. Threads can be resolved (collapsed) or unresolved.
- The review system MUST support **review actions**:
  - `approve` — mark the review as approved
  - `request-changes` — mark as changes requested, with required comment
  - `comment` — add comments without approving or requesting changes
  - `merge` — merge the change set's branch into its base branch (requires approved status if `review.requireApproval` config is true)
- **Merge** MUST:
  1. Execute `git merge` (or fast-forward) of the head branch into the base branch via the Phase 2 git module
  2. Clean up the worktree if the change set is linked to one (via the worktree module)
  3. Transition the change set status to `merged`
  4. Transition the review status to `merged`
  5. Emit `review.merged` event on the bus
- The review system MUST persist reviews as JSON files at `{dataDir}/reviews/{reviewId}.json` (alongside change set files in the same directory).
- Comments MUST be persisted as JSONL at `{dataDir}/reviews/{reviewId}-comments.jsonl` (append-only).
- The review system MUST emit events on the bus: `review.created`, `review.updated`, `review.comment.added`, `review.comment.resolved`, `review.approved`, `review.changes_requested`, `review.merged`.
- The review system MUST expose a REST API:
  - `POST /api/reviews` — create review for a change set
  - `GET /api/reviews?changeSetId=...&status=...` — list reviews
  - `GET /api/reviews/:id` — get review with metadata
  - `POST /api/reviews/:id/comments` — add comment
  - `GET /api/reviews/:id/comments` — list comments (with thread structure)
  - `PATCH /api/reviews/:id/comments/:commentId` — edit or resolve comment
  - `POST /api/reviews/:id/approve` — approve
  - `POST /api/reviews/:id/request-changes` — request changes (body: `{ comment }`)
  - `POST /api/reviews/:id/merge` — merge
- The review system MUST check merge eligibility before merging — if `review.requireApproval` config is true, the review MUST be in `approved` status. If there are unresolved comment threads, merge MUST be blocked (configurable: `review.blockOnUnresolved`, default true).
- The review system MUST NOT directly import from the git or worktree modules — all interaction MUST go through the event bus or through injected dependencies (dependency inversion).
- The review system SHOULD support **review assignment** — notify assigned reviewers via the notification module.
- The review system SHOULD update the change set's file list when new commits are pushed to the head branch (listen for git events).
- The review system MAY support **review templates** — predefined checklists attached to reviews.
- The review system MAY support cross-project reviews (a single review spanning change sets in multiple projects, using linked worktrees).

### Interface

```typescript
interface Review {
  id: string
  changeSetId: string
  status: 'pending' | 'approved' | 'changes_requested' | 'merged'
  reviewers: string[]
  createdAt: string
  updatedAt: string
  mergedAt?: string
}

interface ReviewComment {
  id: string
  reviewId: string
  filePath: string
  lineNumber: number
  endLineNumber?: number
  side: 'old' | 'new'
  content: string
  author: string
  createdAt: string
  resolved: boolean
  replyTo?: string
}

interface ReviewDeps {
  gitMerge: (projectPath: string, branch: string) => Promise<void>
  removeWorktree: (worktreeId: string) => Promise<void>
  getChangeSet: (id: string) => ChangeSet | undefined
  updateChangeSet: (id: string, patch: Partial<ChangeSet>) => ChangeSet
  notify: (event: string, data: object) => void
}

interface ReviewSystem {
  create(data: { changeSetId: string; reviewers?: string[] }): Review
  get(reviewId: string): Review | undefined
  list(filter?: { changeSetId?: string; status?: string }): Review[]

  addComment(
    reviewId: string,
    comment: Omit<ReviewComment, 'id' | 'reviewId' | 'createdAt' | 'resolved'>
  ): ReviewComment
  listComments(reviewId: string): ReviewComment[]
  resolveComment(reviewId: string, commentId: string): void
  unresolveComment(reviewId: string, commentId: string): void
  editComment(reviewId: string, commentId: string, content: string): ReviewComment

  approve(reviewId: string): Review
  requestChanges(reviewId: string, comment: string): Review
  merge(reviewId: string): Promise<Review>
  canMerge(reviewId: string): { allowed: boolean; reasons: string[] }
}
```

### Files

```
packages/server/src/review/
├── review.ts            # Core review system
├── review.test.ts       # Unit tests
├── types.ts             # Review, ReviewComment types
├── comments.ts          # Comment storage (JSONL append + read)
├── comments.test.ts     # Comment tests
├── merge.ts             # Merge logic (merge + cleanup + status transitions)
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
- Create review → add comments → approve → merge → worktree cleaned up → change set status `merged`
- Cross-module event flow: review.merged → notification.created → ws push to client
- All new REST endpoints protected by auth middleware

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1 + 2 directories)
├── memory/
│   └── memory.db            # SQLite (documents, chunks, embeddings, FTS5)
├── reviews/
│   ├── {changeSetId}.json   # Change set metadata
│   ├── {reviewId}.json      # Review metadata
│   └── {reviewId}-comments.jsonl  # Review comments
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
- Review merge tests use injected mock dependencies (no real git operations).
