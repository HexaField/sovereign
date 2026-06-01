# Sovereign

A self-hosted, multi-org development platform that unifies code, planning, voice, and AI agents into a single interface — designed to run on your own hardware with no cloud dependencies.

## Principles

Sovereign is built on a handful of non-negotiable ideas:

- **File-driven.** All data lives on disk as human-readable files. Memory is cache; files are truth. Everything is inspectable, diffable, and recoverable.
- **Event bus as nervous system.** Every module communicates through a typed event bus. No hidden state, no direct cross-module calls. If it's not on the bus, it didn't happen.
- **Runtime configuration.** Every setting is hot-reloadable. No restarts, no downtime. Config changes propagate through the event bus and modules react.
- **Reliability through code, power through LLMs.** Core infrastructure — scheduling, events, orchestration — is deterministic code. LLMs are layered on top for intelligence. The system works perfectly without any LLM available.
- **Total transparency.** If the system is thinking, you see it thinking. If a job is running, you see it running. No invisible loading, no stuck processes, no black boxes.

## Capabilities

### Orgs & Projects

Multi-org workspace with shared context across projects. Each org contains git repositories as first-class projects with branches, worktrees, and cross-project synchronisation. A global workspace spans all orgs for personal notes, memory, and coordination.

### Code

File explorer, git integration, embedded terminal, and worktree lifecycle management. Diff engine with text, file, and semantic diffing (JSON/YAML/TOML). Cross-project worktree sync for multi-repo PRs.

### Issues & Reviews

Provider-backed issue tracking and code review — GitHub and Radicle as sources of truth, unified behind a provider abstraction. Sovereign caches for performance and offline access but never maintains its own authoritative store. Multi-remote support per project.

### Planning

DAG-based planning built directly on the issue system. GitHub Issues and Radicle Issues are the backing store — no separate plan database. Sovereign adds dependency edges and cross-project links as issue metadata. Graph, kanban, list, and tree views.

### Chat & Threads

Entity-bound chat threads: every thread can be associated with a branch, issue, or PR. Events from that entity (CI results, review comments, status changes) route into the thread automatically. Message forwarding across threads for cross-context orchestration. The main thread and user-created threads are global.

### Voice

Voice as a first-class workspace modality. Speech-to-text input, text-to-speech responses, voice mode toggle. Device-scoped audio — TTS plays only on the device that sent the voice request; text and all other state syncs across every connected device in real time. Conversational post-processing strips code and formatting from agent responses before speaking them.

### Recordings & Meetings

Meeting model with speaker diarization, transcription, and summarisation. Action items and decisions feed into workspace context and memory. External meeting import (Zoom, Otter.ai, Google Meet). Searchable meeting history with speaker timeline.

### Observability

Real-time architecture view showing every module, its subscriptions, and event flow. Entity-scoped notifications — grouped by thread, click to jump into context. Holonic event viewer. Structured logging.

### Agent Backend

A native agent core built on the Claude Agent SDK — no external bridge. Durable session store, multi-agent orchestration, an in-process cron scheduler, and a Sovereign MCP server that exposes workspace tools (sessions, agents, planning, meetings, orgs, notifications) to the agent. Entity events trigger autonomous agent work; notification events surface for user response. Sessions resume automatically after a restart, and a personality compiler assembles the agent's system prompt from per-concern Markdown source files.

## Architecture

TypeScript monorepo. A SolidJS client and an Express server compose a set of self-contained domain packages, each wired into a typed event bus. Modules export a `create*`/`register*` factory and a `status()` — nothing else. The event bus is the only integration surface.

```
packages/
├── client/      SolidJS + Vite + Tailwind
├── server/      Express + typed event bus — wires every module together
├── core/        Shared types, event bus, agent backend interface
├── config/      Runtime config store (config.json) + hot-reload + secrets
├── agent-backend/  Native Claude Code agent core, MCP server, session resume
├── primitives/  Session registry and shared low-level utilities
└── orgs · files · git · worktrees · diff · issues · review · radicle ·
    planning · drafts · threads · chat · voice · recordings · meetings ·
    notifications · scheduler · terminal · system · browser · auth · ad4m
```

## Quick Start

```bash
pnpm install
pnpm dev          # Hot-reloading development (client + server)
```

### Production

```bash
bin/sovereign build           # Guarded check/build, reload only after success
bin/sovereign start           # Install/start launchd service (macOS) and verify health
bin/sovereign restart         # Restart service and wait for /health
bin/sovereign status          # Show launchd state, logs, and HTTP health
bin/sovereign logs stderr     # Tail stderr log (or stdout/all)
bin/sovereign stop            # Graceful shutdown
```

On macOS, Sovereign now runs under a single launchd-managed service with `KeepAlive` crash recovery. `bin/sovereign build` snapshots the last known-good build artifacts, runs checks/builds first, and only then reloads the service. If startup fails after reload, it automatically restores the previous build and brings the old version back up.

### Configuration

Settings live in `config.json`, not environment variables. The file is created on first run inside the config directory (`~/.sovereign/config.json` by default) and is hot-reloadable — host/port/TLS, agent backend, voice, models, and identity all update at runtime through the event bus with no restart. Edit it directly, or change values from the system view in the UI.

Only two paths are read from the environment, for bootstrap:

```bash
SOVEREIGN_CONFIG_DIR=~/.sovereign        # User-edited state (config.json)
SOVEREIGN_DATA_DIR=~/.sovereign/data     # Runtime state (threads, secrets, logs, scheduler)
```

Secrets (API keys, tokens) live in `data/secrets.json` and never enter `config.json`.

### Migrating from OpenClaw

Sovereign began as an OpenClaw front-end and is now fully standalone. If you're coming from an `~/.openclaw/` install, one command copies all live state into a new `~/.sovereign/` home:

```bash
sovereign migrate
```

It only ever **copies** (never moves or deletes) from `~/.openclaw/`, backs up `~/.claude/CLAUDE.md` and the launchd plist, rewrites embedded absolute paths, migrates the Claude Code transcripts, and restarts with a health check — so rollback is just pointing the service back at the old data dir. See [plans/openclaw-to-sovereign-migration.md](plans/openclaw-to-sovereign-migration.md) for the full procedure and manual recovery steps.

## Tech Stack

TypeScript · SolidJS · Express · Vite · Vitest · Tailwind CSS · Claude Agent SDK · pnpm workspaces · Oxlint · Husky + lint-staged
