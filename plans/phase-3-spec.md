# Phase 3: Intelligence & Session — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-12

This document specifies the six modules of Phase 3. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 3 depends on Phase 1 (event bus, auth, notifications, scheduler, status) and Phase 2 (orgs, projects, worktrees, files, git, terminal, IDE shell). All new modules communicate via the event bus.

Phase 3 is the intelligence layer — owning conversation state, memory, context assembly, and the typed WebSocket protocol that replaces the raw status connection from Phase 2.

---

## 1. Session Store

The session store owns all conversation state. Every message — human, assistant, tool calls, system events — is persisted as append-only JSONL. The session store replaces any external session management dependency.

### Requirements

- A **session** MUST have: `id`, `orgId` (optional), `kind` (`main` | `thread` | `agent`), `label` (optional human-readable name), `status` (`active` | `archived` | `compacted`), `createdAt`, `updatedAt`, `messageCount`, `tokenEstimate`.
- A **message** MUST have: `id`, `sessionId`, `role` (`user` | `assistant` | `system` | `tool`), `content` (string or structured), `timestamp`, `metadata` (optional: model, tokens, tool info, thinking).
- Messages MUST be persisted as append-only JSONL files at `{dataDir}/sessions/{sessionId}.jsonl` — one JSON object per line, one file per session.
- The session store MUST maintain a session index at `{dataDir}/sessions/index.json` mapping session IDs to metadata (kind, label, status, message count, last activity).
- The session store MUST support **thread routing**: a label like `thread:planning` resolves to a specific session file. Thread creation MUST be implicit — sending to a non-existent thread creates it.
- The session store MUST support session lifecycle: `create`, `append` (add message), `history` (read messages with pagination), `archive` (mark inactive), `delete` (remove JSONL file).
- The session store MUST emit `session.created`, `session.message`, `session.archived`, `session.deleted` events on the bus.
- Appending a message MUST be atomic — the JSONL line is flushed before the append call returns.
- The session store MUST support filtering sessions by kind, status, orgId, and label.
- The session store MUST support message pagination: `history(sessionId, { limit, before, after })` returning messages in chronological order.
- The session store MUST track token estimates per session (approximate, based on character count / 4 or a configurable ratio).
- The session store MUST expose a REST API: `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:id`, `GET/POST /api/sessions/:id/messages`.
- The session store MUST NOT load entire JSONL files into memory for reads — it MUST support streaming/tailing for large sessions.
- The session store SHOULD support compaction: replacing old messages with a summary while preserving the JSONL file (summary message + marker + recent messages).
- The session store MAY support session export (download JSONL) and import.

### Interface

```typescript
interface Session {
  id: string
  orgId?: string
  kind: 'main' | 'thread' | 'agent'
  label?: string
  status: 'active' | 'archived' | 'compacted'
  createdAt: string
  updatedAt: string
  messageCount: number
  tokenEstimate: number
}

interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | StructuredContent
  timestamp: string
  metadata?: {
    model?: string
    inputTokens?: number
    outputTokens?: number
    toolName?: string
    toolCallId?: string
    thinkingContent?: string
    duration?: number
  }
}

interface StructuredContent {
  type: 'text' | 'tool_call' | 'tool_result' | 'image'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: unknown
  imageUrl?: string
}

interface SessionStore {
  create(data: { kind: Session['kind']; label?: string; orgId?: string }): Session
  get(sessionId: string): Session | undefined
  list(filter?: { kind?: string; status?: string; orgId?: string; label?: string }): Session[]
  archive(sessionId: string): void
  delete(sessionId: string): void
  resolve(label: string): Session // Thread routing — finds or creates

  append(sessionId: string, message: Omit<Message, 'id' | 'sessionId' | 'timestamp'>): Message
  history(sessionId: string, opts?: { limit?: number; before?: string; after?: string }): Message[]
  compact(sessionId: string, summary: string): void
}
```

### Files

```
packages/server/src/sessions/
├── sessions.ts          # Core session store
├── sessions.test.ts     # Unit tests
├── types.ts             # Session, Message types
├── store.ts             # JSONL file I/O (append, read, tail, compact)
├── store.test.ts        # Store tests (JSONL operations)
├── index-file.ts        # Session index management
└── routes.ts            # Express REST API router
```

