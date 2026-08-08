# Knowledge Integration — Design Plan

_Wire [`@hexafield/ad4m-rag`](https://github.com/HexaField/ad4m-rag) into Sovereign as a queryable memory substrate for the presence-internal thread. Opt-in only. No background indexing of arbitrary threads._

## Goal

Give Hex a knowledge graph that survives compaction, populated **only** from sources Hex has already curated:

1. `~/.sovereign/PRESENCE.md` already instructs Hex to write to `PRESENCE_MEMORY.md` only when something must persist or never be forgotten. Every memory entry is an opt-in.
2. `presence_watch(threadId)` is an explicit opt-in to receive digest summaries from another thread.
3. `knowledge_ingest(text, documentId)` is an explicit tool call for one-off text Hex sees fit to graph.

Nothing outside those three inflows is ingested. No cron walks chat history, no auto-pull of meeting transcripts, no scanning of other threads' state.

## Non-Goals

- Auto-ingesting non-presence threads.
- Periodic everything-pulls of chat / meeting / commit history.
- A UI for browsing the graph — the MCP `knowledge_*` tools are the v1 surface. UI follows demonstrated usage patterns.
- Publishing into shared AD4M perspectives. v1 lives entirely in a private perspective on the local Arcadia node.
- Distinguishing user-asserted vs agent-asserted claims within memory. Hex writes the memory; Hex is the asserter for everything in it.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  @sovereign/knowledge (new)                      │
│                                                                  │
│  createSovereignKnowledge(deps)                                  │
│    ├── @hexafield/ad4m-rag           (the graph)                 │
│    │     ├── private AD4M perspective (structural)               │
│    │     └── SQLite + sqlite-vec     (embeddings + FTS)          │
│    ├── Embedding client              (Ollama, configurable)      │
│    ├── LLM client                    (Anthropic via Claude Code) │
│    └── Agent DID                     (from Ad4mClient)           │
│                                                                  │
│  Inflows (the only three):                                       │
│    H1. file watcher on PRESENCE_MEMORY.md  → ingest              │
│    H2. bus subscription on presence.digest → ingest              │
│    H3. knowledge_ingest MCP tool           → ingest              │
│                                                                  │
│  Outflows:                                                       │
│    O1. knowledge_query MCP tool (presence-internal session only) │
│    O2. knowledge_get_entity / list_communities / who_asserted    │
│    O3. knowledge_retract                                         │
└──────────────────────────────────────────────────────────────────┘
```

No compile-time dependency from `@sovereign/knowledge` on `@sovereign/threads`, `@sovereign/chat`, `@sovereign/meetings`. The hooks are wired in bootstrap; the module itself only knows about presence + ad4m-rag.

---

## Inflows

### H1. `PRESENCE_MEMORY.md` → graph

- File watcher on `~/.sovereign/PRESENCE_MEMORY.md`.
- 1-second debounce — bursts of writes ingest once.
- On every change: `rag.ingest.append({ documentId: 'presence-memory:main', text: <whole file>, assertedBy: { did: hexDid, label: 'Hex' } })`.
- On Sovereign startup: ingest the file once if it exists (recovers state after a restart).
- Content-hash cache means unchanged sections never re-extract; only the diff goes through the LLM. Cost stays bounded.

### H2. Watched-thread digest → graph

- The presence package's digest service emits a new bus event, `presence.digest.entry`, every time an entry is appended to the buffer (small additive change to `packages/presence/src/digest.ts`).
- The knowledge module subscribes. Each entry becomes one document: `documentId: 'watch-digest:<threadId>:<isoTimestamp>'`, text is the one-line summary, metadata carries `{ threadId, threadLabel }`.
- Asserter is Hex (agent of record for the digest).

### H3. `knowledge_ingest` MCP tool

- Already exists in ad4m-rag's MCP tool factory; we register it.
- Gated to the presence-internal session (same gating pattern as `presence_reply_*`).
- Use case: Hex sees a detailed user statement worth structural extraction that doesn't naturally belong in `PRESENCE_MEMORY.md` (e.g., a long explanation of a system, the outcome of an offline conversation the user wants graphed). PRESENCE.md instructs Hex to use it sparingly.

---

## Outflows (MCP tools registered for the internal session)

| Tool | Purpose |
| --- | --- |
| `knowledge_query(question, mode?, fromAgents?, fromPerspectives?, maxTokens?)` | The primary outflow. Hex asks the graph what Hex knows. |
| `knowledge_get_entity(uriOrName)` | Inspect a single entity record. |
| `knowledge_list_communities(level?)` | List community summaries at a hierarchy level. |
| `knowledge_ingest(text, documentId, metadata?)` | H3 above. |
| `knowledge_who_asserted(uri)` | Provenance lookup. |
| `knowledge_retract(documentId)` | Clean up a bad ingestion. |

Not exposed in v1 (deferred to a follow-up spec):

- `knowledge_publish` / `knowledge_unpublish` — no shared perspectives until the federation story is designed.
- `knowledge_reextract` — internal maintenance; not user-facing.

The **gateway** session does **not** get any knowledge tools. If the gateway agent wants information from the graph, it asks the internal agent via `presence_internal_send`.

---

## PRESENCE.md addition

Append to `~/.sovereign/PRESENCE.md`:

```
## Knowledge graph

You have a `knowledge_query(question)` tool that answers questions about
your accumulated context — PRESENCE_MEMORY.md entries, watched-thread
digests, and anything you've explicitly ingested. The graph survives
compaction; your in-session memory does not. When recalling something
non-trivial, query the graph first.

Use `knowledge_ingest(text, documentId)` only when you see something
structurally worth graphing that doesn't fit in memory — a detailed
user explanation of a system, a meeting outcome the user explicitly
asked you to remember. Extraction has cost; default to memory entries
for normal recall.

`knowledge_retract(documentId)` cleans up a bad ingest. Use it.
```

---

## Requirements

The whole integration ships in one cohesive pass — no phased rollout.

### R1. Package skeleton

- New `packages/knowledge/` workspace package.
- Depends on `@hexafield/ad4m-rag` (from npm), `@sovereign/core`, `@sovereign/primitives`. No compile-time deps on `@sovereign/threads`, `@sovereign/chat`, `@sovereign/meetings`, `@sovereign/voice`, or `@sovereign/agent-backend`.
- Exports `createSovereignKnowledge(deps): SovereignKnowledge` returning `{ rag, mcpDeps, hooks, dispose }` — the same shape `@sovereign/presence` uses for its bootstrap wiring.

### R2. Embedding + LLM clients

- Embedding client defaults to Ollama at `http://localhost:11434` with model `nomic-embed-text`. Config keys: `knowledge.embeddingUrl`, `knowledge.embeddingModel`, `knowledge.embeddingDimension` (default 768).
- LLM client re-uses the Claude Code adapter's currently-selected model via a thin wrapper. Falls back to Haiku for extraction (cheaper) when the active model is Opus, configurable.
- If embedding endpoint isn't reachable, knowledge initialisation fails loud — the host gets a clear error at startup, not a silent degradation.

### R3. AD4M private perspective

- On first startup, create a perspective labelled `sovereign-knowledge` via `ad4mClient.perspective.add(...)`. Persist its UUID to `<dataDir>/knowledge/state.json`.
- On subsequent startups, load the UUID from state.json. If the perspective no longer exists (manually removed), recreate it and trigger `rag.store.reindex()` (which is a no-op against an empty perspective).

### R4. Agent DID resolution

- On startup, call `ad4mClient.agent.me()` once and cache the resulting DID. Used as the asserter for all H1 / H2 ingests.
- If AD4M isn't connected at boot, log a warning and use the literal `did:sovereign:hex-unconnected` as a placeholder. Claims ingested in this state are still queryable but their provenance is degraded; once AD4M reconnects, we do NOT rewrite past claims — that's a write amplification the v1 plan declines.

### R5. PRESENCE_MEMORY.md watcher (H1)

- Uses `fs.watch` (or `@sovereign/files`'s existing watcher infrastructure if the path it watches can be widened).
- 1-second debounce.
- Initial ingest on boot if file exists.
- On startup, prior `documentId='presence-memory:main'` cache survives, so unchanged content is a no-op.

### R6. Digest event hook (H2)

- Add a `presence.digest.entry` event emission to `packages/presence/src/digest.ts` (small additive change). Payload: `{ threadId, threadLabel, summary, at }`.
- Knowledge module subscribes; debounces nothing (digest entries are inherently rate-limited by other threads' turn completions).
- Each ingest is independent; identity merge inside ad4m-rag handles the case where multiple digest entries reference the same entity over time.

### R7. MCP tool registration (O1–O3)

- `SovereignKnowledge.mcpDeps` exposes the shape `agent-backend` expects (mirrors `PresenceMcpDeps` from the presence integration).
- Each tool is gated to the presence-internal session via `presence.internalThreadId()`; the gating check lives in agent-backend (same code path as the existing presence tools).
- Publishing tools are intentionally _not_ in `mcpDeps`.

### R8. Bootstrap composition

- One `createSovereignKnowledge({ bus, dataDir, configStore, ad4mClient, llm, threadManager })` call early in `bootstrap.ts`.
- Returned `mcpDeps` is passed to `wireAgentBackend({ ..., knowledge: mcpDeps })`.
- Returned `hooks` include the digest-event subscriber wired against the bus, and the memory-file watcher started against `~/.sovereign/PRESENCE_MEMORY.md`.
- `dispose()` tears down the watcher, the bus subscription, and the underlying `Ad4mRag` instance.

### R9. PRESENCE.md update

- Append the "Knowledge graph" section above to `~/.sovereign/PRESENCE.md`. Manual edit by Josh; not auto-generated.
- The personality file is loaded at session start (per R3 of the presence spec), so the change takes effect on the next internal-thread session start.

### R10. Daily community rebuild

- Cron at 04:00 local TZ runs `rag.rebuildCommunities()`.
- On completion emits `knowledge.communities.rebuilt` on the bus with `{ levels, communitiesWritten, durationMs }`.
- Failure is logged but non-fatal; queries continue against the last successful community set.

### R11. Storage

- SQLite path: `<dataDir>/knowledge/sqlite.db`.
- State file: `<dataDir>/knowledge/state.json` (perspective UUID, schema version, last community rebuild timestamp).
- No backups configured by the knowledge module — Sovereign's existing `~/.sovereign` snapshot covers the directory.

### R12. Tests

- Unit:
  - Memory-file-watcher debounce (writes within 1s collapse to one ingest).
  - Digest-event-to-ingest (each `presence.digest.entry` produces an ingest call with the right shape).
  - DID resolution fallback (AD4M disconnected → placeholder DID; logs warning).
- Integration (gated on `AD4M_RAG_INTEGRATION=1` + the harness from ad4m-rag):
  - Full round-trip: write to `PRESENCE_MEMORY.md` → file watcher fires → ingest → `knowledge_query("…")` returns an answer with citations.
  - Digest entry round-trip: emit event → ingest → query returns the watched-thread context.
- No new tests in `@sovereign/presence`; the digest-event emission is covered by the new event-emit test inside that package.

### R13. Observability

- Bus events for: ingest started/completed (per documentId), community rebuild completed, query (with mode + duration). All emitted at info level; consumers can subscribe via the existing event-stream surface.
- No new UI panels in v1. The agent + system view already render bus events; presence's existing surface is enough.

---

## Open Questions

1. **User edits PRESENCE_MEMORY.md by hand.** v1 treats it as new content from Hex (the asserter doesn't change). The content-hash cache means only changed chunks re-extract. If user-asserted-vs-Hex distinction matters later, a marker convention in the file (e.g., a `[user]` block prefix) would let the watcher tag asserter per section — out of scope for v1.

2. **Stale memory entries.** v1 doesn't auto-decay. Hex calls `knowledge_retract(documentId)` when noticing an entry is no longer useful, same pattern as the memory-pruning instruction.

3. **Multi-machine.** v1 assumes a single host (Arcadia). When Sovereign grows to a second machine the right answer is publishing into a shared AD4M perspective and reading from both — but the federation story is a separate spec.

4. **Extraction model cost.** Daily memory churn is small; digest churn scales with watched-thread activity. If extraction cost becomes a pain, the obvious lever is moving extraction to Haiku (already the plan) and batching daily rather than per-event for digest entries. Out of scope unless we hit it.

5. **Embedding model upgrades.** Changing the embedding model invalidates the embedding cache and forces a full re-embed. v1 handles this manually: bump the dimension config, delete `sqlite.db`, `rag.store.reindex()` (which re-embeds from AD4M). A `knowledge_reembed_all` admin path is a follow-up.

---

## Out of Scope

- All other JARVIS integrations (Project Narrative Layer, Temporal Self-Analysis, Simulated Advisors, Cross-Domain Synthesis). They build on top of this integration but each needs its own scoping decision and its own spec.
- Meeting-transcript ingestion. Different cost/value profile, different consent surface (meeting attendees), different spec.
- Sovereign UI for browsing the graph. Wait for usage patterns from the MCP tools to settle before designing a UI.
