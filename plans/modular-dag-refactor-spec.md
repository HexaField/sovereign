# Modular DAG Refactor — Sovereign Architecture Plan

Reference model: `atlasresearch/guild-bot` — single-responsibility modules, pnpm-enforced DAG, thin entry point.

---

## What guild-bot does that sovereign doesn't

| guild-bot | sovereign (current) |
| --- | --- |
| Each module is a separate pnpm workspace package with its own `package.json` | All domain code lives in one `@sovereign/server` package — directory conventions only, nothing enforced |
| The package dependency graph **is** the module DAG — pnpm rejects illegal imports at install time | Cross-module imports are unrestricted; illegal deps only surface as bugs |
| Entry point is ~80 lines — wires instances, mounts routes, done | `index.ts` is 1,557 lines — module construction, business logic, inline route definitions, mutable forward-declarations all mixed |
| Every module's public API is its `index.ts`; internal files are not importable from outside | No public API boundary; any file is freely importable from any other module |
| `shared/` logic is in dedicated leaf packages (`@guildbot/interfaces`) | `server/src/agent-backend/shared/` is a mini shared layer buried inside a domain module |

---

## Current dependency violations

These are the illegal or problematic cross-cuts that will regress if not addressed structurally:

### 1. `scheduler` → `agent-backend` (upward dep)

`scheduler/cron-service.ts` imports from `agent-backend/openclaw/cron-bridge.ts`. The scheduler layer is supposed to be lower than the agent layer. The cron bridge types belong in `@sovereign/core` as an abstract interface; the openclaw implementation registers itself via DI.

### 2. `threads/routes.ts` → `chat` layer (upward dep)

`threads/routes.ts` imports `ChatModule` from `../chat/chat.js` and `deriveSessionKey` from `../chat/derive-session-key.js`. Threads are data; chat is a higher-level consumer. Threads must not know about chat — `deriveSessionKey` should either live in `@sovereign/core` or be passed in as a dependency.

### 3. `planning` ↔ `issues` (tight coupling — acceptable but should be explicit)

`planning/planning.ts` and `planning/types.ts` import from `issues/types.ts`. Fine directionally (planning is above issues), but should be explicit as a declared dep.

### 4. `drafts/types.ts` → `planning/types.ts` (lateral coupling)

Drafts and planning are siblings. The shared type (`EntityRef`) should live in `@sovereign/core` or a shared types layer.

### 5. `voice/provider.ts` → `recordings/transcription.ts` (lateral coupling)

Voice and recordings are peers; voice shouldn't import from recordings. The `TranscriptionProvider` interface should live in `@sovereign/core`.

### 6. `meetings/routes.ts` → `recordings` (lateral coupling)

Meetings imports `RecordingsService` and `TranscriptionQueue` from recordings. These should be passed in as deps, with types living in `@sovereign/core`.

### 7. `mcpDeps` forward-declaration hack (circular init smell)

`sovereignMcpServer` is constructed before its dependencies exist, using a mutable `mcpDeps` container that gets populated 200 lines later. This is a symptom of circular initialization that the current single-file structure makes invisible. Fix: construct `sovereignMcpServer` after all deps exist, or use proper lazy binding from the start.

### 8. Inline routes in `index.ts`

Cron management (GET/PATCH/DELETE `/api/crons*`), subagent listing (`/api/threads/:key/subagents`), and gateway-sessions (`/api/threads/gateway-sessions`) are all defined directly in the 1,557-line entry point. They belong in `scheduler/routes.ts`, `agent-backend/routes.ts`, and `threads/routes.ts` respectively.

---

## Proposed package DAG