---

## 2. WebSocket Protocol

A typed, multiplexed WebSocket protocol that replaces the raw status connection. All real-time communication between client and server flows through this protocol.

### Requirements

- The server MUST expose a single WebSocket endpoint at `/ws` (replacing the current raw status WS).
- All WebSocket messages MUST be JSON with a `type` field discriminator.
- The protocol MUST support these message types:

  **Server → Client:**
  - `status.update` — system status (connection, active jobs, unread notifications)
  - `stream.delta` — incremental assistant response text
  - `stream.final` — completed assistant response
  - `tool.start` — tool execution started (name, input)
  - `tool.end` — tool execution completed (name, result/error)
  - `thinking` — model thinking/reasoning content
  - `session.message` — new message in a subscribed session
  - `notification.new` — new notification
  - `file.changed` — file watcher event
  - `terminal.data` — terminal I/O (binary-safe, base64 encoded)
  - `git.status.changed` — git status update
  - `error` — server-side error

  **Client → Server:**
  - `subscribe` — subscribe to events for a session/channel (`{ type: 'subscribe', sessionId, channels: ['stream', 'tools', 'thinking'] }`)
  - `unsubscribe` — unsubscribe from a session/channel
  - `terminal.data` — terminal input
  - `terminal.resize` — terminal resize
  - `ping` — keepalive

- The server MUST support multiplexing — a single WS connection carries all event types, scoped by `sessionId` where applicable.
- The server MUST send `pong` in response to `ping` for keepalive.
- The server MUST authenticate WebSocket connections using the auth module from Phase 1 (token in query param or first message).
- The protocol MUST support binary frames for terminal data and audio streaming — binary frames are prefixed with a 1-byte channel ID, remainder is payload.
- The server MUST track subscriptions per connection — only send events the client has subscribed to.
- The server MUST gracefully handle disconnections — clean up subscriptions, terminal attachments, etc.
- The WebSocket handler MUST emit `ws.connected`, `ws.disconnected` events on the bus.
- The client MUST implement automatic reconnection with exponential backoff (already partially implemented in StatusBar — extract and generalise).
- The client MUST provide a reactive WebSocket store that components can subscribe to for specific event types.
- The protocol SHOULD support message acknowledgement for critical messages (optional `ackId` field).
- The protocol MAY support compression (per-message deflate).

### Interface

```typescript
// Shared protocol types (in @template/core)
interface WsMessage {
  type: string
  sessionId?: string
  ackId?: string
  timestamp?: string
}

interface StreamDelta extends WsMessage {
  type: 'stream.delta'
  content: string
  sessionId: string
}

interface StreamFinal extends WsMessage {
  type: 'stream.final'
  content: string
  sessionId: string
  metadata?: { model: string; inputTokens: number; outputTokens: number; duration: number }
}

interface ToolStart extends WsMessage {
  type: 'tool.start'
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolCallId: string
}

interface ToolEnd extends WsMessage {
  type: 'tool.end'
  sessionId: string
  toolName: string
  toolCallId: string
  result?: unknown
  error?: string
}

interface ThinkingMessage extends WsMessage {
  type: 'thinking'
  sessionId: string
  content: string
}

interface Subscribe extends WsMessage {
  type: 'subscribe'
  sessionId: string
  channels: ('stream' | 'tools' | 'thinking' | 'terminal' | 'files' | 'git')[]
}

// Server-side handler
interface WsProtocol {
  handleConnection(ws: WebSocket, deviceId: string): void
  broadcast(type: string, data: WsMessage): void
  sendTo(deviceId: string, data: WsMessage): void
  sendToSession(sessionId: string, data: WsMessage): void
}

// Client-side store
interface WsStore {
  connected: boolean
  subscribe(sessionId: string, channels: string[]): void
  unsubscribe(sessionId: string): void
  onMessage(type: string, handler: (msg: WsMessage) => void): () => void
  send(msg: WsMessage): void
}
```

### Files

