# PHASES.md — Implementation Roadmap

## Phase 1: Foundation ✅

Event bus, scheduler, webhook receiver, auth layer, notifications, status bar. Independent services on our Express server. No external agent dependency.

## Phase 2: Orgs, Projects & Code ✅

Org manager, multi-project support per org with shared context. Git worktree lifecycle per project, synchronised across projects for cross-project PRs and CI. IDE shell (split panels, tabs, shortcuts), file explorer, git integration panel, embedded terminal. Mobile-first, progressive disclosure.

## Phase 3: Config & Protocol ✅

Dynamic config management (schema-validated, hot-reload, env overrides). Typed multiplexed WebSocket protocol replacing the raw status connection.

Still relies on OpenClaw for agent runtime.

## Phase 4: Diff, Issues, Review & Radicle ✅

Diff engine (text, file, semantic for JSON/YAML/TOML, change sets). Provider-backed issue tracker and code review system — GitHub and Radicle as sources of truth, unified behind a provider abstraction with multi-remote support per project. Radicle repo management (`rad` CLI integration, repo dashboard, identity management, peer discovery). Sovereign caches for performance and offline access but does NOT maintain its own authoritative issue/review store.

## Phase 5: Planning ✅

DAG planning engine built directly on the issue/review system (Phase 4). Uses GitHub Issues/Projects and Radicle Issues as the backing store — no separate plan store. Sovereign adds minimal metadata (dependency edges, cross-project links) as issue labels/references. Planning UI (graph, kanban, list, tree views) reads from and writes to the provider-backed issue tracker.

## Phase 6: Chat & Voice ✅

Entity-bound chat threads: every thread is associated with a branch, issue, or PR. Events from that entity (CI, review comments, status changes) route into the thread automatically — AGENT events trigger autonomous work, NOTIFY events surface for user response. The 'main' thread and user-created threads are global (no entity binding). Message forwarding across threads for user-driven cross-thread orchestration. Input area, voice interface, gateway bridge to OpenClaw. Dashboard as the global context view.

## Phase 7: Observability ✅

Architecture & system view. Notifications and events are entity-scoped — grouped by the thread/entity they belong to, click to jump into context. Holonic event viewer — visualise event flow across entities and threads in real time. Logs viewer.

## Phase 8: Recording, Transcription & Voice Intelligence ✅

Voice as a first-class workspace modality. Meeting model with diarization (speaker identification), transcription, and summarization pipeline. Meeting summaries, action items, and decisions feed into workspace-level context and memory. Thread-level voice I/O (STT for input, TTS for responses, voice mode toggle) with device-scoped audio — TTS only plays on the device that sent the voice request; text and all other state syncs across all connected devices in real time. Conversational voice output — rule-based post-processing strips Markdown/code/paths from agent responses before TTS (LLM-powered rewriting deferred to Phase 9). Immediate voice acknowledgment — generates a single contextual sentence from the user's request (rule-based keyword extraction, e.g. "Checking the build logs now") in parallel with agent work, suppressed for fast responses (LLM-powered acknowledgments deferred to Phase 9). External meeting import (Zoom, Otter.ai, Google Meet transcripts/audio). Meetings panel in workspace sidebar, meeting detail view, speaker timeline, searchable meeting history. Workspace context integration — meeting knowledge is part of the workspace's living memory.

## Phase 9: Agent Core (beta release)

Own session store (JSONL), context compaction, system prompt assembly. Memory & embeddings (SQLite + FTS5 + sqlite-vec + Ollama). Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. Voice intelligence enhancements: LLM-powered TTS post-processing (rewrite agent responses as natural spoken language via local Ollama), context-aware voice acknowledgments (agent loop emits intent metadata, voice system generates situational acks like "Let me look at that code"). **Full independence from OpenClaw.**

## Phase 10: Sovereignty & CI (initial release)

Peer-to-peer repo sync across devices via Radicle gossip. Local VM CI runner (Lima/QEMU on macOS, Firecracker on Linux). Pipeline YAML, artifact caching, matrix builds. Decentralized CI with signed attestations and distributed build farm. **Full independence from GitHub.**

## Phase 11: Ecosystem (long-term vision)

Device/node system, plugin architecture, multi-user support, ambient interfaces, hardening & testing. **`.sovereign` project per org** — a versioned, shared wiki/config repository within each org that holds common context, documentation, tools, AI tool definitions, and prompt templates. Acts as the org's knowledge base that all projects can reference. Managed as a first-class Sovereign project (git-backed, diffable, synced via Radicle or GitHub like any other project).

---

**Critical path:** 1 → 2 → 3 → 6 → 9.session → 9.agent-loop → 9.multi-agent

**Parallel tracks:** Phase 5 alongside Phase 4–7. Phase 7 alongside Phase 6. Phase 8 alongside Phase 9. Radicle repo mgmt (Phase 4) enables P2P sync (Phase 10). VM CI independent. UI work runs in parallel with backend.
