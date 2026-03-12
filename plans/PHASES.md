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

DAG planning engine with dependency-aware work graphs. Planning UI (graph, kanban, list, tree views). Ported from voice-ui holons system, rebuilt on the DAG engine.

## Phase 6: Chat & Voice

Chat interface (message streaming, thinking blocks, work indicators, thread management, compaction indicators, rate-limit retry). Input area (multi-line, file attachments, voice recording). Voice interface (push-to-talk, TTS playback). Connects to OpenClaw gateway WS as agent backend. Integrated as IDE panels, not a standalone app.

## Phase 7: Observability

Architecture & system view (skills, tools, cron jobs, active sessions, webhooks, memory files, devices — merged into one live systems overview). Notifications panel. Events feed (webhook events, system events). Dashboard (health timeline, system status). Logs viewer. Recording management.

## Phase 8: Agent Core (beta release)

Own session store (JSONL), context compaction, system prompt assembly. Memory & embeddings (SQLite + FTS5 + sqlite-vec + Ollama). Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. **Full independence from OpenClaw.**

## Phase 9: Sovereignty & CI (initial release)

Peer-to-peer repo sync across devices via Radicle gossip. Local VM CI runner (Lima/QEMU on macOS, Firecracker on Linux). Pipeline YAML, artifact caching, matrix builds. Decentralized CI with signed attestations and distributed build farm. **Full independence from GitHub.**

## Phase 10: Ecosystem (long-term vision)

Device/node system, plugin architecture, multi-user support, ambient interfaces, hardening & testing.

---

**Critical path:** 1 → 2 → 3 → 6 → 8.session → 8.agent-loop → 8.multi-agent

**Parallel tracks:** Phase 5 alongside Phase 4–7. Phase 7 alongside Phase 6. Radicle repo mgmt (Phase 4) enables P2P sync (Phase 9). VM CI independent. UI work runs in parallel with backend.