```
packages/core/src/ws/
├── types.ts             # All WsMessage types (shared client + server)
├── protocol.ts          # Message validation, type guards
├── protocol.test.ts     # Protocol validation tests

packages/server/src/ws/
├── handler.ts           # WebSocket connection handler
├── handler.test.ts      # Handler tests
├── subscriptions.ts     # Per-connection subscription tracking
├── subscriptions.test.ts
├── binary.ts            # Binary frame encoding/decoding (channel ID + payload)
└── types.ts             # Server-side WS types

packages/client/src/ws/
├── ws-store.ts          # Reactive SolidJS WebSocket store
├── ws-store.test.ts     # Store tests
├── reconnect.ts         # Reconnection with exponential backoff
└── types.ts             # Client-side types
```

---

## 3. Memory & Embeddings

A local-first semantic memory system using SQLite for storage, FTS5 for keyword search, and sqlite-vec for vector similarity search. Embeddings are generated locally via Ollama.

### Requirements

- The memory store MUST use a single SQLite database at `{dataDir}/memory/memory.db`.
- The database MUST have tables: `documents` (id, path, content, hash, updated_at), `chunks` (id, document_id, content, start_line, end_line, token_count), `embeddings` (chunk_id, vector BLOB), `fts_chunks` (FTS5 virtual table on chunk content).
- The memory store MUST support **document ingestion**: given a file path, read the file, split into chunks (by heading for Markdown, by function/class for code, or by fixed token window), compute embeddings via Ollama, and store.
- Chunking MUST be configurable: default chunk size 512 tokens with 64-token overlap.
- The memory store MUST track file hashes — re-ingestion only processes changed files (content hash comparison).
- **Keyword search** MUST use FTS5 BM25 ranking over chunk content.
- **Semantic search** MUST use sqlite-vec cosine similarity over embedding vectors.
- **Hybrid search** MUST combine keyword and semantic results using Reciprocal Rank Fusion (RRF): `score = Σ 1/(k + rank_i)` where k=60 (configurable).
- The memory store MUST support search with filters: `search(query, { orgId?, paths?, minScore?, limit? })`.
- Embedding MUST be generated via Ollama API (`POST /api/embeddings` with model `nomic-embed-text`). The Ollama URL MUST be configurable (default `http://localhost:11434`).
- The memory store MUST gracefully handle Ollama being unavailable — ingest without embeddings, log warning, allow keyword-only search. Embeddings can be backfilled later.
- The memory store MUST emit `memory.ingested`, `memory.search` events on the bus.
- The memory store MUST expose a REST API: `POST /api/memory/ingest` (trigger ingestion for a path/glob), `GET /api/memory/search?q=...`, `GET /api/memory/documents` (list indexed docs).
- A **file watcher** SHOULD automatically re-ingest changed files within tracked directories.
- The file watcher MUST be configurable: which directories to watch, debounce interval (default 2s), and file patterns to include/exclude.
- The memory store SHOULD support manual re-indexing of all documents.
- The memory store MAY support multiple embedding models (configurable per org).

### Interface

```typescript
interface Document {
  id: string
  path: string
  hash: string
  chunkCount: number
  updatedAt: string
}

interface Chunk {
  id: string
  documentId: string
  content: string
  startLine: number
  endLine: number
  tokenCount: number
}

interface SearchResult {
  chunk: Chunk
  document: Document
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
  ingest(filePath: string): Promise<Document>
  ingestDirectory(dirPath: string, opts?: { patterns?: string[]; exclude?: string[] }): Promise<Document[]>
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
  listDocuments(opts?: { orgId?: string }): Document[]
  getDocument(docId: string): Document | undefined
  removeDocument(docId: string): void
  reindex(): Promise<void>
}
```

### Files

