# PHASES.md — Implementation Roadmap

## Phase 1: Foundation ✅

Event bus, scheduler, webhook receiver, auth layer, notifications, status bar. Independent services on our Express server. No external agent dependency.

## Phase 2: Orgs, Projects & Code ✅

Org manager, multi-project support per org with shared context. Git worktree lifecycle per project, synchronised across projects for cross-project PRs and CI. IDE shell (split panels, tabs, shortcuts), file explorer, git integration panel, embedded terminal. Mobile-first, progressive disclosure.

## Phase 3: Config, Protocol & Memory

Dynamic config management (schema-validated, hot-reload, env overrides). Typed multiplexed WebSocket protocol replacing the raw status connection. Local-first memory & embeddings (SQLite + FTS5 + sqlite-vec + Ollama).

Still relies on OpenClaw for agent runtime.

## Phase 4: Diff, Issues & Review

Diff engine (text, file, semantic for JSON/YAML/TOML, change sets). Provider-backed issue tracker and code review system — GitHub and Radicle as sources of truth, unified behind a provider abstraction with multi-remote support per project. Sovereign caches for performance and offline access but does NOT maintain its own authoritative issue/review store.

## Phase 5: Planning & CI

DAG planning engine with dependency-aware work graphs. Planning UI (graph, kanban, list, tree views). Local VM CI runner (Lima/QEMU on macOS, Firecracker on Linux). Pipeline YAML, artifact caching, matrix builds.

## Phase 6: Agent Core (beta release)

Own session store (JSONL), context compaction, system prompt assembly. Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. **Full independence from OpenClaw.**

## Phase 7: Radicle & Sovereignty (initial release)

Radicle repo management (`rad` CLI), peer-to-peer repo sync across devices, decentralized CI with signed attestations. Note: Radicle issue and patch providers are introduced in Phase 4 — Phase 7 adds the deeper integration. **Full independence from GitHub.**

## Phase 8: Ecosystem (long-term vision)

Device/node system, plugin architecture, multi-user support, voice & ambient interfaces, hardening & testing.

---

**Critical path:** 1 → 2 → 3 → 6.session → 6.agent-loop → 6.multi-agent

**Parallel tracks:** Phase 5 alongside Phase 4. VM CI independent. Radicle starts after git integration. UI work runs in parallel with everything.
