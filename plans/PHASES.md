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

## Phase 5: Planning

DAG planning engine built directly on the issue/review system (Phase 4). Uses GitHub Issues/Projects and Radicle Issues as the backing store — no separate plan store. Sovereign adds minimal metadata (dependency edges, cross-project links) as issue labels/references. Planning UI (graph, kanban, list, tree views) reads from and writes to the provider-backed issue tracker.

## Phase 6: Chat & Voice

Chat interface with workspace-bound threads: each project gets its own chat context. The 'main' thread and user-created bespoke threads operate in a global (non-workspace) context. Input area (multi-line, file attachments, voice recording). Voice interface (push-to-talk, TTS playback). Connects to OpenClaw gateway WS as agent backend. The global context is primarily presented as the dashboard view — observe all workspaces and their activity, plus non-workspace activity.

## Phase 7: Observability

Architecture & system view (live systems overview). Notifications panel. Events feed. Logs viewer. Recording management. Integrated into the dashboard (global context) and per-workspace views as appropriate.

## Phase 8: Agent Core (beta release)

Own session store (JSONL), context compaction, system prompt assembly. Memory & embeddings (SQLite + FTS5 + sqlite-vec + Ollama). Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. **Full independence from OpenClaw.**

## Phase 9: Sovereignty & CI (initial release)

Peer-to-peer repo sync across devices via Radicle gossip. Local VM CI runner (Lima/QEMU on macOS, Firecracker on Linux). Pipeline YAML, artifact caching, matrix builds. Decentralized CI with signed attestations and distributed build farm. **Full independence from GitHub.**

## Phase 10: Ecosystem (long-term vision)

Device/node system, plugin architecture, multi-user support, ambient interfaces, hardening & testing.

---

**Critical path:** 1 → 2 → 3 → 6 → 8.session → 8.agent-loop → 8.multi-agent

**Parallel tracks:** Phase 5 alongside Phase 4–7. Phase 7 alongside Phase 6. Radicle repo mgmt (Phase 4) enables P2P sync (Phase 9). VM CI independent. UI work runs in parallel with backend.