```
packages/server/src/memory/
├── memory.ts            # Core memory store (orchestrates ingest + search)
├── memory.test.ts       # Unit tests
├── types.ts             # Document, Chunk, SearchResult types
├── db.ts                # SQLite database setup (tables, FTS5, sqlite-vec)
├── db.test.ts           # Database tests
├── chunker.ts           # Text chunking (markdown-aware, code-aware, fixed-window)
├── chunker.test.ts      # Chunker tests
├── embeddings.ts        # Ollama embedding client
├── embeddings.test.ts   # Embedding tests (with mock)
├── search.ts            # Hybrid search (FTS5 + vector + RRF fusion)
├── search.test.ts       # Search tests
├── watcher.ts           # File watcher for auto-reingestion
└── routes.ts            # Express REST API router
```

---

## 4. Context Compaction

Manages conversation context size by summarising older messages while preserving recent context and pinned turns. Uses LLMs for generating summaries.

### Requirements

- The compaction engine MUST operate on a session's message history, producing a compacted version that fits within a configurable token budget.
- The token budget MUST be configurable per session (default: 100k tokens, configurable via session metadata or org config).
- The compaction engine MUST support a **compaction strategy**:
  - `sliding-window`: keep the most recent N messages, summarise the rest into a single system message at the start.
  - `importance-weighted`: score each message by role, tool usage, decision content, and user reactions. Summarise low-importance messages first.
- **Pinned messages** MUST be preserved verbatim in the compacted output — users/agents can pin critical turns that must never be summarised.
- The compaction engine MUST use an LLM to generate summaries. The LLM call MUST be configurable (model, prompt template).
- The summary prompt MUST be structured: include key decisions, code changes, open questions, and action items from the compacted messages.
- The compaction engine MUST produce a **compaction preview** before executing: show which messages will be summarised, the estimated token savings, and the generated summary.
- Compaction MUST be reversible — the original JSONL file is preserved (renamed to `{sessionId}.jsonl.pre-compact`) before writing the compacted version.
- The compaction engine MUST emit `session.compaction.started`, `session.compaction.completed` events on the bus.
- The compaction engine MUST NOT compact sessions with fewer than 50 messages or under 10k estimated tokens.
- The compaction engine MUST expose a REST API: `POST /api/sessions/:id/compact` (trigger), `GET /api/sessions/:id/compact/preview` (preview).
- Token counting MUST use a configurable ratio (default: 1 token ≈ 4 characters) or an optional tiktoken-compatible counter.
- The compaction engine SHOULD support automatic compaction — triggered when a session exceeds its token budget, with a configurable threshold (e.g., compact when at 80% of budget).
- The compaction engine MAY support incremental compaction — only summarise the oldest unsummarised segment, not the entire history.

### Interface

```typescript
interface CompactionConfig {
  tokenBudget: number
  strategy: 'sliding-window' | 'importance-weighted'
  preserveRecentMessages: number // always keep this many recent messages
  autoCompactThreshold: number // 0-1, trigger at this % of budget
  model?: string // LLM model for summary generation
  summaryPrompt?: string // custom summary prompt template
}

interface CompactionPreview {
  sessionId: string
  currentTokens: number
  targetTokens: number
  messagesToCompact: number
  messagesToPreserve: number
  pinnedMessages: number
  estimatedSavings: number
  summary?: string // generated summary (if preview includes generation)
}

interface CompactionEngine {
  preview(sessionId: string, config?: Partial<CompactionConfig>): Promise<CompactionPreview>
  execute(sessionId: string, config?: Partial<CompactionConfig>): Promise<void>
  pin(sessionId: string, messageId: string): void
  unpin(sessionId: string, messageId: string): void
  getConfig(sessionId: string): CompactionConfig
  updateConfig(sessionId: string, patch: Partial<CompactionConfig>): void
}
```

### Files

```
packages/server/src/compaction/
├── compaction.ts        # Core compaction engine
├── compaction.test.ts   # Unit tests
├── types.ts             # CompactionConfig, CompactionPreview types
├── strategies.ts        # Sliding-window and importance-weighted strategies
├── strategies.test.ts   # Strategy tests
├── tokens.ts            # Token counting (char ratio + optional tiktoken)
├── tokens.test.ts       # Token counting tests
├── summary.ts           # LLM summary generation
└── routes.ts            # Express REST API router
```

---

## 5. System Prompt Assembly

Dynamically assembles the system prompt from prioritised sections, respecting a token budget. Ensures the most relevant context is always included.

