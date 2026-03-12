# PRINCIPLES.md — Sovereign Architecture Principles

## 1. Modular & Composable

Everything is a module. Modules compose through well-defined interfaces, not inheritance or tight coupling. Any module can be replaced, removed, or rewired without cascading changes. Prefer small, focused units that do one thing well and compose into larger behaviours.

## 2. Functional & Data-Driven

Prefer pure functions over stateful objects. Data flows through transformations, not mutation. Configuration and behaviour are expressed as data structures, not imperative code. Side effects are explicit and pushed to the edges.

## 3. Event Bus as the Nervous System

All inter-module communication flows through a typed event bus. Modules publish events; other modules subscribe. No direct cross-module function calls for state changes. The event bus is the single integration surface — if it's not on the bus, it didn't happen.

## 4. Dynamic Runtime Configuration

Every configurable value is hot-reloadable at runtime. No restarts, no downtime, no "apply and restart" patterns. Config changes emit events on the bus; modules react accordingly. If a module can't handle a config change gracefully, that's a bug in the module.

## 5. Single Source of Truth

Every piece of data has exactly one owner. No duplicated state across modules. If multiple modules need the same data, one owns it and others read from it (via events or direct read). State machines and stateful abstractions are only permitted when that module strictly owns the data in question.

## 6. File-Driven by Default

All data is written to disk as soon as possible. Files are the default persistence layer — human-readable, inspectable, diffable, recoverable. In-memory state is a cache of what's on disk, not the other way around. Read from disk as often as is performant to reduce staleness. Use faster stores (SQLite, memory) only where file I/O is a proven bottleneck, and even then the file-backed version should exist as the canonical record.

## 7. No Hidden State — Total Transparency

If state exists, it's observable. Every module exposes its current state for inspection and debugging. The system should be fully understandable by reading its files and listening to its event bus. No black boxes. The user must always see what the system is doing: no invisible loading, no stuck LLMs, no background jobs without presence. Everything is auditable and real-time. If the system is thinking, the user sees it thinking. If a job is running, the user sees it running. If something fails, the user knows immediately.

## 8. Progressive Disclosure

The interface is clean, simple, and mobile-first by default. Complexity is available but never forced. Additional tools, details, and controls expand on demand. Manage cognitive load ruthlessly — the default view shows what matters now; everything else is one interaction away.

## 9. Reliability Through Code, Power Through LLMs

Core infrastructure — scheduling, event handling, agent orchestration, state management — is implemented as deterministic code. No LLM in the critical path for system reliability. LLMs are layered on top for intelligence: planning, code generation, analysis, conversation. The baseline must work perfectly without any LLM being available. This means cron jobs fire reliably, events route correctly, and subagents are visible and responsive — all as pure code.

## 10. Mirrored External Streams

GitHub issues, PRs, CI runs, Radicle patches — every external work stream is mirrored locally as a first-class entity with a stable internal ID. Comments, status changes, and CI results sync back to the same context they originated from. The local mirror is the working surface; external platforms are synced bidirectionally. This means we can respond to PR reviews, track CI failures, and see issue progress without leaving the system — and nothing gets lost between contexts.

## 11. Orgs & Projects

An **org** is the top-level workspace — shared context, configuration, and planning across all its **projects** (git repositories). Projects are first-class entities within an org, each with its own branches, worktrees, CI, and issue/PR mirrors. Worktrees can be synchronised across projects within an org — PRs reference each other, bridging complex multi-project work streams and CI pipelines. Cross-project dependencies are native, not bolted on.

## 12. Unified Memory, Contextual Focus

One agent, one memory, spanning all orgs. Org and project-specific context is included dynamically as needed — not siloed into separate agents or separate memory stores. The agent is a single intelligence that understands all domains, with the right context surfaced for the current task.