```
Layer 0 — Primitives (no internal deps)
  @sovereign/primitives
    atomicWrite, logger, typed EventEmitter,
    jsonl reader/writer, parse-turns utilities,
    thinking-block stripper
    (currently: agent-backend/shared/* + system/logger.ts)

Layer 1 — Protocol (deps: primitives)
  @sovereign/core  [extend existing]
    bus types, WS protocol, agent-backend types/interfaces,
    canonical event type registry, TranscriptionProvider interface,
    CronBridge interface, EntityRef + cross-domain shared types

Layer 2 — Infrastructure (deps: core, primitives)
  @sovereign/config   config store, schema, env parsing
  @sovereign/auth     auth, crypto, devices, middleware

Layer 3 — Domain services (deps: core, config)
  @sovereign/orgs         org manager, project store, monorepo detection
  @sovereign/files        file service, watcher, tree
  @sovereign/git          git CLI + service (no dep on orgs — resolveProject passed in)
  @sovereign/terminal     terminal manager
  @sovereign/worktrees    worktree manager (no dep on orgs — getProject passed in)
  @sovereign/scheduler    scheduler, cron store  (no dep on agent-backend)
  @sovereign/notifications  notification store, push, rules
  @sovereign/browser      browser service

Layer 4 — Domain services (deps: layer 3 + core)
  @sovereign/diff         diff, changeset, semantic, file-diff
  @sovereign/issues       issue tracker (deps: orgs — type-only)
  @sovereign/radicle      radicle CLI + manager
  @sovereign/review       review system (deps: diff, issues — type-only via core)
  @sovereign/recordings   recordings service, transcription queue, search
  @sovereign/voice        voice module, post-processor, acknowledgment, provider

Layer 5 — Composition (deps: layer 3+4)
  @sovereign/threads      thread manager  (NO dep on chat/agent-backend)
  @sovereign/meetings     meetings, speakers, summarize, import, retention, parsers
                          (deps: recordings — type-only via core)
  @sovereign/planning     planning service, graph, parser
                          (deps: issues — type-only via core, drafts — via DI)
  @sovereign/drafts       draft store  (deps: planning — type-only via core)
  @sovereign/agent-backend  openclaw, claude-code, factory, routing, sessions-registry
                          (deps: scheduler — cron bridge via interface in core)

Layer 6 — Agent & chat (deps: layer 3–5)
  @sovereign/chat         chat module  (deps: threads, agent-backend)

Layer 7 — System / observability (deps: all)
  @sovereign/system       system module, event-stream, health-history, status aggregator

Layer 8 — Entry point (deps: all)
  @sovereign/server-app   thin wiring: creates instances, mounts routes, starts HTTP/WS
                          no business logic, no inline routes
```

---

## Structural rules (the guild-bot equivalent of PRINCIPLES.md)

Adapted from guild-bot's approach, binding for this codebase:

**1. Packages are the module boundary.** Every entry in the DAG above is a pnpm workspace package. Internal files are not part of the public API. Cross-package imports are only legal if declared in `package.json > dependencies`. This makes illegal deps a build/install error, not a convention violation.

**2. Each package has one job.** If you can't write its job in a single sentence, it's doing too much.

**3. `index.ts` is the only public surface.** Other packages import only from the package root (e.g. `@sovereign/orgs`), never from internal paths (e.g. `@sovereign/orgs/src/store.js`). Exception: explicit sub-path exports declared in `exports` field.

**4. Types flow down, implementations flow up.** Shared types and interfaces belong in `@sovereign/core`. Business logic at layer N can declare its interface in core and let layer N+1 provide the implementation via dependency injection. This is how we break the `scheduler → agent-backend` cycle.

**5. Dependency injection over direct imports for cross-cutting deps.** When a module needs something from a higher layer (e.g. threads needing to know the session key derivation), the logic is passed in as a function parameter or factory option — not imported. The `index.ts` entry point is the only place that wires instances together.

**6. The entry point is wiring only.** No route definitions, no business logic, no inline helper functions in the entry point. If a route belongs to a module, it lives in that module's `routes.ts`. The entry point creates instances, mounts `module.router`, and starts the server.

**7. `shared/` directories are banned inside domain packages.** If logic is shared, it belongs in `@sovereign/primitives` or `@sovereign/core`. A `shared/` subdirectory inside a domain package is a sign the logic doesn't belong to that domain.

---

## Requirements

### Shared primitives

- `agent-backend/shared/` (atomicWrite, logger, typed EventEmitter, jsonl reader/writer, parse-turns, thinking-block stripper) is extracted into a new `@sovereign/primitives` workspace package
- `@sovereign/primitives` has no imports from any other `@sovereign/*` package

### Core types

- `TranscriptionProvider` interface moves from `recordings/transcription.ts` to `@sovereign/core`
- `CronBridge` interface and its associated types move from `agent-backend/openclaw/cron-bridge.ts` to `@sovereign/core`
- `EntityRef` moves from `planning/types.ts` to `@sovereign/core`
- `@sovereign/core` declares `@sovereign/primitives` as a dependency

### Dependency violations fixed