### Requirements

- The prompt assembler MUST construct a system prompt from **sections** — discrete blocks of content with priority, token cost, and conditions.
- A **section** MUST have: `id`, `priority` (0-100, higher = more important), `content` (string or function returning string), `tokenCost` (pre-computed or lazy), `condition` (optional predicate: include only if true).
- The assembler MUST include sections in priority order until the token budget is exhausted.
- The token budget for the system prompt MUST be configurable (default: 8k tokens).
- **Built-in sections** (in priority order):
  1. `identity` (100) — SOUL.md / IDENTITY.md content
  2. `user` (95) — USER.md
  3. `principles` (90) — PRINCIPLES.md or project rules
  4. `active-context` (85) — current org, project, branch, worktree
  5. `memory-recall` (80) — relevant memory snippets from semantic search (dynamic, based on recent messages)
  6. `skills` (70) — relevant skill descriptions (filtered by recent message content)
  7. `tools` (60) — available tool descriptions
  8. `session-summary` (50) — compacted session summary (if compacted)
  9. `workspace-files` (40) — key workspace file contents
- The assembler MUST support **dynamic sections** — sections whose content is generated at assembly time (e.g., memory recall requires the recent conversation context).
- The assembler MUST support **section registration** — modules can register new sections at runtime.
- The assembler MUST cache assembled prompts by content hash — if no section content has changed, return the cached version.
- The assembler MUST emit `prompt.assembled` events on the bus with metadata (sections included, total tokens, cache hit/miss).
- The assembler MUST expose a REST API: `GET /api/prompt/preview` (show assembled prompt with section breakdown), `GET /api/prompt/sections` (list registered sections).
- The assembler SHOULD support per-org section overrides (e.g., different identity for different orgs).
- The assembler MAY support A/B testing of prompt configurations.

### Interface

```typescript
interface PromptSection {
  id: string
  priority: number
  content: string | (() => string) | (() => Promise<string>)
  tokenCost?: number // pre-computed; if absent, computed from content
  condition?: () => boolean // include only if returns true
  orgId?: string // org-specific override
}

interface AssembledPrompt {
  content: string
  sections: { id: string; priority: number; tokens: number; included: boolean }[]
  totalTokens: number
  cacheHit: boolean
  hash: string
}

interface PromptAssembler {
  register(section: PromptSection): void
  unregister(sectionId: string): void
  assemble(opts?: { tokenBudget?: number; orgId?: string; context?: string[] }): Promise<AssembledPrompt>
  preview(opts?: { tokenBudget?: number; orgId?: string }): Promise<AssembledPrompt>
  listSections(): PromptSection[]
}
```

### Files

```
packages/server/src/prompt/
├── prompt.ts            # Core prompt assembler
├── prompt.test.ts       # Unit tests
├── types.ts             # PromptSection, AssembledPrompt types
├── sections.ts          # Built-in section definitions
├── sections.test.ts     # Section tests
├── cache.ts             # Content-hash based cache
├── cache.test.ts        # Cache tests
└── routes.ts            # Express REST API router
```

---

## 6. Config Management

A unified configuration system with schema validation, UI editing, hot-reload, and import/export.

### Requirements

- The config store MUST maintain all Sovereign configuration in a single JSON file at `{dataDir}/config.json`.
- The config MUST be schema-validated using a JSON Schema definition. Invalid config writes MUST be rejected with detailed validation errors.
- The config store MUST support **hot-reload** — changes to config.json (via API or file edit) are detected and applied without restart.
- The config store MUST support **namespaced access**: `get('memory.ollama.url')`, `set('memory.ollama.url', 'http://...')` using dot-path notation.
- The config store MUST support **patch** operations — partial updates merged into existing config (deep merge).
- The config store MUST support **defaults** — every config key has a default value. `get()` returns the merged result of defaults + user overrides.
- The config store MUST emit `config.changed` events on the bus with the changed key path and old/new values.
- The config store MUST maintain a **change history** — each config change is logged to `{dataDir}/config-history.jsonl` with timestamp, key, old value, new value, source (api/file/startup).
- The config store MUST expose a REST API: `GET /api/config` (full config), `GET /api/config/:path` (namespaced read), `PATCH /api/config` (partial update), `GET /api/config/schema` (JSON schema), `GET /api/config/history` (change history).
- The config store MUST support **import/export**: `GET /api/config/export` (download), `POST /api/config/import` (upload + validate + apply).
- The config store MUST NOT apply invalid config — validation MUST happen before write.
- The config store MUST support **environment variable overrides** — env vars like `SOVEREIGN_MEMORY_OLLAMA_URL` override config file values (converted from SCREAMING_SNAKE_CASE dot paths).
- The config store SHOULD support config presets (named configurations that can be applied as a batch).
- The config store MAY support config diffing (show changes between current and proposed config).

