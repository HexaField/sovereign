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

Connects to an AI agent runtime (currently OpenClaw) via authenticated WebSocket with challenge-response device identity. Entity events trigger autonomous agent work; notification events surface for user response. Designed for full backend independence — a native agent core (session store, tool runtime, LLM router, multi-agent orchestration) replaces the external bridge.

## Architecture

TypeScript monorepo. SolidJS client, Express server, shared core library. Modules export `init(bus)` and `status()` — nothing else. The event bus is the only integration surface.

```
packages/
├── client/     SolidJS + Vite + Tailwind
├── server/     Express + typed event bus + 17 modules
└── core/       Shared types, event bus, agent backend interface
```

## Quick Start

```bash
pnpm install
pnpm dev          # Hot-reloading development (client + server)
```

### Production

```bash
bin/sovereign build    # Build core → client → server
bin/sovereign start    # Start background daemon
bin/sovereign status   # Check health
bin/sovereign logs     # Tail logs
bin/sovereign stop     # Graceful shutdown
```

### Environment

Copy `.env.example` to `.env.local` and configure:

```bash
SOVEREIGN_DATA_DIR=~/.sovereign          # Persistent data directory
HOST=0.0.0.0                             # Bind address
PORT=5801                                # Server port
OPENCLAW_GATEWAY_URL=ws://localhost:3456/ws  # Agent backend
OPENCLAW_GATEWAY_TOKEN=                  # Gateway auth token
```

## Tech Stack

TypeScript · SolidJS · Express · Vite · Vitest · Tailwind CSS · pnpm workspaces · Oxlint · Husky + lint-staged
