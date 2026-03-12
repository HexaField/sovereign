# PHASES.md — Implementation Roadmap

## Phase 1: Foundation

Event bus, scheduler, webhook receiver, auth layer, notifications, status bar. Independent services on our Express server. No external agent dependency.

## Phase 2: Orgs, Projects & Code

Org manager, multi-project support per org with shared context. Git worktree lifecycle per project, synchronised across projects for cross-project PRs and CI. IDE shell (split panels, tabs, shortcuts), file explorer, git integration panel, embedded terminal. Mobile-first, progressive disclosure.

## Phase 3: Intelligence & Session

Own session store (JSONL), typed WebSocket protocol, memory & embeddings (SQLite + vector), context compaction, system prompt assembly, dynamic config management. Bridge to OpenClaw during transition.

## Phase 4: Planning & Review

DAG planning engine with dependency-aware work graphs. Diff engine (code, plan, config). Review system with inline comments and merge workflow. Local VM CI runner (Lima/Firecracker). Cross-project dependencies.

## Phase 5: Agent Core

Tool runtime & registry, LLM router (multi-provider, streaming, fallback), agent loop (deterministic state machine), multi-agent orchestration, worktree-agent binding. **Full independence from OpenClaw.**

## Phase 6: Radicle & Sovereignty

Radicle bridge (`rad` CLI), patch workflow replacing PRs, peer-to-peer repo sync across devices, decentralized CI with signed attestations. **Full independence from GitHub.**

## Phase 7: Ecosystem

Device/node system, plugin architecture, multi-user support, voice & ambient interfaces, hardening & testing.

---

**Critical path:** 1 → 2.1 → 2.2 → 3.1 → 5.3 → 5.4 → 5.5

**Parallel tracks:** Phase 4 alongside Phase 3. VM CI independent. Radicle starts after git integration. UI shell work runs in parallel with everything.