### Default Config Schema

```typescript
interface SovereignConfig {
  server: {
    port: number // default: 3001
    host: string // default: 'localhost'
  }
  memory: {
    ollama: {
      url: string // default: 'http://localhost:11434'
      model: string // default: 'nomic-embed-text'
    }
    chunkSize: number // default: 512
    chunkOverlap: number // default: 64
    watchDirs: string[] // default: []
    watchDebounceMs: number // default: 2000
  }
  compaction: {
    tokenBudget: number // default: 100000
    strategy: string // default: 'sliding-window'
    preserveRecentMessages: number // default: 20
    autoCompactThreshold: number // default: 0.8
  }
  prompt: {
    tokenBudget: number // default: 8000
  }
  terminal: {
    shell: string // default: process.env.SHELL || '/bin/bash'
    gracePeriodMs: number // default: 30000
  }
  worktrees: {
    staleDays: number // default: 14
    autoCleanupMerged: boolean // default: false
  }
}
```

### Files

```
packages/server/src/config/
├── config.ts            # Core config store
├── config.test.ts       # Unit tests
├── types.ts             # SovereignConfig type, schema
├── schema.ts            # JSON Schema definition + validation
├── schema.test.ts       # Schema validation tests
├── history.ts           # Change history (JSONL)
├── env.ts               # Environment variable override resolution
├── env.test.ts          # Env override tests
└── routes.ts            # Express REST API router
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 3 MUST include integration tests covering:

- Session create → append messages → search memory for session content (session + memory integration)
- WebSocket subscribe to session → append message → receive `session.message` via WS
- File change → memory watcher re-ingests → search finds updated content
- Session exceeds token budget → auto-compaction triggers → compacted session still searchable
- Prompt assembly includes memory recall results from recent conversation context
- Config change via API → hot-reload → affected module picks up new value (e.g., change Ollama URL → memory store uses new URL)
- Auth middleware protects all new API endpoints
- WebSocket authentication — reject connections without valid token

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1 + 2 directories)
├── sessions/
│   ├── index.json           # Session metadata index
│   ├── {sessionId}.jsonl    # Per-session message log
│   └── {sessionId}.jsonl.pre-compact  # Pre-compaction backup
├── memory/
│   └── memory.db            # SQLite (documents, chunks, embeddings, FTS5)
├── config.json              # Unified configuration
└── config-history.jsonl     # Config change log
```

### Dependencies (New)

**Server:**

- `better-sqlite3` — SQLite driver (synchronous, fast)
- `sqlite-vec` — Vector similarity extension for SQLite
- `@anthropic-ai/tokenizer` or character-ratio based — token counting

**Core:**

- WebSocket protocol types shared between client and server

**Client:**

- No new external deps (SolidJS stores + existing WS)

### Module Registration

All Phase 3 server modules MUST follow the established pattern:

- Export `create*(bus: EventBus, dataDir: string, ...deps)` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@template/core`
- Express routers mounted by the main server, not self-mounting

### Testing

- Unit tests per module (same as Phase 1 & 2).
- Integration tests in `packages/server/src/__integration__/phase3.test.ts`.
- Client WebSocket store tests using mock WebSocket.
- Memory tests using an in-memory SQLite database (`:memory:`) for speed.
- Compaction and prompt tests using mock LLM responses (no real API calls in tests).
- Embedding tests mock the Ollama HTTP call.