- `scheduler/cron-service.ts` no longer imports from `agent-backend/openclaw/cron-bridge.ts`; it uses the `CronBridge` interface from `@sovereign/core` and openclaw registers itself at boot via a `registerCronBridge()` call
- `threads/routes.ts` no longer imports `ChatModule` or `deriveSessionKey` from the `chat/` module; both are passed in as constructor parameters and wired from the entry point
- `voice/provider.ts` imports `TranscriptionProvider` from `@sovereign/core`, not from `recordings/transcription.ts`
- `drafts/types.ts` imports `EntityRef` from `@sovereign/core`, not from `planning/types.ts`
- `meetings/routes.ts` receives `RecordingsService` and `TranscriptionQueue` as injected deps; their types come from `@sovereign/core`

### Entry point

- All cron management routes (GET/PATCH/DELETE `/api/crons*`) live in `scheduler/routes.ts`, not in `index.ts`
- Subagent routes (`/api/threads/:key/subagents`, `/api/threads/active-subagents`) live in `agent-backend/routes.ts`
- Gateway-sessions and thread history routes live in `threads/routes.ts`
- The thread cron jobs endpoint lives in `threads/routes.ts` and receives `cronService` as a dep
- `parseGitRemotes` and `getRemotes` live in `orgs/remotes.ts`
- Event stream routes and the events WS channel registration live in `system/routes.ts`
- `sovereignMcpServer` is constructed after all its dependencies exist; the `mcpDeps` mutable container is eliminated
- `index.ts` is ≤200 lines: instance creation, router mounting, server start — nothing else

### Package structure

- Each module in the DAG is a separate pnpm workspace package with its own `package.json`, `tsconfig.json`, and `src/index.ts`
- Packages to extract (bottom-up): `primitives`, `config`, `auth`, `orgs`, `files`, `git`, `terminal`, `worktrees`, `scheduler`, `notifications`, `browser`, `diff`, `issues`, `radicle`, `review`, `recordings`, `voice`, `threads`, `meetings`, `planning`, `drafts`, `agent-backend`, `chat`, `system`; the existing `server` package becomes the thin entry point
- Every package declares only the deps it actually uses in its `package.json`; pnpm errors on undeclared workspace imports
- Every package's public API is its `src/index.ts`; no other package imports internal paths

### DAG enforcement

- A `check-deps` script (e.g. `dependency-cruiser`) is added that asserts no package imports from a package at a higher layer
- `pnpm check-deps` runs in CI
- No `shared/` subdirectories exist inside domain packages

---

## Comparison: guild-bot DAG vs sovereign DAG

| guild-bot module              | sovereign equivalent                         | Layer |
| ----------------------------- | -------------------------------------------- | ----- |
| `@guildbot/interfaces`        | `@sovereign/primitives`                      | 0     |
| `@guildbot/guild-config`      | `@sovereign/config` + `@sovereign/core`      | 1–2   |
| `@guildbot/database`          | N/A (file-first persistence)                 | —     |
| `@guildbot/embedding`         | N/A                                          | —     |
| `@guildbot/llm`               | (in `@sovereign/agent-backend`)              | 5     |
| `@guildbot/media`             | `@sovereign/recordings` + `@sovereign/voice` | 4     |
| `@guildbot/recording`         | `@sovereign/recordings`                      | 4     |
| `@guildbot/rag`               | (in `@sovereign/meetings` summarization)     | 5     |
| `@guildbot/threads`           | `@sovereign/threads`                         | 5     |
| `@guildbot/message-processor` | `@sovereign/chat`                            | 6     |
| `@guildbot/discord-index`     | `@sovereign/agent-backend` routing           | 5     |
| `@guildbot/types`             | `@sovereign/core`                            | 1     |
| Discord bot entry point       | `@sovereign/server-app` (index.ts)           | 8     |

---

## What success looks like

- `packages/server/src/index.ts` is ≤200 lines: creates instances, mounts routers, starts server.
- No inline route definitions or helper functions in the entry point.
- `pnpm install` rejects any import that violates the DAG (missing dep in `package.json`).
- Every module has a tests-pass-in-isolation guarantee — you can `cd packages/orgs && pnpm test` without the rest of the repo.
- The `agent-backend/shared/` directory is gone.
- No forward-declaration mutation hacks.
- `dependency-cruiser` (or equivalent) runs in CI and enforces no upward deps.
