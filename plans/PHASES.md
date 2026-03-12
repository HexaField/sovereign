# PHASES.md — Implementation Roadmap

## Phase 1: Foundation ✅

Event bus, scheduler, webhook receiver, auth layer, notifications, status bar. Independent services on our Express server. No external agent dependency.

## Phase 2: Orgs, Projects & Code ✅

Org manager, multi-project support per org with shared context. Git worktree lifecycle per project, synchronised across projects for cross-project PRs and CI. IDE shell (split panels, tabs, shortcuts), file explorer, git integration panel, embedded terminal. Mobile-first, progressive disclosure.

## Phase 3: Config, Protocol, Memory, Diff & Review

Dynamic config management (schema-validated, hot-reload, env overrides). Typed multiplexed WebSocket protocol replacing the raw status connection. Local-first memory & embeddings (SQLite + FTS5 + sqlite-vec + Ollama). Diff engine (text, file, semantic for JSON/YAML/TOML, change sets). Code review system (inline comments, threading, approve/reject/merge, worktree cleanup).

Still relies on OpenClaw for agent runtime. Session store, context compaction, and prompt assembly deferred to Phase 5.

## Phase 4: Planning & CI

DAG planning engine with dependency-aware work graphs. Planning UI (graph, kanban, list, tree views). Local VM CI runner (Lima/QEMU on macOS, Firecracker on Linux). Pipeline YAML, artifact caching, matrix builds.

## Phase 5: Agent Core (beta release)

Own session store (JSONL), context compaction, system prompt assembly. Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. **Full independence from OpenClaw.**

## Phase 6: Radicle & Sovereignty (initial release)

Radicle bridge (`rad` CLI), patch workflow replacing PRs, peer-to-peer repo sync across devices, decentralized CI with signed attestations. **Full independence from GitHub.**

## Phase 7: Ecosystem (long-term vision)

Device/node system, plugin architecture, multi-user support, voice & ambient interfaces, hardening & testing.

---

**Critical path:** 1 → 2 → 3 → 5.session → 5.agent-loop → 5.multi-agent

**Parallel tracks:** Phase 4 alongside Phase 3. VM CI independent. Radicle starts after git integration. UI work runs in parallel with everything.
