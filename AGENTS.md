# AGENTS.md

Read [PRINCIPLES.md](./PRINCIPLES.md) before making any architectural or implementation decisions. Every contribution must align with these principles — if it doesn't, fix the design, not the principles.

**This repo is public.** Nothing that identifies a deployment goes into tracked files: no real host or tailnet names, LAN/tailnet IPs, MAC addresses, coordinates, home paths, people's names, or captured runtime data (`.data/`, event logs, keys). Tests and docs use neutral stand-ins — `Alex`, `hub`/`worker`/`laptop`, `10.20.30.0/24` or `192.0.2.0/24`, IEEE documentation MACs (`00:00:5e:00:53:xx`), a fictional property location. Deployment-specific values live in the user's config, never in code defaults.

## Setup — ad4m submodule

The `@coasys/ad4m` SDK lives in a git submodule at `vendor/coasys/ad4m` (pinned to `coasys/ad4m` `dev`); `pnpm-workspace.yaml` resolves `@coasys/ad4m` from its `core/`. Check it out **before** `pnpm install`, or workspace resolution fails on the missing package.

```bash
git clone --recurse-submodules <repo>          # fresh clone
git submodule update --init --recursive        # existing clone
pnpm install && pnpm run build                  # build:vendor compiles core first
```

To move the pin: `cd vendor/coasys/ad4m && git fetch && git checkout <commit>`, then commit the updated gitlink in the superproject.

### A new git worktree of this repo

A fresh `git worktree add` lacks three untracked pieces that the build and tests need:

- **The submodule.** `git submodule update --init --reference <main-checkout>/.git/modules/vendor/coasys/ad4m vendor/coasys/ad4m` borrows objects from the main checkout instead of cloning ad4m.
- **Dev TLS certs.** `ln -s <main-checkout>/.certs .certs` — the client build reads `.certs/localhost.key`.
- **node-pty's native binary.** pnpm 10 skips install scripts, so copy `node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/` from the main checkout. Without it the terminal tests and every test that imports `bootstrapServer` fail on `pty.node`.

Then `pnpm install && pnpm run build`.

## Service lifecycle

Sovereign runs under a supervisor (a systemd user unit, `sovereign.service`, on Linux). `bin/sovereign` drives it: `build`, `status`, `start`, `stop`, `restart`, `logs`, `health`. Production serves the compiled `packages/server/dist/index.js`, so source edits change nothing until `bin/sovereign build` runs.

Never signal the server pid directly. Use `bin/sovereign restart` or the supervisor's own restart command — a direct kill leaves the supervisor's view of the process stale, which is the first step of the failure below.

### Shutdown must call `process.exit()`

`packages/server/src/index.ts` handles SIGINT and SIGTERM. Registering those listeners overrides Node's default terminate-on-signal, so the handler **must** exit explicitly. Sovereign always holds open handles (agent-backend subprocesses, websockets, intervals), so without an explicit exit the process cleans up and then keeps running.

The observed failure chain, if that exit is missing:

1. The supervisor sends SIGINT; the process shuts down but survives.
2. The supervisor loses track of it; the process re-parents to init while still holding `.sovereign.lock` and the server port.
3. Each replacement start correctly refuses to boot on the held lock.
4. With unlimited restarts, this loops silently and indefinitely (observed 2026-08-01: 41,901 restarts across 58 hours).

### Required supervisor directives

- **A start rate limit** (`StartLimitIntervalSec` + `StartLimitBurst`). Without it, a persistent start failure retries forever and stays invisible. With it, the unit lands in `failed`, where a status check surfaces it immediately.
- **`KillSignal=SIGINT`** — the server's graceful path.
- **`TimeoutStopSec`** of ~30s. Shutdown only flushes to disk and closes streams. In-flight LLM turns are severed deliberately; the resume orchestrator picks them up on the next boot.
- **`Restart=on-failure`**, paired with the start rate limit above.

### Single-instance lock

`packages/server/src/lockfile.ts` holds the policy; `.sovereign.lock` lives in the data dir. Two invariants, both covered by `lockfile.test.ts`:

- A live lock holder that is **not** a Sovereign process never blocks a boot. Pids get recycled, and a false positive wedges the service permanently.
- `release()` only unlinks a lock the calling process owns. An instance that loses the race and exits must not disarm the guard for the winner.

The lock is a diagnostic aid, not the only guard — the port bind fails independently if two instances ever race. The server also re-checks lock ownership every 30s and logs loudly if the lock vanishes or changes hands, because a disarmed guard is otherwise completely silent.

### Only one unit may manage the service

`bin/sovereign` drives the **user-scope** unit (`systemctl --user`). A system-scope unit of the same name is a duplicate, and duplicates are destructive here: on 2026-08-01 a leftover `/etc/systemd/system/sovereign.service` was still `enabled`, crash-looping every ~11s on `EADDRINUSE`, and carried

    ExecStartPre=/bin/rm -f .../.sovereign.lock

so it deleted the healthy instance's lock roughly five times a minute. Never write an `ExecStartPre` that removes the lock — that defeats the guard by design, and it converts a clean "refusing to boot" into an instance race.

To audit both scopes:

    systemctl --user status sovereign.service
    systemctl status sovereign.service        # must not exist / must be disabled

## Rebuild semantics

A rebuild severs in-flight agent turns rather than draining them. Draining deadlocks whenever the rebuild is triggered from inside an in-flight session, which is the common case. Recovery is `packages/agent-backend/src/resume.ts`, which runs at boot over `active-sessions.json`:

- **Tier 1** — replay the in-flight message-queue head.
- **Tier 2** — drop the entry when the assistant turn actually completed before shutdown; invalidate when the backend session file has gone.
- **Tier 3** — synthesize a continuation message, quoting the in-flight prompt. Always-on: the backend's session resume rehydrates a transcript and then waits for input, so a mid-turn session otherwise sits idle forever.
- **tool-await** — a `PreToolUse` hook was holding the backend open (currently `AskUserQuestion`). The backend re-fires the tool on resume, so synthesizing a continuation here would duplicate it. Short-circuit instead.

## Holonic task system (`packages/tasks/`)

Cross-thread task coordination via a holonic DAG, and the backbone of Forge's work graph. Tasks form many-to-many parent/child relationships (a holon acts as both whole and part). A **work stream** is a task flagged `isStream`; its members are its children, and streams nest as trees (one parent stream each; a PR or issue has one owning stream: `ownedByOneStream`). Tasks persist in the `sovereign-forge` AD4M perspective (clean slate: the old `hex-tasks` perspective is neither read nor migrated).

### Architecture

```
TaskGraph (graph.ts) — in-memory graph + TaskOps (task.put, task.update, link.add, link.remove)
       ↓
TaskStore (interface, store.ts)
  ├── createInMemoryTaskStore()   — process lifetime only (tests)
  └── createResilientTaskStore()  — runtime: AD4M + outbox + snapshot (durable.ts)
       ↓
TaskService (business logic)
  ├── CRUD + validation; one task per provider key
  ├── ensureTask(key, init) — idempotent by refKey or "plan:<project>/<path>"
  ├── Work streams (createStream / addToStream / removeFromStream / listStreams)
  ├── DAG link management + BFS cycle detection
  ├── Bus event emission (task.created, task.state_changed, ...)
  └── Operational summary (inFlight / recentlyCompleted / unassigned)
       ↓
TaskDigest (replaces PresenceDigest)
  ├── Listens on task.* bus events
  ├── Formats structured entries (no text extraction)
  └── Sole operational-context source for internal thread
```

`createForgePersistence({ ad4m, dataDir })` (bootstrap.ts) builds the task store and the Forge meta store (saved `ForgeView`s and `RelatedEdge`s, meta.ts) over one perspective. The server wires it in place of the old in-memory store.

**The work graph's one way in: `TaskPort`.** The contract lives in `@sovereign/core` (forge.ts, "Task port"), so tasks implements it without depending on work-graph. `createForgeTaskPort({ service, meta })` (`forge-port.ts`) binds it: task writes go through `TaskService` (sourceThreadId `forge`), so every Forge-driven change emits the `task.*` events the TaskDigest and presence read; views and suggested edges go to the meta store. Provider status maps both ways (`statusOf` / `withStatus`): a field the work graph did not read keeps its stored value. View ids are the client's, stored as `forge-view://<membrane>/<id>` with a `position`, so a membrane's list keeps its order. A task with no membrane joins the one that asks for it (`ensureTask`). `packages/work-graph/src/task-port.contract.test.ts` holds this port to the contract (including a restart through the snapshot), and the work graph's tests run on it (`createTestTaskPort` in `testing.ts`).

### Ontology (`ontology.ts`, namespace `forge://`)

SHACL subject classes, registered when the perspective is first opened (`ad4m-perspective.ts`):

| Class | Subject | Properties |
| --- | --- | --- |
| `Task` | `task://<uuid>`, `rdf://type forge://Task` | name, state, transientState, description, tag (many), createdAt, updatedAt, threadId, membrane, providerKind, providerKey, provider (JSON), subtask (many, IRI) |
| `WorkStream` | a Task that also has `rdf://type forge://WorkStream` | as Task |
| `RelatedEdge` | `forge-edge://<uuid>` | from, to (work-graph node ids), kind (default `related`), accepted, reason, confidence, source (`sync` \| `rethink` \| `user`), membrane, createdAt |
| `ForgeView` | `forge-view://<membrane>/<view id>` | membrane, title, repo (many), filters (JSON), height, position |

Subtasks are one `forge://subtask` link per pair, parent → child. Values are AD4M string literals. The perspective is found by the uuid cached in `<dataDir>/tasks/forge-perspective.json`, else by name, else created.

### Resilience (`durable.ts`)

The AD4M executor is not always up, so every store keeps an in-memory copy:

- **Reads** always come from memory.
- **Writes** apply to memory, append to `<dataDir>/tasks/outbox.jsonl` (write-ahead), then replay to AD4M in order. The outbox is rewritten (tmp + rename) after each replay pass, so a crash mid-replay replays ops AD4M already holds. Every op is idempotent on the perspective (a property write removes that property's links first; a subtask link is removed before it is added), so that never duplicates links.
- **Replay** runs on every write, on AD4M's reconnect signal (`onConnected`), and every 15 s while anything is pending. An op AD4M rejects while it still answers pings is retried, then moved to `outbox.jsonl.dead.jsonl` after 5 attempts.
- **Restart**: the copy loads from `<dataDir>/tasks/snapshot.json` (tmp + fsync + rename, debounced) plus the outbox, then from AD4M once it answers: AD4M is the source of truth, with pending ops applied on top.
- **Seeding**: a snapshot written without AD4M (AD4M not configured) or for another perspective uuid is pushed into the perspective on first connect, so turning AD4M on, or a recreated perspective, loses nothing.
- **Without AD4M configured** the snapshot alone is the store.
- The meta store does the same with `meta-outbox.jsonl` / `meta-snapshot.json`. `GET /api/tasks/store-status` shows both (`backend`, `pending`, `loadedFromBackend`, `lastError`, ...).

### Providers

```
{ kind: 'change', refs: ForgeRef[], url, status, checksStatus, reviewDecision, unresolvedComments, failedChecks?, lastPolledAt }
{ kind: 'issue',  refs: ForgeRef[], url, issueState, closedReason?, unresolvedComments?, lastPolledAt }
{ kind: 'plan',   project, path, status }
```

`refs[0]` is the primary ref; the provider key is `refKey(refs[0])` (`@sovereign/core` forge.ts) or `plan:<project>/<path>`. Only one task may hold a key. The pre-Forge `{ kind: 'github-pr', repo, number, prStatus, ... }` shape converts to `change` wherever it is read (snapshot, outbox, AD4M, API input). The status fields are written by the work graph (see Forge work graph: tracked items); the tasks package polls nothing itself (`pr-poll.ts` is gone).

### Filters

`list` (and `GET /api/tasks`, `task_list`) filters by state, threadId, parentId, rootsOnly, **membrane**, **repo** (`owner/name`, case-insensitive), **workstream** (a stream's id: every task below it, through nested streams), **providerKind** (`change` \| `issue` \| `plan` \| `none`) and isStream. A task's membrane defaults to the creating thread's `membraneId`.

### MCP tools and routes

Sovereign tools: `task_create` (`stream`, `membrane`), `task_update` (a `threadId` on a PR or issue task also sets the forge assignee, and moves a pending task to in progress: the work graph follows the `task.reassigned` event), `task_get`, `task_list` (Forge filters above), `task_link`, `task_unlink`, `task_subscribe`, `task_summary`, `task_import`, `task_send_prompt`. Registered in `packages/agent-backend/src/claude-code/mcp-server.ts` via `TaskMcpDeps`.

`task_import { ref | url | plan, threadId?, parentTaskIds?, tags?, prompt?, membrane? }` replaces `task_import_pr` (`import.ts`). `ref` is a refKey (`github:github.com/owner/name#123`) or `owner/name#123`; `url` a GitHub PR or issue URL; `plan` `{ project, path, name? }`. A refKey does not say PR or issue, so the importer asks GitHub (`gh api repos/<repo>/issues/<n>`, `pull_request` set for PRs) unless the item is already tracked. Imports are idempotent (`created: false` returns the existing task; a task with no membrane takes the importer's); with `threadId` the task is assigned and the thread gets a prompt. A PR's title and state come from `gh pr view`; from then on the work graph reads it (CI, reviews, merge) within a second of the import and at every open poll.

REST: `GET/POST /api/tasks`, `GET/PATCH /api/tasks/:id`, `POST /api/tasks/link`, `POST /api/tasks/unlink`, `GET /api/tasks/streams`, `POST /api/tasks/import`, `GET /api/tasks/store-status`, `POST /api/tasks/:id/poll` (re-reads the task's PR or issue through the work graph). Tasks have no delete; cancel them. Forge views and suggested edges are served by the work graph's routes only (`/api/forge/views`, `/api/forge/edges/...`, membrane-scoped, through the TaskPort).

### Tests

`store.contract.test.ts` runs one contract against the in-memory store, the resilient store without AD4M and the resilient store over a fake perspective (`testing/helpers.ts`: it can go down, hang mid-replay or reject ops). `resilience.test.ts` covers the outbox, ordered replay, crash mid-replay, snapshot restarts, seeding and legacy data; `ad4m-perspective.test.ts` the SDK adapter against a fake client. `ad4m.integration.test.ts` runs against a real executor only with `SOVEREIGN_AD4M_IT=1 SOVEREIGN_AD4M_HOST=… SOVEREIGN_AD4M_TOKEN_FILE=…`; it creates and removes its own `sovereign-forge-it-*` perspective. Wind-tunnel s44 restarts the container and checks the graph (and a membrane's ordered views); with `--ad4m` it also stops the AD4M node mid-run. `forge-port.test.ts` covers the status mapping.

### Task states

`pending` → `in_progress` → `completed` | `cancelled`, plus `paused` (set aside: neither in flight nor unassigned work in `summary()`; a work stream's "paused" epic status). A paused PR or issue task still completes or cancels when its item merges or closes. The task MCP tools take every state (`TASK_STATES`; agent-backend keeps its own copy because it does not depend on `@sovereign/tasks`).

### Digest migration (Wave 4 — complete)

TaskDigest replaced PresenceDigest as the sole operational-context injection. The PresenceDigest's `chat.turn.completed` listener gets disposed at bootstrap. WatchStore and its MCP tools (`presence_watch`, `presence_unwatch`, `presence_watched`) have been fully removed.

Task events never wake the internal thread on their own: TaskDigest entries ride along with its next external trigger. A wake per `task.state_changed` / `task.created` (removed 2026-10-17) turned every Forge sync into an internal turn that told the user nothing; owner threads get Forge's notices, and Forge rethink posts the one "needs your attention" list.

## Presence system

Two long-lived threads form the presence system (`packages/presence/`). They pair but stay independent — each has its own session, history, and context window. They communicate via explicit tool calls, not by sharing context.

### Thread roles

- **`presence`** (`ThreadInfo.presence = 'gateway'`) — the user's primary interface. Voice input, text conversations, and direct work happen here (or in subagents spawned from here). A normal Claude Code thread. Carries only PRESENCE_KNOWLEDGE.md in its session prompt.
- **`presence-internal`** (`ThreadInfo.presence = 'internal'`) — the agent's peripheral awareness. Processes **external and ambient signals only**: AD4M mentions, webhook events, task digests, and context forwarded from the gateway. The agent speaks externally only via `presence_reply_*` tool calls; silence counts as valid. Carries PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md in its session prompt.

The internal thread does NOT handle direct work. It observes the periphery — things that happen outside Sovereign (external integrations) and task activity across other threads (task digest). It surfaces noteworthy items to the gateway via `presence_reply_text`.

### Prompt layers

`makePresenceAwareAppendResolver` in `packages/agent-backend/src/wiring.ts` controls injection. The internal thread receives personality + memory + knowledge; the gateway thread receives knowledge only; all other threads receive nothing from the presence layer.

### Knowledge graph (AD4M perspective)

Both presence threads maintain a shared knowledge graph in a private AD4M perspective named `hex-knowledge`. The schema, tools, and patterns live in `PRESENCE_KNOWLEDGE.md` (injected into both sessions). Two subject classes:

- **Entity** (`hex://Entity`) — durable nodes (person, project, concept, system)
- **Note** (`hex://Note`) — timestamped knowledge units (observation, decision, fact, preference, insight)

Relationships between entities use raw AD4M links under `hex://` predicates. The agent bootstraps the perspective + models on first session activation via `mcp__ad4m__*` tools.

### In the UI: one thread among many

The client shows the gateway thread in the workspace like any other thread; it has no tab of its own. The ⬡ agent view holds only Overview, Forest, Tasks and System, and switching between the two views never changes the open thread. Quick settings (theme, notifications) live in the header's status-dot popover, above Service Health. The device name lives at the top of System → Devices, which the app opens on a first launch without a device name. A legacy `?view=agent` URL with no `tab` (or `tab=hex`) opens the workspace on the gateway thread.

Every open workspace thread gets the header's TTS toggle and simple-conversation toggle. The simple conversation (`packages/presence/src/simple-conversation.ts`) is kept per thread in `presence/simple-conversation/<threadId>.json`; the single-file gateway log of older builds (`presence/simple-conversation.json`) moves into the gateway thread's file on first use. `GET /api/threads/:id/simple-conversation` returns a thread's entries; the client calls it only while the simple view shows. A thread's first call backfills it from history (envelope turns skipped, duplicates of live entries dropped). Each call stamps the thread in `simple-conversation-watched.json`, and for the next 24 h its assistant turns get an LLM summary instead of a truncated first paragraph; the gateway thread always does. `presence.reply` carries a `threadId`; one without it belongs to the gateway thread.

## Tests

`pnpm test` runs `vitest run` at the repo root — the real gate. The root `vitest.config.ts` collects `packages/*/src/**/*.test.ts`. A package without its own vitest config runs its tests through that root config (`"test": "vitest run --root ../.. packages/<pkg>/"`), so `pnpm --filter <pkg> test` runs exactly that package's tests. A new package needs the same script — a bare `vitest run` from the package directory matches no files.

### Rebuild dist after touching a shared package's runtime code

Workspace packages resolve each other through the `exports` map (`types`/`development` conditions point at `src/*.ts`; `default` points at `dist/*.js`). Vitest's default resolution picks the `default` condition, so a change to a runtime function in one package (e.g. `@sovereign/core`, `@sovereign/primitives`, `@sovereign/chat`) stays invisible to any other package's tests until that package's `dist/` gets rebuilt (`cd packages/<name> && npx tsdown`). `tsc --noEmit` never catches this gap — it type-checks against `src/` regardless of the `exports` condition. Symptom: a test asserting the new behavior fails, returning the old output, even though the source edit looks correct. Type-only edits (new interface fields, etc.) need no rebuild; only edits to functions/values that cross a package boundary at runtime do.

### solid-js resolves to its SSR build under vitest — `createEffect` never fires

`vitest.config.ts` sets no `test.environment` (defaults to Node) and adds no resolve conditions, so Node's built-in `"node"` export condition wins solid-js's `package.json` `exports` map — every test import of `solid-js` resolves to `dist/server.js` (the SSR build), never the reactive client build (`dist/dev.js`/`dist/solid.js`), regardless of `NODE_ENV`. That build keeps `createSignal`/`createRoot` working normally, but `createEffect` callbacks never run — not on creation, not on a tracked signal write. Any store using `initPresence`'s pattern (`createEffect(() => { const key = threadKey(); ... })`) consequently resists direct testing as written; this went uncaught because no existing test exercises `initPresence` or any other `createEffect`-based store directly. Two ways around it, depending on what the store needs:

- Prefer a plain polled watcher (`setInterval` comparing the accessor's current value against a `lastSeen` local) over `createEffect` for App-level "react to signal X with an async side effect" stores. This keeps the store a plain function, testable with real timers/`vi.useFakeTimers()`, with no dependency on which solid-js build the resolver picks. See `packages/client/src/features/chat/summary-store.ts`.
- A store that genuinely needs `createEffect` still won't run its callback body inside a vitest run — treat that code as covered only by manual/browser verification, never by unit assertions.

This artifact belongs to test resolution only — the client's real Vite/browser build always resolves the proper reactive build, so production behavior stays unaffected.

## Wind tunnel (`wind-tunnel/`)

End-to-end regression tests against a Dockerised Sovereign instance with a mock Anthropic API. Scenarios (`wind-tunnel/src/scenarios/`) cover thread CRUD, chat roundtrip (full SDK → mock LLM → WS response), presence threads, thread-to-thread forwarding, scheduler jobs, WebSocket event propagation, config/membranes, context management, backend mixing, and LLM benchmarking.

### Isolation (HARD RULE — NON-NEGOTIABLE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists — it was removed. The runner hard-refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must NEVER interact with the live production Sovereign instance. This rule applies to all agents, all sessions, no exceptions.

### Quick start

```bash
# Builds images, runs scenarios, tears down
./wind-tunnel/run.sh

# Single scenario
./wind-tunnel/run.sh --scenario s3

# LLM benchmark (prompt via env, runs against mock in Docker)
SWT_BENCHMARK_PROMPT="your prompt" ./wind-tunnel/run.sh --scenario s18
```

To judge a dependency or refactor, run the suite on the change **and** on its parent commit (a `git worktree add --detach` checkout; fill the ad4m submodule with `git submodule update --init --reference <main checkout>/vendor/coasys/ad4m vendor/coasys/ad4m`). Only a failure absent from the parent counts as a regression. Remove the worktree with `git worktree remove --force` (submodules block a plain remove). `--no-build` reuses whichever checkout built the image last, so rebuild before trusting it.

### Writing scenarios — traps

- **Wait on the thread, not the stream.** Use `waitForThreadIdle(client, threadId, ms)` from `src/wait.ts`. An unfiltered `chat.status` wait ends on any thread's idle. Filter `chat.turn` waits on `threadId` and `turn.role` as well: a sent message's own user turn arrives first. Chat announces one idle per quiet spell, whichever order the backend uses — Claude Code idles just before its final assistant turn, the local LLM just after (`idleAnnounced` in `chat.ts`). A second idle for the same turn would end the next turn's wait at once. The mock LLM only produces the local-LLM order, so a unit test in `chat.test.ts` covers the Claude Code order.
- **The mock resets before every scenario** (`POST /mock/reset`: scripts, log, canned transcript). Sovereign-side state (threads, voice devices, config) still carries over, so a scenario must clean up what it creates.
- **`mockLlmUrl` holds the runner's host-side address.** Never hand it to Sovereign: the container reaches the mock at `http://mock-llm:8900`, set in `docker/config.json`.
- **WS delivery:** a message consumed by a live `waitForWs` never enters the buffer, and `waitForWs('')` matches any type, buffered or live.
- **Token counts drive local-llm compaction.** The backend trusts server-reported `prompt_tokens` (streamed when `stream_options.include_usage` is set, as with llama.cpp). The mock reports about chars/4 of each request. Compaction also needs more than 12 messages, because the backend always keeps the last 10 verbatim, so fill with many rounds, not a few huge ones.
- **History versus model context.** `threadHistory` (`GET /api/threads/:id/history`) returns the original conversation, which compaction never alters. Compaction summaries live only in the model-context view: `fullHistory` (WS `chat.history.full`, backed by `getFullHistory`).
- **The build context mirrors a fresh checkout** (`.dockerignore`): host `node_modules`, `dist`, and `services/` (Python virtualenvs and training data, tens of GB) stay out.
- **Skips:** s10 (ad4m lane inactive), s18 (`SWT_BENCHMARK_PROMPT` unset), and s31 (local-llm threads have no `agents_spawn`) report a pass while skipping.

### Architecture

- **Mock LLM** (`wind-tunnel/mock-llm/server.ts`) — implements Anthropic `/v1/messages` (SSE streaming) with scripted response support via `POST /mock/script`.
- **Test client** (`wind-tunnel/src/client.ts`) — HTTP + WebSocket client with `timed()` latency sampling. Unwraps Sovereign's response wrappers (`{ threads: [...] }`, `{ thread: {...} }`, etc.).
- **Mock GitHub** (`wind-tunnel/mock-github/`, container `mock-github`, host port 8910, `ctx.mockGithubUrl`) — see below.
- **Scenarios** (`wind-tunnel/src/scenarios/`) — TypeScript modules implementing the `Scenario` interface.

### Mock GitHub (`wind-tunnel/mock-github/`)

Answers what the forge adapter (`packages/forges`) sends, from an in-memory model (`model.ts`) that scenarios seed and mutate. The runner resets it before every scenario, like the mock LLM.

- **GraphQL** `POST /graphql` (or `/api/graphql`), dispatched by operation name: `ForgeChanges`, `ForgeIssues`, `ForgeBranches`, and the single reads `ForgeChange` / `ForgeIssue` (by `number`) (the queries in `packages/forges/src/queries.ts` — rename one and the mock answers with an error). Ordered by `updatedAt` desc, `first` ≤ 100, cursors, `states`, issue `since`. A missing repo, PR or issue answers `NOT_FOUND`, as GitHub does.
- **REST**: `GET /user`, `GET /repos/:o/:r/pulls/:n`, `…/commits/:ref`, `…/commits/:sha/check-runs`, `…/commits/:sha/status`, `…/compare/:base...:head`, `…/issues/:n/comments`, `…/pulls/:n/comments` (`per_page`/`page` + `Link`), `POST`/`DELETE …/issues/:n/assignees`. GETs carry an ETag and answer 304 to a matching `If-None-Match`. Every API call needs an `Authorization` header (any token).
- **Derived like GitHub:** "#N", "owner/repo#N" and issue/PR URLs in a body cross-reference their target (timeline items); "Closes/Fixes/Resolves #N" fills `closingIssuesReferences`; the check rollup comes from the head commit's runs and statuses; merging into the default branch closes those issues as completed; a review clears the reviewer's request. A check result does not move a PR's `updatedAt` (GitHub's behaviour too), so a since-sync alone misses CI changes.
- **Timestamps:** each mutation stamps a time strictly after the last one, so order is stable; seeds may set `createdAt`/`updatedAt`/`closedAt`/`mergedAt` explicitly (past dates make `since` cuts deterministic).

Control API (JSON bodies; every write returns the changed object):

| Route | Body | Does |
| --- | --- | --- |
| `POST /mock/github/reset` | — | Empty model, viewer `hex-agent`, clears the log and queued failures |
| `POST /mock/github/seed` | `{ viewer?, repos: [{ repo, defaultBranch?, branches?, issues?, pulls?, checks? }] }` | Replaces those repos whole (issues are added before PRs, so PR bodies cross-link them) |
| `POST /mock/github/repo` | `{ repo, defaultBranch? }` | Ensure an empty repo |
| `POST /mock/github/pr` | `{ repo, number?, title?, body?, state?, isDraft?, author?, assignees?, reviewRequests?, reviews?, labels?, head?, headSha?, base?, headRepo?, mergeable?, closes?, …times }` | Create (next number) or update a PR; bumps `updatedAt`. A new head branch is created |
| `POST /mock/github/issue` | `{ repo, number?, title?, body?, state?, stateReason?, author?, assignees?, labels?, …times }` | Create or update an issue |
| `POST /mock/github/review` | `{ repo, number, login, state }` | `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`/`DISMISSED`, or `REQUESTED` to request one |
| `POST /mock/github/checks` | `{ repo, sha \| branch \| pr, runs?, statuses?, append? }` | Set check runs (`{ name, status, conclusion }`) and statuses (`{ context, state }`) on a commit |
| `POST /mock/github/merge` | `{ repo, number, deleteBranch? }` | Merge an open PR |
| `POST /mock/github/comment` | `{ repo, number, login?, body, review? }` | Issue comment, or a PR review comment with `review: true` |
| `POST /mock/github/branch` | `{ repo, name, sha?, ahead?, behind?, delete? }` | Upsert or delete a branch; ahead/behind are against the default branch (what `compare` returns) |
| `POST /mock/github/assign` | `{ repo, number, add?, remove? }` | Change assignees as someone else on GitHub would |
| `POST /mock/github/fail` | `{ status, count?, path?, method?, retryAfter?, message? }` | The next `count` matching API requests (path prefix) fail with `status`; 403/429 default to a secondary-rate-limit message |
| `GET /mock/github/log` | — | Every API request: method, path + query, status, GraphQL operation and variables |
| `GET /mock/github/state` | — | The whole model |

s43 drives the adapter from the runner against this container: mapping, paging and `since`, assignee writes, ETag 304s, retries over injected 502s and a `Retry-After`, merge → issue closed. s45 and s46 drive the server's `/api/forge*` routes against it (see Forge work graph).

### API response shapes (gotcha)

Sovereign wraps most REST responses. The wind tunnel client unwraps them:

| Endpoint               | Wire shape                         | Client method returns |
| ---------------------- | ---------------------------------- | --------------------- |
| `GET /api/threads`     | `{ threads: [...] }`               | `any[]`               |
| `POST /api/threads`    | `{ thread: {...} }`                | `any` (thread object) |
| `GET /api/threads/:id` | `{ thread: {...}, events: [...] }` | `any` (thread object) |
| `GET /api/crons`       | `{ crons: [...] }`                 | `any[]`               |
| `GET /api/membranes`   | `{ membranes: [...] }`             | `any[]`               |
| `GET /api/jobs`        | `[...]`                            | `any[]` (bare array)  |

Thread deletion sets `archived: true` (soft delete). `listThreads()` passes `?active=true` by default to exclude archived threads.

### Docker config

Sovereign runs on port 5801 inside Docker, exposed as 5811 on the host (avoids conflict with the live service). TLS disabled. Personality off. `ANTHROPIC_BASE_URL` points at the mock LLM container.

## LiteLLM proxy (local inference routing)

`services/litellm/` contains the LiteLLM proxy that routes non-Claude model sessions to local inference backends.

### How it works

Sovereign's claude-code backend detects non-Claude models via `familyForModel()`. When a session uses an unrecognised model (e.g. `qwen3.8-27b`), it sets `ANTHROPIC_BASE_URL=http://localhost:4000` and `ANTHROPIC_API_KEY=litellm` in the Claude Code CLI subprocess env. The Claude Code CLI then sends all Anthropic SDK calls to LiteLLM at `:4000` instead of `api.anthropic.com`. Claude sessions bypass the proxy entirely.

### Session handling for LiteLLM threads

Non-Claude threads always start a **fresh session** (`--session-id`) regardless of existing JSONL files. The SDK ignores `env` when resuming a subprocess — a fresh subprocess is required to pick up the `ANTHROPIC_BASE_URL` env injection. History is preserved via the shared history-log system.

`effort` (extended thinking budget) is set to `undefined` for non-Claude sessions — local models do not accept Anthropic thinking parameters.

### LiteLLM config (`services/litellm/litellm.yaml`)

Critical settings:

- `use_chat_completions_url_for_anthropic_messages: true` — forces chat/completions routing for all providers including `openai/*`. Without this, LiteLLM routes `openai/*` models (like `openai/qwen3.8-27b`) through the Responses API, which translates `thinking.budget_tokens` → `reasoning_effort: "high"`. llama-server's Jinja template only accepts `xhigh`/`medium`/`low` → 500 error.
- `drop_params: true` — drops unsupported Anthropic-specific params cleanly.
- `model_info.supports_extended_thinking: false` — signals the model does not support extended thinking.

### Service setup (on the Sovereign host)

```bash
# Start the proxy
systemctl --user start litellm
# or manually:
litellm --config services/litellm/litellm.yaml --port 4000 --host 127.0.0.1

# Verify routing
curl -s -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: litellm" \
  -d '{"model":"qwen3.8-27b","max_tokens":50,"messages":[{"role":"user","content":"Say: LITELLM_WORKS"}]}'
```

### Known gotcha — mid-turn system message injection (patched in LiteLLM)

**Symptom:** `POST /v1/messages?beta=true` → 500 "Jinja Exception: System message must be at the beginning." on every request from a qwen/LiteLLM session.

**Root cause:** Claude Code CLI injects MCP Server Instructions as a `{"role": "system"}` entry within the Anthropic `messages` array on every API call (not just the first). LiteLLM's `translate_anthropic_messages_to_openai` appended this at its original position via `_translate_midturn_system_message_to_openai`. After `_add_system_message_to_messages` placed the main system prompt at position 0, the resulting OpenAI-format message array had structure `[system, user, system]`. llama-server's Jinja template rejects any system message after position 0.

**Fix — LiteLLM patch (applied to installed package):**

File: `$UV_TOOLS_DIR/litellm/lib/python3.12/site-packages/litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py`

In `translate_anthropic_to_openai`, after the call to `_add_system_message_to_messages` (around line 1090), insert:

```python
## CONSOLIDATE SYSTEM MESSAGES
# Some SDK clients (e.g. Claude Code CLI) inject mid-turn system messages
# within the messages array (e.g. MCP server instructions, system-reminders).
# OpenAI-compat backends that use Jinja chat templates (llama-server) require
# ALL system content to appear in a single message at position 0 — a system
# message at any later index raises "System message must be at the beginning."
# Fix: collect all system messages, merge their content into the leading system
# entry, and remove the duplicates from the sequence.
system_msgs = [m for m in new_messages if isinstance(m, dict) and m.get("role") == "system"]
if len(system_msgs) > 1:
    non_system_msgs = [m for m in new_messages if not (isinstance(m, dict) and m.get("role") == "system")]
    merged_content: list = []
    for sm in system_msgs:
        content = sm.get("content", "")
        if isinstance(content, str):
            merged_content.append({"type": "text", "text": content})
        elif isinstance(content, list):
            merged_content.extend(content)
    new_messages = [{"role": "system", "content": merged_content}] + non_system_msgs
```

**⚠️ Upgrade warning:** Running `uv tool upgrade litellm` overwrites the patch. Re-apply after every upgrade:

```bash
python3 services/litellm/patch-litellm.py          # apply (idempotent)
python3 services/litellm/patch-litellm.py --check  # verify
systemctl --user restart litellm
```

The fix lives on the fork at [HexaField/litellm — fix/consolidate-mid-turn-system-messages](https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages). The patch script (`services/litellm/patch-litellm.py`) applies the same fix idempotently to the installed package regardless of version.

## Post-rebuild session-conflict recovery

After a Sovereign rebuild, old Claude CLI subprocesses survive as orphans (reparented to init) and continue holding their session IDs. When the new Sovereign tries to resume the same session, the CLI reports "Session ID already in use" on stderr and exits with code 1. Before dfedbef this caused `initializationResult` to reject before `setMcpServers` ran, leaving MCP tools uninitialised for the session.

**Fix (dfedbef):** The `stderr` callback now sets a `sessionConflict` flag on that message. `initializationResult.catch` scans `/proc` for a subprocess holding the session ID and sends SIGTERM. The `iteratorDone` catch suppresses the generic `chat.error` emission. The session resets to idle; the next `sendMessage` retries cleanly after the orphan exits.

**Betas removed:** The `context-1m-2025-08-07` beta was previously passed for sessions with context windows > 200 k, but Sovereign uses Claude.ai OAuth exclusively, which does not support custom betas. The CLI ignored it and logged a warning on every session start. betas is now always empty.

## One session per thread: MCP `sessions_*` resolve to the bare thread id

A thread's session key is its bare id: the chat module and the UI use it. `resolveSessionKey` in `agent-backend/src/mcp-deps.ts` (behind `sessions_send` / `sessions_history`) maps a bare id, a legacy `agent:main:thread:<id>` key, or a registry record naming either form to that bare id. Only a registry record naming a different key (local-llm) wins. Before this, a bare id with no registry record fell back to the legacy prefixed key. For a new thread the backend then started a second session the UI never shows. A later send by the bare id reached the visible session, and two agents worked the same task. Tests: `mcp-deps.test.ts` (`sessions.send`).

`GET /api/threads/:key/session-info` reports the backend's default model (`listAvailableModels().defaultModel`, from `agentBackend.claudeCode.defaultModel`) when the thread has no session yet. The old `model: null` left the settings panel showing the first family in its catalog (Fable). The context window needs no setting: a Claude session uses the model's native window (`contextWindowFor`: 1M for Opus 5.5).

## POST /api/threads model field (7314d20)

`POST /api/threads` previously ignored the `model` field in the request body. Any thread created with an explicit model (e.g. `model: "qwen3.8-27b"`) silently fell through to `DEFAULT_MODEL_FALLBACK` ("claude-opus-4-6"), making LiteLLM routing untestable via the REST API.

**Fix:** Three-part change in `packages/threads/src/`:

- `threads.ts create()` — added `model?: string` to opts and included it in the constructed `ThreadInfo`.
- `threads.ts projectToV2()` — added `model` to the schema-load whitelist so the field survives a restart.
- `routes.ts POST /api/threads` — extracts `model` from `req.body`, normalises it (strips a `provider/` prefix if present), passes the bare id to `threadManager.create()` and to `createSession()` as `{ provider: 'anthropic', model: bareId }`.

The `PATCH /api/threads/:key/model` route and `update()` were already correct — only `create()` and the POST route needed fixing.

## Claude Agent SDK + model catalog

- **Default model precedence.** A session's model resolves as: explicit thread/session model → `agentBackend.claudeCode.defaultModel` in `config.json` → `DEFAULT_MODEL_FALLBACK` in `claude-code.ts`. An install whose `config.json` sets `defaultModel` ignores a changed code default. Change the live value through `PATCH /api/config`: the store deep-merges, validates, persists, and the next new session reads it with no restart. A hand edit to `config.json` takes effect only after a restart. Existing sessions keep the model persisted in their state file.
- **Adding a model id.** Before listing an id in `MODEL_CATALOG`, run the platform binary shipped in `@anthropic-ai/claude-agent-sdk-<platform>` (under `node_modules/.pnpm/`) with `--model <id> -p "Reply with one word: ok"`. Id shapes vary by generation, so never extrapolate one. A new family name also needs adding to the `familyForModel` prefix regex.
- **`@anthropic-ai/sdk` rides as a peer.** Bumping `@anthropic-ai/claude-agent-sdk` leaves `@anthropic-ai/sdk` on any version that satisfies the peer range. Model access does not depend on it: the SDK spawns a native `claude` binary with its own API client.
- **Built-in task tools on newer models.** From SDK 0.3.268, `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` load by default only on models older than Opus 4.8. Sessions on newer models lose them unless listed explicitly. Sovereign's `mcp__sovereign__task_*` tools cover task tracking, and the client never renders the SDK task tools.
- **Moving existing threads to a new model.** A session freezes its model at creation, so a new default reaches only new threads. Move the others one by one with `PATCH /api/threads/:key/model` (body `{"model": "anthropic/<id>"}`). It updates the thread and its live session, and it persists the session state that `rehydrate()` reads on restart.
- **MCP servers every session gets** (`claude-code/config.ts`): `ad4m` (HTTP, when a token exists), `semble` and `codegraph` (stdio, each with an `<NAME>_MCP=off` opt-out and an `<NAME>_MCP_CMD` launch override that allows quoted arguments), `code` (stdio, Sovereign's own symbol editor — see Code edit below; `CODE_EDIT_MCP=off` opts out), plus `sovereign` (HTTP) added per session in `claude-code.ts`.
- **Subagents: `agents_spawn` (Sovereign's runner).** `spawnSubagent` (claude-code backend) starts the child as its own Claude Code session (own CLI process) in the `cwd` the parent passes, keyed by a fresh UUID with `parentSessionKey` set. Any session with a parent gets the slim context in `startSessionLoop`: the raw system prompt is `<configDir>/SUBAGENT.md` + the nearest repo `AGENTS.md`/`CLAUDE.md` + an environment block (`subagent-runner.ts`); no `claude_code` preset, no global CLAUDE.md, no membrane, `settingSources: ['local']`, `tools` = Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch (no Agent, so no nesting; the web tools serve research children). MCP: `codegraph`, `semble` (merged from `~/.claude.json`, which `'local'` skips), `code`, and the narrow `/api/mcp/subagent` endpoint. The call returns at once; when the child's turn ends (its `result`, not the Stop hook's earlier idle; or its CLI exits), `finishRun` emits `subagent.completed`/`subagent.failed` with `parentMessage`, and `wiring.ts` delivers it into the parent thread through the cron path (`handleSend`, system card, queued while busy). Limits: 4 running per parent; the timeout is config `agentBackend.subagentDefaults.timeoutMinutes`, else 4 h (`SUBAGENT_TIMEOUT_MS`); `agents_stop` ends a run. `agentBackend.subagentDefaults` (backend, model, timeoutMinutes) is read from the config store at each spawn, so a change applies to the next subagent without a restart; stop and timeout abort the child's CLI rather than interrupt it. An error result fails the run even after some text. A run cut off by a restart (`run` persists in the session state store) sends a failure message after rehydrate; children stay out of `active-sessions.json`, so the resume orchestrator never continues one. Local-LLM threads have no `agents_spawn`.
- **Subagent cards.** The parent message format lives in `@sovereign/core/subagent-result` (`formatSubagentResult` / `parseSubagentResult`). History turns get `kind.variant: 'subagent-result'` from `classify.ts`; the live turn the chat module synthesizes stays raw, so the client's `subagentResultOf` handles both and `ChatView` renders `SubagentResultCard` (status, minutes, report as markdown, "Open session"). The `agents_spawn` tool call itself renders the live `SubagentCard` (`extractSubagentSpawns` reads the MCP `[{ type: 'text' }]` result).
- **Built-in `Agent` tool: blocked.** Top-level claude-code sessions get `disallowedTools: ['Agent', 'Task']` (`MAIN_DISALLOWED_TOOLS`), so all delegation goes through `agents_spawn` (decided after the 12–19 Oct trial). Skills whose coordinator calls `Agent` (e.g. deep-research) need porting to `agents_spawn`. `findUnreachableAgentModels` still warns at startup about `~/.claude/agents/*.md` definitions naming a non-Claude model. Sovereign seeds no agent definition.

## Agents never add remotes or publish

`publish-guard.ts` (agent-backend) is a hard block in both backends: the Claude Code `PreToolUse` hook denies the Bash call, and the local-llm Bash tool returns the denial as its error. It refuses `git remote add|set-url|rename`, `git config` writes of `remote.*.url` / `url.*.insteadOf`, `git push` to a URL or path instead of an existing remote, `git subtree push`, `gh repo create|fork`, and `rad auth|init|publish|seed|push`, `rad node start`, `rad remote add`. Pushing a branch to a remote the repo already has stays allowed. Local repos stay local; the user adds remotes and publishes by hand. Forge rethink bug drafts take only forge items as evidence, never plans or tasks (local files), so an approved draft cannot carry private plan text to a public issue.

## Edits go through the edit tools, not the shell

Shell edits (sed -i, heredoc rewrites, Python read-modify-write) fail silently and skip the diff review, so Sovereign removes the push toward them and gives the batch power to the tools (`replace_all`, `edit_files`, see Code edit):

- **No bash-first steer.** In bypass and auto permission modes the bundled Claude CLI adds a reminder telling the model to edit files with sed, heredocs or scripts. Every session's `env` sets `BASH_FIRST_OFF_ENV` (`CLAUDE_CODE_THRIFTY_SONIC=0`, an internal CLI flag) in `claude-code.ts`. `bash-first-steer.test.ts` runs the real CLI against a stub API and fails if an SDK upgrade renames the flag; wind-tunnel s36 forces the flag on in the container and checks the override wins.
- **No hard block (yet).** `shell-edit-guard.ts` parses a Bash command and names any shell file edit in it (`sed`/`perl`/`ruby -i`, `awk -i inplace`, `cat`/`echo`/`printf`/`tee` authoring, scripts that write files; `/tmp` and `mktemp` targets are scratch). It is **not wired in**: a deny hook proved too blunt, since shell edits are sometimes warranted. It stays as the candidate first layer of a future decision gate (rules, then possibly a Jev-like decision model). Until then, watch the tool-usage metrics to see whether the steer removal and the batch tools are enough.

## Turns cut short ("[Request interrupted by user]")

Two server mechanisms interrupt a Claude Code turn; the transcript shows the same marker as a user Stop.

- **Stuck-status watchdog** (`packages/chat/src/chat.ts`). It aborts a thread that stays non-idle with **no backend events** for 30 minutes (`lastActivityAt`; subagent lifecycle events count through `parentKey`). It measures silence, not turn age. A foreground subagent's own messages never reach the parent's stream, so the backend's `PreToolUse` hook re-emits the parent's busy `chat.status` (at most once a minute) whenever a subagent calls a tool.
- **Context recycle** (`claude-code.ts`: `recycleSession` → `recycleNow`). A recycle interrupts the live query, prunes the JSONL and resumes. `maybeAutoRecycle` only sets `recycleDue` after a turn's `result`; `sendMessage` runs the recycle before pushing the next message. A `result` marks a session idle even when the SDK already holds the next queued message, so recycling at `result` time cut that turn off.
  - The automatic recycle and the scheduled size sweep (`force`) skip a busy session: not idle, or background tasks reported by the last Stop (`backgroundTaskCount`). Only a user-requested recycle may cut a turn short.
  - The automatic recycle emits no `chat.status`, and the session loop suppresses its teardown idle while a recycle runs (`recycleDone`): the chat layer takes an idle as the end of the message being sent and would release its queue gate early.
  - A send waits for a recycle in progress (`recycleDone`), so no turn starts on a transcript being pruned.
  - A recycle of an idle session ends the query's input instead of calling `interrupt()`: with no turn to interrupt, the iterator stays open until the 10 s timeout, which would hold the next message.
  - **Recycle gate** (`recycle-gate.ts`). Pruning frees only old tool output and thinking, so a session made of real conversation stays over the threshold after a recycle. Before the gate, such a session recycled before every message: an interrupt, a full archive and a cozempic pass, for about 2 %. Two persisted fields now stop that. `recycleFloor` makes the next auto-recycle wait until the context grows `regrowPercent` of the window (10) past what the last recycle left. `recycleExhausted`, set when a recycle frees under `minReclaimPercent` (5) of the context, turns auto-recycle off until Claude Code's own compaction runs. `PostCompact` clears both. Both fields survive a restart; the cooldown's timestamp alone did not stop the loop. The wind tunnel's base config sets both to 0 so s12, s16 and s30 still recycle freely; s41 turns the gate on and checks one recycle across five full-context turns.
- **Scheduled cleanup sweep.** A cron job that has never run counts from its `createdAt` (`scheduler.ts` tick). Before, `isDue` measured from 1970, so the cleanup job, re-created on every boot, force-recycled every session over the size limit right after each restart.
- **Wind tunnel s16** reproduces the race: it sends on idle (before turn 1's `result`) with the mock holding the reply 4 s. The parent code kills that turn; the scenario passes only when it completes and the recycle runs before the following message.
- **Thread context window.** `POST`/`PATCH /api/threads` pass `contextWindow` to the session (`applyContextWindow`), also before the first message. Before, it reached the session only with an explicit `backend` on create or via `PATCH …/context-window`.
- **Context window default.** With no per-thread or configured window, `contextWindowFor` uses the model's native window: 1M from Opus/Sonnet 4.6 on and for any `[1m]` id, 200K for Haiku, older models and non-Claude models. The old flat 200K default made 1M sessions look several times full and recycle on every cooldown.

## PDF export (`packages/server/src/routes/export-pdf.ts`)

`POST /api/export/pdf` takes `{ markdown }`, renders it with `marked` and prints it through `BrowserService.printPdf`: a fresh headless Chrome per call, JavaScript off, every request except `data:` URLs blocked, so remote images in a message never load. No Chrome → 503 (`BrowserUnavailableError`). The chat's thread and message export menus call it (`packages/client/src/features/chat/export.ts`).

## Dictation: the draft bubble

While speech-to-text streams, the transcript shows in the thread as an outlined user bubble with a recording dot (`chat/VoiceDraftBubble.tsx`), not in the input bar, so the chat area is room to read it. `InputArea` publishes the draft through `chat/voice-draft-store.ts`; `ChatView` renders it for its own thread and routes edits back. Tap the bubble to pause the mic and edit in place; blur resumes; Enter sends.

- **Dictation state is module-level** in `InputArea.tsx` (`editingTranscript`, `voiceUsedForMessage`): a phone mounts two input areas and two chat views (a hidden desktop panel behind the full-screen chat). Per-instance state let the hidden one enter edit mode while the visible one, which owns the mic, overwrote the edit. Only the visible bubble's editor takes focus.
- **A resume starts a new segment after the current text** (`voice/streaming.ts`), so edits made while paused stay. A paused segment's final transcript that lands after the resume is dropped (`owedFinals`); one that lands while the user edits is ignored by `InputArea`.
- **Server path:** wind-tunnel s38 drives `voice-stream.start/chunk/stop` against the mock `/transcribe` and checks the interim and final transcripts.

## TTS services

`voice.ttsUrl` points at one HTTP service with a fixed API: `POST /synthesize` `{text}` → WAV, `POST /synthesize/stream` `{text}` → NDJSON audio chunks in play order (`index`, `total`, `sentence` = text to show, `audio` = base64 WAV, `durationMs`, `rtf`, `done`; f5-tts sends one per sentence, qwen-tts one per pause), `GET /health`. Any engine that serves this API can be swapped in by changing `voice.ttsUrl` alone.

- `services/f5-tts/`: F5-TTS on PyTorch ROCm (flow matching, voice clone; weights CC-BY-NC).
- `services/qwen-tts/`: an adapter in front of [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)'s `tts-server` (Qwen3-TTS 1.7B Base, GGML on Vulkan; code MIT, weights Apache-2.0). The adapter registers one cloned voice (`QWEN_TTS_REF_AUDIO` + `QWEN_TTS_REF_TEXT`) and re-registers it if the engine restarts. Unit templates in `systemd/`.
- **Stream a whole reply as one engine request.** One request per sentence let every sentence pick its own tone (speaker similarity between sentences 0.63 per sentence vs 0.79 in one request; brightness spread 1,140 vs 230 Hz). qwen-tts sends the text once in `pcm` mode and cuts the stream at pauses (first chunk 0.6–2 s, then 2–6 s), so speech still starts in about 1 s.
- **qwentts.cpp ignores `seed` while sampling:** the same text twice gives different audio unless both `temperature` and `subtalker_temperature` are 0 (greedy is repeatable).
- **The reference transcript must match the clip exactly.** In-context cloning (both engines) aligns the transcript to the audio; words that are not in the clip degrade every reply.
- **On AMD iGPUs, prefer GGML/Vulkan over PyTorch ROCm for autoregressive TTS.** PyTorch ROCm recompiles kernels for each new sequence length and launches small kernels slowly (Qwen3-TTS: RTF 1.7–22 on PyTorch, 0.25 on qwentts.cpp Vulkan).

## Voice replies: one speaker per device name

TTS routes by device **name** (announced with `ws.device-name`), because a page refresh mints a fresh connection deviceId. Several connections share a name on one machine: browser tabs, plus a voice node or the Android app. `wsHandler.sendSpeechToDeviceName` gives the audio to **one** of them and the reply without `audio` to the rest, so their UI still updates:

1. the first live entry of `prefer`: the connection that spoke the reply's previous chunk, then the one the voice request came from (`origin.deviceId`);
2. a voice client: `client: 'voice-node'` in `ws.device-name`, or a non-browser User-Agent on the upgrade request;
3. the browser tab the user touched last (`ws.active`: the client sends it on focus, on input, throttled to 5 s, and on reconnect — only once the page has had a user gesture, since autoplay keeps audio suspended before that, and never while disconnected);
4. the newest connection.

`voice-response.ts` pins a reply's later chunks to the connection that spoke the chunk before, and forgets the pin when the reply ends, so a reply never splits across tabs and an old reply never claims a new one. With nothing connected under the name, the push fallback sends the text once per reply. The server decides this because a client-side race cannot: Chrome throttles background-tab timers to the same one-second tick, so hidden tabs that raced over a BroadcastChannel all woke together and all played. Wind-tunnel s37 covers it.

## Voice replies: the speech queue

Two replies can stream at once (two threads finish together), and their chunks interleave on the wire. `speak()` tags every `voice.tts.audio` with an `utterance` id: one per reply, shared by all its chunks. Every player runs the same queue — web `client/src/features/voice/tts-queue.ts`, voice node `services/voice-node/tts_queue.py`, Android `SpeechQueue.kt` — with the same rules:

- Whole replies play one after another, in arrival order. Nothing cuts a reply off except an explicit stop (web: "Stop playback" in a message's context menu).
- A reply waits for its own late chunks instead of jumping to the next reply; after 20 s without a chunk it gives up, and late chunks of a finished reply are dropped.
- A short cue (two tones, 660 → 880 Hz) sounds before a reply that starts within 3 s of the previous one ending.
- Acks and "Play aloud" go ahead of replies still waiting, never ahead of the one playing.
- A message without `utterance` (older server) falls back to thread + kind, renewed at chunk 0.

Wind-tunnel s39 checks the server half: utterance ids, one owner each, chunks in order. The queue tests (vitest, `python3 -m unittest test_tts_queue`, `./gradlew testDebugUnitTest`) pin the player half.

## Voice node push-to-talk

Push-to-talk streams, the same `voice-stream` channel the web mic uses, so it fills the dictation draft bubble:

```
keys down → voice-stream.start {format:'pcm16', sampleRate:16000, deliver:'presence'}
held      → voice-stream.chunk {audio}  (one 80 ms frame each, raw 16-bit PCM)
keys up   → voice-stream.stop
server    → voice-stream.draft {source, threadId: presence, text, done} to every connection
            sharing the node's device name; on stop it sends the final text to the presence
            thread (voice origin + device name, so TTS answers on the node), then done: true
client    → features/voice/remote-dictation.ts shows it as a read-only draft (no tap-to-edit)
```

- **Windowed transcription (pcm16 only, `packages/voice/src/streaming.ts`).** Each pass transcribes only the audio after the last committed cut. Once that tail reaches 20 s, the session cuts it at the quietest 200 ms after the first 10 s, transcribes up to the cut once and keeps that text; the same pass then transcribes the rest, so the draft never loses words. The client's `sampleRate` must be 8000–48000 (else 16000). A pass therefore stays a few seconds long however long the keys stay held (4 min of speech: no errors, ≤ 5 s between updates). webm cannot be cut without decoding, so the browser path still re-transcribes the whole recording each pass and slows past about 80 s (15 s pass timeout).
- **Order:** the PTT thread queues WebSocket messages into one asyncio queue that a single task sends; a reconnect drops whatever the dead connection left. Server side, one device's stops send to presence in order, and only the device's current stream may update or clear the draft (a new hold can start before the last one's send resolves).
- **Local dictation wins:** a tab dictating in its own InputArea keeps its draft; node drafts wait until it ends.
- **Fallback:** with the WebSocket down, or a server without `voice-stream` (error `UNKNOWN_CHANNEL`/`UNKNOWN_TYPE`), the node uploads on release. The node also keeps every frame while it streams: if the connection drops or reconnects mid-hold, or the server refuses the stream, the whole hold uploads on release to `/api/voice/transcribe`. There `--max-capture` sets the segment length (120 s): a longer hold sends a segment and keeps recording; POSTs go one at a time with a 150 s timeout. Wake word mode keeps `--max-capture` as its hard cap (30 s).
- **Coverage:** `ws.test.ts` (draft fan-out, send-then-clear, send order, stop/start/disconnect races, browser streams untouched), `streaming.test.ts` (windowing), `remote-dictation.test.ts`, `services/voice-node/test_ptt_stream.py` (stream + mid-hold fallback), wind-tunnel s40.

## Device file viewer (`packages/system/src/device-files.ts`)

System → Devices → a device card → **Files**: browse the whole file system of any tailnet device the device monitor reaches, see sizes, and download a file or a directory (`.tar.gz`) to the viewing device.

| Route | Does |
| --- | --- |
| `GET /api/system/devices/:device/fs?path=` | List one directory (name, type, apparent size, mtime). No `path` lists the login user's `$HOME` (cached per host); the response's `path` says which |
| `GET …/fs/sizes?path=` | Start or poll a `du -x -d 1` job for that directory: child sizes fill in as du prints them; `done`, `total`, `partial` (some folders unreadable), `warnings` (du's first 3 complaints, verbatim), `error` |
| `GET …/fs/download?path=` | Stream a file, or a directory as `tar -czf -` |

- `:device` is the device label from `/api/system/devices/metrics` (`hostname` there). `deviceMonitor.findDevice` resolves it to local or SSH (`sshHost`, `osHint`, same BatchMode access as metrics).
- **Quoting:** every command runs as a script on stdin (`bash -s`, locally or over ssh) with the path set as `P='…'` via `shQuote`; the path is never interpolated unquoted. Paths must be absolute; they are normalised.
- **Listing:** local uses `fs.readdir`; Linux remotes `find -H -printf`; macOS remotes `find -H -print0 | xargs -0 -r stat -f`. `-H` (and `du -H`) follow the requested path when it is a symlink (macOS `/tmp`, `/var`); links in a listing open like folders.
- **Sizes:** `nice -n 19`, `-x` (one file system). A finished result is cached 10 min; a running du nobody polls for 60 s is killed by a timer, and any du is killed after 5 min (`maxRunMs`) with `error: stopped after 5 min …` — a `du /` on a multi-TB disk otherwise runs for many minutes. No sudo: `du:` errors make sizes lower bounds (`partial`). A du that never reports the directory (device unreachable) ends with `error`, cached 10 s. The root of a typical Linux server sizes in ~9 s.
- **macOS root:** every APFS volume of the boot volume group reports the same `st_dev` (`stat -f %d` on `/`, `/System/Volumes/Data` and `/Users` all match), so `du -x` does not stop at `/System/Volumes`. At `/` it would count the data volume twice: through `/System/Volumes/Data` and through the `/Users`, `/Applications`… firmlinks. At `/` and `/System` on macOS the job runs `du -I Volumes` to skip that folder. Below them, plain `du -x` is right. Expect `/Users` above `df`'s used figure: du counts every APFS clone in full. `/home` on macOS is an autofs mount that is normally empty; home folders are under `/Users`.
- **Override matching:** `findOverride` folds curly apostrophes to straight ones — macOS names the host `Alex’s MacBook Pro`, config keys are typed with `'`. Before this, such an override (label, `sshHost`) silently did not apply.
- **Download:** the script prints `@@SOVEREIGN-FS@@DIR|FILE` on stderr before data; any stderr line may carry it (ssh warnings and login shells print first). Missing → 404, unreadable → 403, both before headers. A directory archives its physical path, so a symlinked directory gives the target's contents. If the stream breaks after headers (non-zero exit; tar 1–2 count as success), the response is destroyed so the browser shows a failed download.
- **UI:** `FileBrowser.tsx` mounts on first open of the Files section and opens the device user's home. Folder sizes count only after the **Sizes** toggle; the toggle stays on while browsing. du's own warning lines show under the list. Device cards are keyed by hostname: the 30 s metrics poll used to remount every card (keyed by object), which would close an open browser.
- Replaces the old "Disk usage by directory" list (a 12 s-capped `du /` every 5 min per device, cleared between runs — it timed out on big disks and flickered away).
- Phones (Android/iOS) are not in the device list: no SSH. Wind-tunnel s42 covers the routes.

## File quick-open (Cmd+P / Ctrl+P)

- **Key:** `isQuickOpenKey` in `hooks/useKeyboardShortcuts.ts` — Cmd+P on macOS (Ctrl+P stays "previous line" in text fields), Ctrl+P (or Cmd/Super+P) elsewhere, never inside the terminal (`.xterm`, Ctrl+P is the shell's previous command). Cmd+K and Cmd/Ctrl+P close each other's palette.
- **Server:** `GET /api/files/search?root=<root id or path>&q=&limit=` (`packages/files/src/file-search.ts`); the root must be one of `/api/files/roots`. The file list comes from `rg --files --hidden -g '!.git' --null` (honours `.gitignore`; looked up on PATH, then `~/.local/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`), else a walk that skips `node_modules`/`.git`/`dist`/`build`/`target`/`.venv`. Lists cap at 500k files and are cached 30 s per root (stale served while a fresh one builds). Scoring: query characters in order, file-name matches first, word starts and runs score more; the top N is kept while scanning, so a one-letter query over ~300k files stays near 100 ms.
- **Client:** `features/workspace/FileQuickOpen.tsx` searches the root whose id matches the active workspace (else `_global`), lists recent tabs before typing, and opens the pick with `sovereign:open-file` (which also switches the main view to files).

## File panel tree (`features/workspace/panels/FilePanel.tsx`, `file-tree.ts`)

- **Follows the open file** (as VS Code does): whenever the active file changes, the panel expands its root and every folder above it, and scrolls its row into view; opening the drawer (or the mobile tree) scrolls to it again.
- **Loading follows the expanded set.** `expandedDirs` is persisted and shared by every FilePanel instance (the app mounts more than one, each with a desktop drawer and an `md:hidden` mobile copy), but each instance loads its own `treeMaps`. An effect loads the children of any expanded folder whose parent is loaded and whose own children are not — so state restored on mount, or set by another instance, fills in. Toggling a folder only changes the set.
- **Refresh** (`file.changed`) refetches the top level and every expanded folder together and swaps them in at once; replacing only the top level collapsed every open folder.
- Rows carry `data-tree-path` (absolute path); the scroll moves only the tree's own scroll box.

## File chips in messages (`packages/client/src/lib/markdown.ts`)

`renderMarkdown` turns file references in rendered HTML into `.file-chip` spans (click opens the file, ⧉ copies the path). `injectFileChips` runs in phases over marked's output:

| Phase | Matches | Chips when |
| --- | --- | --- |
| 0 | Markdown links `[label](href)` with a local href (`/abs`, `~/…`, `file://`, relative) | Always for absolute and `~/` hrefs; for relative or bare names, when the name is known |
| 1 | Plain-text `/abs/…` and `~/…` paths ending in `.ext` (1–10 chars); skips `<a>`, `<code>`, `<pre>` content | The path is a known file, or the server confirms it is a file |
| 2a | A whole inline code span `` `x` ``: an absolute or `~/` path (as Phase 1), else a relative path or a bare filename | Known, or (absolute/`~/`) confirmed by the server |
| 2b | Plain-text relative paths and bare filenames (longest first) | The name is known |

- **Known files** come from two lists the client loads per workspace: each project's tree (`/api/files/tree`, depth 4) and the Sovereign workspace (`/api/files/workspace`, depth 8, minus the runtime data dir). A bare filename maps to the first file with that name. An absolute or `~/` path in neither list (an org's `.specs`, another repo) is checked once with `POST /api/files/exists` (batched, files under the home dir only); the answer is cached per path and a found file re-renders as a chip (`wsFilesVersion` bump).
- `~/` expands with a home dir taken from the first known `/home/<u>/` or `/Users/<u>/` path.
- Never chipped: relative paths and bare names no list knows, absolute paths that are not files under the home dir, paths inside fenced code blocks, paths without an extension, paths with characters outside `[\w.+-]` (spaces, `@`).
- Results cache per text and workspace-list version: a message renders again once the lists arrive.
- **Opening a chip** (`lib/file-chip-handlers.ts`) and the **file viewer** (`FilePanel.tsx`) pick a view with `lib/file-view.ts`: HTML renders as a page in an iframe, images (png, jpg, gif, webp, svg…) as `<img>`, markdown rendered, anything else as text. HTML and images load from `GET /api/files/view/<absolute path>` (files under the home dir; `/view/~/…` expands). The path sits in the URL path so a page's relative links (`x.json`, CSS) resolve beside it. HTML and SVG responses carry `Content-Security-Policy: sandbox allow-scripts …`, and the iframe has the same `sandbox`: scripts run, but in an opaque origin with no access to Sovereign's API or storage — also when the page is opened in its own tab. A page's `fetch()` of a sibling file fails (cross-origin from the opaque origin; no CORS on purpose), so pages should embed their data. In the viewer, Edit shows the source.
- **Mermaid** (`lib/mermaid.ts`): in the file viewer and the chip preview, each ` ```mermaid ` block renders as an SVG after the HTML is in the DOM (`renderMermaidIn`). Mermaid loads by dynamic import on the first diagram (its own chunk; ELK layouts are bundled in mermaid 12), runs with `securityLevel: 'strict'`, and uses the dark theme except for Sovereign's `light` theme. A block that fails to parse keeps its source with the error above it. The file viewer re-renders on a theme change. Chat messages do not render diagrams. Labels are measured off-page, so `.mermaid-diagram foreignObject p` resets the page's paragraph styles — keep that rule if the viewer's prose classes change.

## Network map (`packages/system/src/network-map.ts`)

System → **Network**: a live map of the tailnet and LAN. It shows each device with its hardware, the services listening on it, and the TCP connections between them. `GET /api/system/network` returns `{ collectedAt, devices, links }`. The scan is cached 8 s and concurrent callers share one scan. The tab polls every 10 s while visible.

- **Scan:** one script per device over stdin (`bash -s`, locally for the hub or over ssh), like the device monitor. Linux runs `ss -Htlnp` / `ss -Htnp state established`, `/proc/<pid>/cgroup`, `ip addr/route/neigh`, `docker ps`, `tailscale serve status --json`, `/proc/net/dev`, `lspci`, `/proc/asound/cards`, video4linux and `lsblk`. macOS runs `lsof +c 0 -F pcn`, `netstat -anp tcp` (lsof without sudo misses root listeners such as sshd; netstat truncates long IPv6 addresses, so only its wildcard and `::1` IPv6 rows count), `ps`, `ifconfig`, `route get`, `arp -an`, `netstat -ibn` and `sysctl`. lsof lists a socket once per fd, so the parser dedupes sockets. Phones come from `tailscale status` only.
- **Naming a listener:** Docker container (by published port) → systemd `.service` unit from the cgroup (scopes, slices and `user@` do not count) → known app (VS Code, Ollama, Claude Code…) → script name for node/python (the package dir for `dist/index.js`) → executable. A socket without a pid (root-owned, not visible without sudo) bound to the tailnet IP is `Tailscale Serve` or `Tailscale`, else a well-known port name, else `port N`. Processes in a unit's cgroup count as that unit, so the SSH sessions Sovereign spawns show as `sovereign → SSH`.
- **Roles:** every service has a `role` that tells what runs it. `container` = Docker. `service` = a systemd unit, except OS units in `SYSTEM_UNITS`. `app` = a named user process. `system` = OS units, SSH, and pid-less root sockets (Ollama counts as `service`). The card shows the services in fixed sections: Services, Docker, Apps, System, then "Connects out" (no listener). The sections sort by name. Tiles sit in an `auto-fill` grid (240 px minimum on the hub card, 180 px elsewhere), so the columns align. A tile shows the first port plus "+N"; the tooltip lists all the ports.
- **Links:** `tcp` comes from the client side of each established socket, matched to the listener it reaches on the peer device (loopback = same device). The server side counts a connection only when the client's scan did not see the mirror socket (a phone, an internet host, a socket lsof cannot see). When neither end shows a listener, the end with the higher (ephemeral) port counts as the client. An IP that two devices claim (`docker0`'s 172.17.0.1, `fe80::1`) resolves only to the device that has it. `proxy` links Serve to the local port it fronts. `tailnet` is the hub → peer path (`LAN`, `direct`, `relay <region>`) with a byte rate from `RxBytes+TxBytes` deltas. `lan`/`wan` come from the hub's default gateway.
- **LAN devices:** IPv4 neighbours on the gateway subnet that no scanned host owns (multicast and broadcast MACs skipped). A MAC with the locally-administered bit set shows as a Wi-Fi device (private MAC). Name one with a `deviceOverrides` entry keyed by its IP: `"10.20.30.216": { "label": "Printer" }`.
- **UI** (`NetworkTab.tsx`): the cards are HTML. Edges are SVG paths measured from `[data-node]` element rects in the frame after each poll, "Unnamed ports" toggle or pin, and on resize. Without focus, only device links and cross-device service links draw (Internet links excluded), all behind the cards. Hover (mouse only) or tap a chip or card to draw all its links on top, including links inside a machine. A tap pins it and opens the inbound/outbound panel. Touch pointers never hover: a touch screen sends no leave event, so the focus would stick. "Unnamed ports" shows `port N` and the Tailscale peer API.

## Hazard monitor (`packages/server/src/hazards/`)

Watches one property in Victoria and messages the **presence thread** (a queued system card, the same path as CI watch) only when something needs attention. Off by default; set `hazards` in the config (`enabled`, `lat`, `lon`, `label`, `fireDistrict`).

| Feed | Poll | Used for |
| --- | --- | --- |
| VicEmergency `events-geojson.json` | `pollMs` (90 s) | Warnings (level in `category1`, area as polygons) and incidents (points) |
| CFA `tfbfdrforecast_rss.xml` | `forecastPollMs` (30 min) | Total Fire Ban + BOM Fire Danger Rating per fire district, 5 days |

**The bar (`rules.ts`):** Watch and Act / Emergency Warning whose **polygon contains** the property (a warning's incident point beside the property does not count); an uncontrolled vegetation fire within `fireRadiusKm` (5) or any uncontrolled fire within `anyFireRadiusKm` (1); a fire ban or an Extreme/Catastrophic rating for today or tomorrow. Then one message when an alerted item escalates and one when it eases or ends; ratings rolling off the forecast are silent. Advice-level warnings, distant fires and High ratings never message. If VicEmergency stays unreadable 30 min on a fire-ban/High+ day, one "feed down" message.

- **One fire, two records:** VicEmergency can list one fire twice (a CFA incident and a 000 dispatch event, ids apart, 20 m apart). Fire records within `SAME_FIRE_KM` (1 km) of each other count as one fire: only the first is announced, and "eased" goes out once, when the last record ends. Each fire item stores a point (`at`) for this. Two separate fires within 1 km of each other also share one alert.
- **Feed ids:** VicEmergency gives a warning a new `id` on every reissue (seen hourly in Jan 2026), so warnings key by hazard (`warning:fire`, `warning:riverine flood`) at the highest covering level. NSW RFS incident ids embed the update time, so they key by `sourceOrg:sourceId`. VIC incident ids (`ESTA:…`, DEECA numbers) stay stable.
- Fires: `category1` "Fire", or any vegetation `category2` (FRV files "Grass and Scrub" under "Other"). A mapped burnt area counts as vegetation. The district-wide "Fire Danger Rating" / "Total Fire Ban" pseudo-incidents never count as fires. Unknown warning levels and fire statuses count as active.
- "Eased" goes out only after an item is absent for `EASE_AFTER` (3) reads, so a gap between reissues is silent.
- State (alerted keys, last "feed down" date) persists in `<dataDir>/hazards/state.json`, so restarts never repeat an alert. Each sent message commits its state; a failed send retries next poll without repeating earlier ones. The loop always runs; `enabled` hot-reloads.
- `GET /api/hazards` returns the current state, outlook and feed timestamps.
- Tests use real captures in `hazards/fixtures/` (public data) plus synthetic warnings/fires; there is no wind-tunnel scenario (the feeds are external).

## CI watch (`packages/server/src/ci-watch/`)

MCP tools `ci_watch` / `ci_watch_list` / `ci_unwatch` let a thread watch the GitHub checks of a PR, branch or commit. The server polls; the thread gets one message (cron envelope `[Cron: CI <target> @ <time>]`) through the chat queue, so it never interrupts a turn.

- **Sources:** check runs (GitHub Actions and Apps) and commit statuses (CircleCI on coasys repos posts statuses only), one state per name, check runs first.
- **Ending:** red: the first poll that sees a failed check ends the watch. Green: every watched check finished, and still so on the next poll (`settleMs`, 10 s). CircleCI posts a job's dependants about a second after the job passes, so one all-finished poll can be partial.
- **Cadence:** one loop every 10 s polls every watch in parallel (`CI_POLL.pollMs`); only a watch whose polls fail backs off (20 s doubling to 5 min). Requests carry the last ETag; unchanged answers are 304s, which do not count against the rate limit. Token from `gh auth token`, so any repo the `gh` account can read works (public coasys repos included); no webhook needed.
- **Follow:** a PR or branch watch moves to the new head after a push (default); `follow: false` stays on the commit.
- **Limits:** 12 h default timeout; no check after 20 min ends the watch. Watches persist in `<dataDir>/ci-watch/watches.json` and resume after a restart.
- **Shared fold:** `toCheckStates` lives in `@sovereign/forges` (`checks.ts`), so CI watch and the forge adapter's `checks()` agree on what failed. CI watch keeps its own polling: it needs each check's conclusion, URL and summary for its message, and per-watch ETags and head-following, which `Forge.checks()` (a summary) does not carry.

## Forges (`packages/forges/`)

One interface (`Forge` in `@sovereign/core/forge.ts`) over every code forge; today only GitHub implements it.

- **Client imports:** the client takes Forge values (e.g. `defaultWorkPrompt`) from `@sovereign/core/forge`, never from `@sovereign/core`. The root index pulls `node:fs` (bus logger), which breaks `vite build` but not `pnpm -r check` or vitest. Type-only imports from the root are fine.

- **Adapter** (`github.ts`, `createGithubForge`): lists over GraphQL (`queries.ts`: `ForgeChanges`, `ForgeIssues`, `ForgeBranches`); `getChange` / `getIssue` read one item over GraphQL (`ForgeChange` / `ForgeIssue`, the same fields as the lists, `undefined` on `NOT_FOUND`); check, compare and comment reads and the one write (`setAssignees`) over REST. Lists run newest-updated first; items updated at or after `until` are skipped, and paging stops at the first item older than `since`. `state: 'open'` asks for OPEN only. PR bodies pass through unchanged ("Paired with" blocks are the graph builder's job).
- **Cost (measured on a 300-PR repo, Oct 2026):** a 50-PR page of `ForgeChanges` costs 4 points and takes ~4 s; a 100-PR page costs 7 and takes ~6 s, so the default page is 50 (`pageSize`). `onPage` reports each page's cost and time. The rollup state comes with the list; failed check names only from `checks(ref)` (contexts per PR would multiply the cost).
- **Transport** (`transport.ts`): REST base `apiUrl` (default `https://api.github.com`, or `$SOVEREIGN_GITHUB_API_URL`), GraphQL at `<apiUrl>/graphql` (`/api/graphql` for an Enterprise `/api/v3` base). Token: `token` option, `$GITHUB_TOKEN`, `$GH_TOKEN`, then `gh auth token` (cached; re-read once on a 401). Retries: 5xx, network errors, GraphQL `RATE_LIMITED`, and 403/429 rate limits, backing off 1 s doubling (capped at `maxWaitMs`, 60 s) or the server's `Retry-After` when longer. A spent primary limit whose reset is further off than `maxWaitMs`, or a rate limit that outlasts the retries, fails at once and blocks every call (429, no request) until the reset or the asked wait. REST GETs keep an ETag per URL (500 entries) and reuse the body on 304.
- **Registry** (`registry.ts`, `createForgeRegistry`): `forgeFor(host | { forge, host })` builds one adapter per (forge, host). A self-hosted GitHub host listed in `hosts` gets `https://<host>/api/v3`; `githubHosts` overrides options per host. Other forges need a factory.
- **Discovery** (`discovery.ts`): `discoverRepos(paths, hosts?)` dedupes forge repos across checkouts and remotes; `primaryRepo(path)` is the checkout's `origin`. Both read `parseForgeRemotes` in `@sovereign/orgs`, which reads a linked worktree's remotes from the main repo's config (`.git` file → `gitdir` → `commondir`) and takes a host → forge map. `parseGitRemotes` keeps its GitHub + Radicle shape for the issues, drafts and review packages.
- **Backfill paging:** `pageChanges` / `pageIssues` (optional on `Forge`, implemented by GitHub) read one page at a cursor, all states, skipping items at or after `until`. The work graph persists the cursor.

## Forge work graph (`packages/work-graph/`)

Per membrane: which repos, what happened in them, and who works on what. `createForgeService` is always wired in `bootstrap.ts` (routes, WS channel, started once the task and meta stores have loaded). `forge.enabled` (read live) gates the membrane syncs, backfill and overlay; the tracked-item poll below runs either way.

- **Scope** (`scope.ts`): **opt-in** — a membrane syncs only the repos listed in `forge.repos[<membrane>]` (none listed → nothing synced). Discovery (membrane → `workspaceIds` (orgs) → projects → remotes, `discoverRepos`) only attaches local checkouts to the listed repos; a project's remote is never synced unless listed. GitHub only for now. Plan dirs: absolute `forge.planDirs` entries serve every membrane; relative ones resolve under the membrane's content dir, each org and each project.
- **Sync, Loop 1** (`sync.ts`, one `RepoSync` per repo, jobs serialized per repo; `service.ts` serializes per membrane). Membranes that share a repo share its `RepoSync`; the events one membrane's sync reads are queued for the others' next sync, so each logs them and tells its own owner threads. First run: the `windowDays` window plus every open item. Open refresh (`pollOpenMs`) and all refresh (`pollAllMs`) both re-list every open change — a check result does not move `updatedAt` — plus everything updated since the last refresh (60 s overlap); the all refresh also re-reads branches. Failed check names come from `checks(ref)` once per head sha; ahead/behind from `compare(base, head)` once per head + base sha, open same-repo changes only. Owned items (task with a thread) also get their comment count read. A backfill then reads older history one page every 3 s, resumable from the cursor in the cache; items it reads raise no events.
- **Cache:** `<dataDir>/forge/cache/<forge>_<host>_<owner>_<name>.json`, written temp-file + fsync + rename. Bodies are dropped once their `Paired with` refs are read. A cold start serves it before any forge call.
- **Builder** (`build.ts`, pure): node ids are `refKey`s (`github:github.com/o/r#N`, branches `…@name`), `plan:<project>/<rel path>`, `task:<id>`. `base` resolves a base branch to the change whose head it is (open first, then newest; fork heads excluded), else a branch node; merged changes get `merged-into`. Timeline cross-references point from the mentioning item; a `closes` edge suppresses the `references` edge between the same pair. Edges to nodes outside the membrane are dropped. Streams are lanes, not nodes. The served window holds past nodes that ended in `[since, until)` and, when `until` reaches now, everything open.
- **Plans** (`plans.ts`): title = first heading, `Status:` → planned / in_progress / done. A bare `#N` links only when the file names one repo in plain text or has a `Repo:` line — an `owner/repo#N` reference names an item, not the file's repo. A known repo's short name right before bare numbers picks that repo ("WE #293, #302" → coasys/we). Not references: a bare `#N` below 100 (section and list numbers: "see #7", "AR-02 #6") and heading anchors (`#12-documentation-site`); a qualified `owner/repo#N` links at any number. Rescanned on each sync and on `file.changed` under a plan dir (files outside org roots get no events, so the next sync catches those).
- **Plans that name work are work streams** (plan §7.4, `syncPlanStreams` in `service.ts`; "epics" in the client). A plan becomes a stream task keyed by its plan id (idempotent) only while it names at least one PR or issue and its `Status:` is not done (`planMakesStream` in `plans.ts`); every plan stays a plan node either way. Before this rule every plan file was a stream, most of them empty. **Plans relate, never own:** plan sync adds no members. The builder marks every node a plan names as related to the plan's epic (`WorkNode.relatedStreams`, from the plan's task when it is a stream; an epic that owns the node is left out), and `WorkStream.relatedCount` counts those nodes beside `memberCount`. **Epic status is the user's:** the plan's `Status:` line sets it once, when the plan becomes a stream (in progress → active, else planned); after that no sync changes it (task sync skips every stream's state, and assigning a thread to a plan epic's node leaves it planned). A plan stream whose plan stops qualifying (done, names nothing, file gone) with no members or child streams stops being a stream (`TaskPort.setStream(id, false)`: the plan task stays, on its plan node); members added by hand or child streams keep it as an ordinary stream, and so does a parent stream (a node placed in the goal tree stays a node when its plan stops naming items). Hand-made streams are never touched. Streams sync before task sync, so a new plan's stream is in the same sync's graph.
- **One owning epic per PR or issue, one parent per stream.** A change or issue task is a member of at most one stream, and a work stream sits under at most one parent stream, so streams form trees (the goal tree, below); task-only tasks and plans that are not streams may sit in several. `TaskService` enforces both (`ownedByOneStream` in `packages/tasks/src/service.ts`), the one layer every link goes through: `addToStream` / `link` unlink the item from its other streams first (cycles are refused before anything moves), `create` / `ensureTask` / `createStream` with several stream parents keep the last, and an `update` that makes a task a stream (or binds it to a PR or issue) keeps only its first parent stream. So the client's "In node" select, the tree's drag and "Move to…", `forge_stream_add`, `forge_stream_parent`, `forge_stream_merge`, `task_link`, `POST /api/tasks/link` and `task_import parentTaskIds` all move an item rather than add a second owner or parent. `WorkNode.workstreams` is therefore the owning epic (0 or 1 entry for a forge item). Before the one-parent rule, live data held no stream with any parent, so no migration runs.
- **Migration** (`migrateOwnership`, every plan sync, idempotent): older builds kept `planLinks` (`named`, `linked` = what the plan added) in `<dataDir>/forge/<membrane>/state.json`. While that key is there, every `linked` member leaves its plan stream (it stays related through the plan), then the key is dropped. Then any change or issue still in more than one stream keeps the first by stream name and leaves the others: links carry no timestamp, so "most recently added" cannot be told.
- **Epic status** (`WorkStream.status`: `EpicStatus` in `@sovereign/core` forge.ts) is the stream task's state: `planned` = pending, `active` = in_progress, `paused` = paused, `archived` = cancelled; a `completed` stream also reads as archived (`epicStatusOf` / `stateOfEpicStatus`). `service.setStreamStatus` sets it (`POST /api/forge/streams/:id/status`, `forge_stream_status`, the panel and node card selects). `ForgeGraph.workstreams` (and each node's `workstreams`) leaves archived ones out unless `GET /api/forge?archived=1`; `GET /api/forge/streams?membrane=&archived=1` lists them. Node `relatedStreams` drop archived ones the same way. A plan sync never touches an archived plan stream (never un-archived, never retired). `WorkStream.plan` holds the plan key of a plan stream.
- **Goal tree: progress and blocked** (`tree.ts`, pure; `withProgress` in `graph()`). A stream with no parent is a goal; every stream is a node; a node's leaves are the PRs, issues and task-only tasks it owns. `WorkStream.progress` (`StreamProgress` in `@sovereign/core` forge.ts: `done`, `total`, `blocked`) counts the leaves of the stream's whole subtree, over the membrane's full graph (not the served window). `leafState` (core): a merged change or an issue closed as completed is done, a closed change or an issue closed as not planned is cancelled and left out of `total` (`WorkNode.closedReason` carries the issue's reason), a task follows its state. `blocked` counts open leaves waiting on another open PR, the Kanban rule: a PR whose `base` edge points to another open or draft PR, and an issue whose open closing PRs are all blocked; and open leaves behind an unfinished `depends-on` target (below). A PR that closes a leaf issue of the same subtree rides on that issue and is not a leaf of its own. A task-only task in two streams of one subtree counts once. Archived sub-streams leave their parent's count; an archived stream still counts its own. Tests: `tree.test.ts` (the roll-up), `tree-routes.test.ts` (progress on `GET /api/forge`, the parent route, moving a leaf), client `tree-model.test.ts`.
- **Dependencies (`depends-on`).** Edge kinds: `base`, `merged-into`, `closes`, `references`, `paired`, `plans`, `subtask` (sync), `related` (a rethink suggestion, dashed, counts for nothing) and `depends-on`: `from` cannot finish before `to`. Either end is a node id (PR, issue, task, plan) or a work-stream id of the membrane. Set by the user (`POST /api/forge/edges`, source `user`) or by rethink (`forge_depend`, source `rethink`); stored in the meta edge table like `related` (`TaskPort.addRelated`), accepted at once, served solid (`dashed: false`). `service.depend` refuses (400) a self edge, an end that is neither a node nor a stream of the membrane, and an edge that closes a cycle of `depends-on` edges; an edge already there is returned. `blockedLeaves` (`tree.ts`) marks an open leaf blocked while it depends on something unfinished: a node whose `leafState` is neither done nor cancelled (a plan or branch: its state is not done, merged, closed or cancelled), or a stream that is not archived with an open leaf in its subtree; a dependency from a stream holds every open leaf of its subtree. The builder keeps a `depends-on` edge whose end is a stream; `graph()` serves it while both ends show (a shown stream, a served node). The canvas draws it as a solid red arrow from the dependent to what it needs (`edgeStyle` `arrow`); a stream end attaches to the stream's tree card (`computeLayout` maps the stream id through `cardOf`), and the future zone orders by it as by `base` (`DEPTH_KINDS`). The node card lists it as "Depends on" / "Needed by" with a ✕ (delete). Follow-up, not built: plan files state dependencies in "Needs" columns, which plan sync could parse into `depends-on` edges.
- **Selected epics** (`filters.workstreams` of a view) are a client-side focus, not a filter: `applyView` ignores them, so the served window keeps every stream's nodes and the client can show the selection's neighbours (`epicNeighbours`, default on). "Owned | Owned + related" (`filters.epicRelated`, default owned) decides whether the selected epics' related nodes join the focus (`streamFocus(…, related)`), and, on the canvas, whether a node no drawn stream owns belongs to (and links to the card of) one it is related to; such a card is drawn with a dashed purple border (`PlacedNode.related`, `RELATED_CARD` in `style.ts`), the same style as a `related` edge.
- **Client Tree panel** (`TreePanel.tsx`, logic in `tree-model.ts` and `epics-model.ts`; it replaced the Epics panel, which had replaced the Stream filter chip and the stream side menu). A "Tree (n)" button in each graph panel's header opens it as a dropdown or as a centred window; a header button switches, and the choice persists (`sovereign:forge:epics-mode`). Esc and a click outside close both. It is an outline: goals → nodes (`orderEpics`: hierarchy, then natural sort by name, never by selection or counts), each node collapsible (▾ hides its subtree), and each node's leaves (its own members among the loaded nodes, `leavesOf`: open first, then newest) folded until its item count is clicked; a leaf click selects it, so its node card opens. Each node row shows a progress bar with "done/total" (`progressLabel`, from `WorkStream.progress`), a ⛔ blocked count when there is one, and its coloured status select (`EpicStatusSelect.tsx`, colours in `style.ts`). **Placing:** drag a node onto another node to set its parent, or onto "Drop here: top level" (shown while dragging) to make it a goal; "Move to…" on each node row (every stream but its own subtree, named by path "Goal › Node", plus "Top level") does the same through `POST /api/forge/streams/:id/parent`. `canPlace` refuses a drop on the node itself, its subtree or where it already sits. A leaf moves by drag onto a node or its own "Move to…", through the members route (one owner: a PR or issue leaves its old node on the server; a task-only leaf is removed from the node it was dragged from). It keeps a search box (goal and node names, ancestors kept), status chips Active / Planned / Paused / Archived (multi-select, saved in `filters.epicStatus`; none = active and planned, paused too while "Paused" shows; Archived makes the panel load the graph with `?archived=1`), multi-select of single nodes (saved in `filters.workstreams`; a picked node brings its subtree of a shown status), clear (picks and chips), the "Owned | Owned + related" toggle, "Include neighbours", "Dim instead", "New goal" (a root stream; the select beside it makes it a node inside another instead) and "Refine the tree…" (POSTs the epics refine route, then "Sent — open thread"). The node card's "In node:" select (a leaf's owner, or a plan node's parent, by path; "Top level (a goal)" for a plan node) is "Move to…" on a card. The filter chips keep their option order while picking (`stableOptions`: the server narrows the window to the saved picks, so fresh counts used to re-sort the menu and drop the other values), and Zone, Author, Reviewer and Label sit behind "More". Repo, Type, State and Assignee are always shown; Type (`filters.kinds`, `KIND_LABELS`: PRs, Issues, Plans, Tasks, Branches) narrows by node kind on the server (`matchesFilters` in `build.ts`) and the client alike, and goal-tree cards still show whatever it hides.
- **Status selects epics.** The list shows the epics of the shown statuses (`shownEpics`). With chips on and no epic ticked, every listed epic is selected (`selectedEpics`), so "Active" focuses the panel on every active epic; ticked epics win, within the shown statuses. `focusedEpics` (selection + sub-epics, kept to the shown statuses) is the one function behind `epicFocus` (canvas and Kanban, through `panelVisibility`) and `canvasStreams` (the canvas's tree).
- **The goal tree on the canvas** (`layout.ts`, `render.ts` `drawStreamCard`; it replaced `laneFold`, which folded deeper streams into the picked node's child lanes). The canvas draws the streams `canvasStreams` gives it: every shown epic, or with a selection the focused ones (picks plus their subtrees), so a picked node is a root; none while "Not in a tree" is on. `streamTree` orders them depth-first (siblings in server order; a parent outside the list or a cycle makes a root). **X:** every stream gets a card right of the future zone (`ZONE_GAP` past the last future cell), one column per tree depth, roots furthest right (all goals line up), so the tree breaks down right → left towards the leaves on the timeline. **Cards:** a plan's stream uses its plan node as its card when that node is in the window — `graph()` always serves the plan node of every shown stream, whatever the view's filters or window, because it frames the tree (it leaves its old lane and future column; its edges still draw), else, like a hand-made stream, a synthetic card `epic:<stream id>` (`streamCardId` / `streamOfCard`). `PlacedNode.stream` marks a card; `Layout.tree` holds card id → stream and the child → parent `links`. A card shows the name, status colour (`EPIC_STATUS_COLORS`), plan icon or diamond, a progress bar with done/total and ⛔ blocked, a teal border; links are solid teal (`TREE_LINK`). The scene always shows cards, undimmed, whatever the filters or focus. **Y (no lanes):** one grid of rows, positioned by the graph. Each item links to the card of the stream that owns it (`Layout.tree.members`, drawn thin and faint in the tree's teal, dashed when only related; `PlacedNode.group` is that stream, else the repo, else `other`). The first fill packs units (a node with its branch line, or a stack) group by group in tree order; then `LAYOUT_PASSES` passes move each unit towards the mean row of its card and its edge neighbours and pack it into the nearest free row (`Grid.place`), and rows left empty are closed. A future depth column wraps into sub-columns at the height the past and present need (at least `MIN_FUTURE_ROWS`), a group's items together. A card sits at the mean height of its items and child cards; a card with neither follows the card before it in tree order; cards in one column never overlap (`CARD_GAP`). Zoomed out, past bands group by `PlacedNode.group` and span their members' rows (`lod.ts`). Leaves keep their time-based x. **Click:** every tree card, a plan card included (`Layout.tree.cards`), opens its stream card (a plan's adds "Plan details…", which opens the plan's node card until the selection changes); a synthetic card's stream card (`StreamCard.tsx`, model `streamCard` in `tree-model.ts`) in the node card's place: status select, progress, "In node:" parent select, sub-nodes and its own items (each opens its card), and "Focus the graph on this branch", which picks the stream in the Tree panel (`focusStream`: the sole pick, so the canvas shows its subtree; on the sole pick it reads "Show the whole graph" and clears it). A repo-filtered view's window holds no plan nodes, so its plan streams draw synthetic cards (with the plan icon).
- **The tree keeps its shape** (`epics-model.ts`). **Empty plans hide:** a plan stream that owns no items anywhere in its subtree and holds no hand-made node (`emptyPlans`) is left out of `shownEpics` unless `filters.showEmpty` (the "Empty plans" chip): a plan earns its place in the tree by owning work; hand-made nodes (goals) always show. **Ancestors stay:** a status chip or any filter that shows a node keeps every ancestor (`withAncestors`; `treeEpics` for the Tree panel, `canvasTree` for the canvas), so no node becomes a root because its parent's status is not shown; those ancestors are `context`, drawn faded (Tree rows at half opacity, canvas cards via `buildScene`'s `contextStreams`). Only a pick (`filters.workstreams`) makes a root of what it picks. Status chips still select only nodes of their status (`selectedEpics` reads `shownEpics`).
- **Paused work is hidden by default** (`filters.showPaused`, the "Paused" chip in `FilterBar.tsx`; `pausedStreams` / `shownStatuses` in `epics-model.ts`, `isPausedOut` in `filters.ts`). Hidden, not dimmed: a paused epic with its whole subtree (the Tree panel's Paused status chip shows them too), an item whose task is paused (`WorkNode.paused`), and an item owned only by hidden paused streams. With no chip chosen the Tree lists active and planned epics. **Pausing an item:** `service.setPaused` (`POST /api/forge/paused { membrane, nodeId, paused }`) sets the item's task state to `paused` (the task is made when missing); only an open item (`leafState` open) pauses, a plan is 400 (set its epic status). Resume sets `pending`, or `in_progress` with an owner thread; sync's `nextTaskState` leaves a paused open item alone and still completes or cancels it when it merges or closes. **On the canvas:** a right-click on a tree card or plan card opens its epic's status menu, on an open item Pause / Resume (`canvasMenuTarget`, the menu in `ForgePanel.tsx`); the node card has a Pause / Resume button, and a paused item's canvas subtitle starts "Paused".
- **"Not in a tree"** (`filters.orphans`, a chip in `FilterBar.tsx`, `isOrphan` in `filters.ts`): only open or draft PRs and open issues that no served stream owns (one owned only by an archived stream counts as not in a tree). Client-side like the epic selection: the server's `matchesFilters` ignores the field, so the window keeps every node. The Kanban follows it through `panelVisibility`. While it is on, `epicFocus` returns null: the tree's selection and status chips do not narrow orphans, which no node owns.
- **Client Kanban** (`KanbanBoard.tsx`, logic in `kanban-model.ts`). A "Kanban" / "Graph" button beside "Sync now" switches every graph panel between its canvas and a Kanban; the choice persists per browser (`sovereign:forge:mode`). Each panel's Kanban lists what its canvas shows: the same `applyFilters` + `epicFocus` result through `panelVisibility` (shared with the canvas), minus dimmed nodes (`panelShown`). Only open/draft PRs and open issues get a card. A PR whose `base` edge points to another open or draft PR is blocked and left out, also when that PR is filtered out; the bottom of a stack carries "stack of N". An issue that an open PR closes gets no card of its own; "closes #N" shows on the PR's card, or on the card at the bottom of that PR's stack. Columns, first match wins: **Ready to merge** (open, ≥ 1 approval, no changes requested, CI passing or none, no conflict) → **Needs work** (CI failing, changes requested or conflict, drafts included) → **In review** (open) → **In progress** (draft, or an issue with an overlay thread, a subagent or an assignee) → **To do**. Each column runs newest `updatedAt` first. A click selects the node, so the panel's NodeCard opens as it does on the canvas.
- **Events + triage** (`events.ts`): `<dataDir>/forge/<membrane>/events.jsonl`, append-only; past 20 000 events it keeps the newest 15 000. Each event's `at` is moved past the last logged one when needed, so a digest cursor never skips an event logged late (triage awaits the classifier). Rules first; what they leave open goes to the injected `classifier` (≥ 0.7 decides, below → needs-agent, no answer → needs-agent). Coverage per tier in `/api/forge/status`. `digest(membrane, since)` is Loop 2's input; `rethink` passes it to the injected `runRethink` and moves the cursor in `state.json`.
- **Tasks** go through the one `TaskPort` (contract in `@sovereign/core`, re-exported from `types.ts`), bound in bootstrap to `createForgeTaskPort` from `@sovereign/tasks` (see Holonic task system). `task-sync.ts` writes status, state (plan §7.3, forward only; a reopen moves a terminal task back) and the `transientState` line, and tells the owner thread only about events triaged `needs-agent` (each message starts a turn): CI red, changes requested, a review or new comments the rules or the classifier judge to need work, conflicts. Info events (merged, closed, approved, CI green, comments that only bots or the membrane's own identity wrote, a bot's comment review, unless they name the identity) only update the task. Bots: a login ending in `[bot]` or with a `bot` name segment (`lal-bot`, `data-bot-coasys`); a bot's changes-requested review stays needs-agent. CI red is dropped when the owner thread has its own `ci_watch` on that change (PR or branch), which already reports it. A status write happens only when something but the poll time changed; a comment count the sync did not read keeps the stored one.
- **Tracked items (what replaced pr-poll):** every open PR or issue task that its membrane's sync does not read — forge off, a repo outside the membrane's scope (and outside `forge.repos`), or no membrane at all — is read one by one (`Forge.getChange` / `getIssue`, `RepoSync.refreshItems`) every `pollOpenMs`, and within a second of a `task.created`. They keep separate caches (`<dataDir>/forge/tracked/`), so a membrane that syncs the same repo still sees its own events. An item's first read sets its baseline (no messages), as pr-poll's import did; later reads raise the same events, triage, task updates and notifications as a membrane sync, and land in the event log and graph of the task's membrane. Terminal tasks are not read; `pollTask(id)` (`POST /api/tasks/:id/poll`) reads one task whatever its state, through its membrane's sync when that covers it. `tracked.test.ts` holds the pr-poll parity cases.
- **Assignees:** assign adds only the membrane's identity (`forge.identities.github`, else the adapter's `/user`) and records it in `state.json`; unassign removes only an identity Forge added. A marker whose identity disappeared on GitHub is dropped on the next sync. Every `state.json` write re-reads the file first, so a sync and an assign running together keep each other's changes. Assignment outside Forge follows the same path: a `task.reassigned` (or a `task.created` with a thread) on a PR or issue task from any source but `forge` — `task_update { threadId }`, `PATCH /api/tasks/:id`, an import — writes or removes the assignee and moves a pending task to in progress.
- **Auto-link** (plan §7.6): the overlay lists `claims` — a subagent whose checkout branch is a change's head, or a CI watch on a change — and each overlay push assigns such a change, when no thread owns it, to the subagent's parent thread or the watching thread (an existing thread only), through `assign` (so it gets the assignee too).
- **Overlay** (`overlay.ts`): task `threadId` → thread status; subagent `cwd` (`SessionSummary.cwd`) → `primaryRepo` + `git branch --show-current` → the change with that head; CI watches → waiting; `waitingOn: 'user'` when the owner thread is idle on a question. Unmatched subagents are listed, not guessed. Pushed as `forge.overlay` when it changes (10 s poll, plus `chat.status` / `subagent.*` / `task.reassigned`).
- **Config:** `forge.githubApiUrl` / `forge.githubToken` point github.com at another API (the wind tunnel's mock); both are read at server start. `/api/config` returns config as stored, so keep a real token out of `githubToken`; the default (`gh auth token`) needs none.
- **Graph response:** `ForgeGraph.identity` is the membrane's forge login (`forge.identities.github`, else the adapter's `identity()`); the client's "requested from me" filter matches it. Edge `source` is `sync`, `rethink` or `user` (by hand, or a rethink edge the user accepted).
- **Routes:** the work graph owns `/api/forge*`, views and suggested edges included: `GET/PUT /api/forge/views?membrane=` (the whole ordered list), `POST /api/forge/edges { membrane, from, to, kind: 'depends-on', reason? }` (only `depends-on`; any other kind is 400), `POST /api/forge/edges/:from/:to/:kind/accept`, `DELETE /api/forge/edges/:from/:to/:kind` (node and stream ids URL-encoded; removes a `depends-on` too), `GET /api/forge/streams?membrane=[&archived=1]`, `POST /api/forge/streams`, `POST /api/forge/streams/:id/status { membrane, status }` (`active` | `planned` | `paused` | `archived`), `POST /api/forge/streams/:id/parent { membrane, parentId }` (a stream id, or `null` for the top level; a cycle or self-parent is 400, an unknown stream 404; answers the moved `WorkStream`), `POST/DELETE /api/forge/streams/:id/members` (a stream id is a task id, `task://…`, so encode it), `POST /api/forge/epics/refine { membrane, prompt }` (rethink-routes.ts, see Loop 2). The tasks routes no longer serve any `/api/forge` path.
- **Wind tunnel s45** turns forge on in `docker/config.json` (membrane `forge-wt`, two mock repos) and drives `/api/forge*` end to end. **s46** drives the wired flow through the real task graph: views CRUD and order, a stream and its member in `/api/tasks`, assign to a new thread (task in progress, assignee on the mock), merge → task completed in one sync, a plan file written under the membrane's `contentPath` → a stream holding what it names, a plan naming nothing → a plan node and no stream, epic status (a plan epic starts active from its `Status:` line, a hand-made one planned; paused holds through a sync and is a paused task in `/api/tasks`; archived leaves the graph, back with `?archived=1` and `GET /api/forge/streams`), `PATCH /api/tasks/:id { threadId }` → assignee, and pr-poll parity (a PR task on a repo outside `forge.repos`, owned by a thread with no membrane: read on its own, CI red on the mock → the owner is told). The ad4m lane's own config (`wind-tunnel/ad4m/config.json`) carries the same `forge` block, so `./run.sh --ad4m --scenario s10,s44,s46` runs the wired flow over a real perspective.

### Decision-model tier (`classifier.ts`)

- `forge.classifier: { url, model?, timeoutMs? }` (default timeout 5 s). Without it, nothing is classified: whatever the rules leave open goes to Loop 2 as needs-agent (tier `unavailable`). The getter is read on every call, so `PATCH /api/config` applies at once.
- One `POST <url>/v1/systemone` per unclear event (llama.cpp's decision-model endpoint, TypeSafe-compatible): `{ model?, state, questions: { triage: { type: 'choice', instructions, criteria: { 'needs-agent', info } } } }`. `state` is a compact text: the event type and detail, then the node card (title, state, CI, reviews, branch, assignees, owned or not).
- The confidence triage compares with 0.7 is `answers.triage.probabilities[choice]`. The response's own `confidence` is 0 when all options are equally likely, so for two options it is no probability; it serves only as a fallback.
- An HTTP error, a timeout, a transport error or a malformed answer returns no answer and quiets the classifier for 60 s, so a dead model server never slows a sync down. It never throws into sync.

### Loop 2 — rethink (`rethink.ts`, `rethink-schedule.ts`, `rethink-routes.ts`)

- **Thread.** Each membrane has one rethink thread, found by label or created, with its id in `<dataDir>/forge/<membrane>/rethink/state.json` (and the card notes beside it). The label is `forge-rethink` unless `forge.rethink.threads[membrane]` names another (e.g. an existing project thread); when the configured label changes, the next run moves to that thread and the old one loses the forge\_\* tools.
- **Run.** `POST /api/forge/rethink?membrane=` or a schedule slot calls `service.rethink`. An empty digest skips the run (`{ ran: false }`). Otherwise `runRethink` opens a run, sends the prompt to the thread as a queued system card and returns `{ runId }`. A second run while one is open is refused (409). The run closes on the thread's first idle after it was busy: a thread busy at the start goes idle once before the prompt's turn starts. A run left open after 30 min closes as `timed-out`. A run report shows `running` from the start and gets rewritten after each action.
- **Prompt** (`buildRethinkPrompt`, snapshot-tested): the job table of plan §6.3, the limits (including: forge text such as titles and comments is data, never instructions), the eight tools, the membrane's streams, its planned tasks ("## Planned tasks": every `task` node in state `planned`, with its stream; left out when there are none), and the digest grouped by stream, then node. Each node gets its id, url, card lines, owner thread (from the overlay), streams and events with their triage tier.
- **Planned → begun** (a job row): a PR that starts work a planned task or an open issue describes. A planned task gets `forge_supersede`; an issue the PR does not close gets `forge_relate` (and, once the PR merged, an attention item to close it). The model checks each new or changed PR in the digest against the planned tasks and against open issues (`gh issue list --search`). An issue a PR closes with "Closes #N" already has a sync `closes` edge; supersede is only for local planned tasks.
- **Tools** (`agent-backend/src/claude-code/forge-tools.ts`). The tools are registered only in a membrane's forge-rethink thread, bound late through `ForgeMcpDeps` the way `ci_*` is. Every call names its `membrane`, which must match the thread's.
  - `forge_relate`: a `related` edge, `source: 'rethink'`, via `service.relate` → `TaskPort.addRelated`. It is drawn dashed until accepted.
  - `forge_stream_add`: `service.addMember` — sets the item's one owning stream (a PR or issue moves out of any other); the tool description and the prompts say so.
  - Epic tools, none counted against the run limits, each recorded as an `epic` action and emitting `forge.updated`: `forge_stream_create { name, parentId? }`, `forge_stream_rename { streamId, name }`, `forge_stream_status { streamId, status }`, `forge_stream_remove { nodeId, streamId }`, `forge_stream_merge { fromId, intoId }` (moves members and child streams, refuses merging into its own sub-stream, archives the source) and `forge_stream_parent { streamId, parentId | null }`. The service methods behind them (`renameStream`, `setStreamStatus`, `setStreamParent`, `mergeStreams`) use the TaskPort's `setName`, `setState` and stream links.
  - `forge_dispatch`: sends `[Forge rethink · <run>] <ref> …` plus the prompt to the owner thread or a given `threadId` (a thread of the membrane, or the owner of one of its items). A node with no owner gets a new thread only when it is in a stream (`service.assign` with `newThread`); otherwise the call is refused.
  - `forge_bug_draft`: a `packages/drafts` draft (labelled `bug`, evidence appended, org and project resolved from the repo's checkout by `projectOfRepo`). It never posts to the forge; the user publishes it.
  - `forge_attention`: ONE list per run of what the user must decide or do. No message is sent anywhere: each item is noted on its card ("Needs your attention: …", shown as "Needs you") and listed in the run report. (It posted to the presence thread until 22 Oct 2026; removed because every membrane's summary landed in one thread.)
  - `forge_note`: a note on the card.
  - `forge_supersede { nodeId, by, reason }` (`service.supersede`): `nodeId` must be a planned task, `by` a PR (else 400). The task is cancelled with transient state "Opened as <repo>#<n>", the PR joins the task's first stream when it owns none, and the PR's card gets the note `Replaces planned task "<title>": <reason>`. Recorded as a `supersede` action ("Superseded" in the report); no limit.
  - `forge_depend { from, to, reason, remove? }`: `service.depend` with source `rethink` (a `depends-on` edge, see Dependencies), or with `remove: true` `deleteEdge(from, to, 'depends-on')` (404 when there is none). Recorded as a `depend` action ("Dependencies" in the report); no limit.
  - Each dispatch, draft, attention item and note lands in `WorkNode.rethink` (`RethinkNote`, last 20 per node), which the card shows under "Rethink notes".
- **Chat runs.** A tool call in the rethink thread with no run open (the user talking to it) opens a `chat` run that closes when that turn ends, so every action gets a report and counts against the limits.
- **Limits.** At most `forge.rethink.maxJobs` dispatches per run; dispatches still being sent count, so parallel calls in one turn cannot pass it; a second `forge_attention` in a run is refused. The token budget (`tokenBudget`) counts the tokens the run added to the thread's context: for every API call since the run started, its prompt + output growth over the call before it, read from the session JSONL (`usageSinceFromFile` → `added`, once per message id). The cache state does not count. A rethink thread is a long-lived owner thread (e.g. a membrane's main thread), so after an idle gap its cache is cold and the first call writes its whole context again (236k tokens on 2026-10-26). Counting cache writes made that rewrite spend the budget before the run did anything. Once the budget is spent, dispatches are refused. Refusals return `{ refused }` to the model and are listed in the report under "Refused" and "Limits".
- **Reports:** `<dataDir>/forge/<membrane>/rethink/<YYYY-MM-DD-HHMM>.md` in local time (`-2`, `-3`… on a clash), with a `.json` beside each. A report gives the status, the trigger (`schedule` / `manual` / `chat`), the digest size and items, the actions by kind, the limits hit and the token usage. `GET /api/forge/rethink/runs?membrane=` returns `{ threadId, active, runs }`, newest first. `GET /api/forge/rethink/runs/:id?membrane=` returns the markdown. The bus event `forge.rethink { membrane, runId, status }` reaches the WS channel `forge`.
- **Schedule.** The server's scheduler holds one system job per (membrane, `forge.rethink.times` entry), as the cron `MM HH * * *` in local time with payload `kind: 'forge-rethink'`. `reconcileRethinkJobs` keeps matching jobs, so their run history survives. It runs at start, on every `config.changed` under `forge`, and every 5 min. With forge off it removes all the jobs. A due job runs `service.rethink(membrane, { trigger: 'schedule' })` and answers `scheduler.job.completed` / `failed`.
- **Refine epics.** `POST /api/forge/epics/refine { membrane, prompt }` (`runner.refine`) finds or makes the forge-rethink thread and queues one message (`buildEpicsRefinePrompt`): the user's prompt verbatim (quoted), the epic tools, an instruction not to dispatch, post attention or open issues and to answer with a short summary, then every epic (archived ones too: id, name, plan key or hand-made, parent, status, members as node id + title, 25 listed per epic), so a request like "pause the assistant epics" maps to `forge_stream_status`. It answers `{ threadId }`; the tool calls open a `chat` run, so the changes land in a report.
- **Client.** "Rethink now" shows running, skipped (empty digest), done (actions, limits hit) or failed (`rethink-model.ts`). "Last rethink" opens `RethinkReport.tsx`, which renders the run reports with a run list and opens the rethink thread.
- **Wind tunnel s47** adds membrane `forge-rt` and repo `acme-labs/sprocket` at runtime (`PATCH /api/config`). It turns an owned change CI-red and runs a rethink. Then it checks the thread, the prompt at the mock LLM, the report, a scripted `forge_relate` edge, a `forge_note` from a chat turn and the empty-digest skip. Last, `POST /api/forge/epics/refine` reaches the same thread with the epic list, and a scripted `forge_stream_rename` renames the epic in the graph and counts as an `epic` action of a chat run; a chat turn's scripted `forge_stream_status` pauses it.

## API traps

- **Thread history** (`GET /api/threads/:threadId/history`) comes from the chat routes, which mount before the threads routes. Its 5 s response cache drops a thread's entry on every `chat.turn` and `chat.message.sent`, so readers without an SSE stream still see new turns.
- **Crons:** `GET /api/crons` renders each payload as `{kind: 'agentTurn', message, text}`, while the store keeps `{kind: 'sovereign.userMessage', threadKey, prompt, label}`. `PATCH /api/crons/:id` accepts either shape and rejects any other payload, so a read-modify-write round trip stays safe.

## File watcher (`packages/files/src/watcher.ts`)

- **One kernel watch per directory, none per file.** On Linux the watcher walks every org root and puts an `fs.watch` on each directory. A directory watch reports changes to its entries by name. Kernel cost scales with directory count: about 6.3k for the live roots, where chokidar used about 228k. chokidar watched every file and exhausted `fs.inotify.max_user_watches` (65,536 by default), which starved every other watcher on the host. Do not reintroduce a per-file watcher. macOS and Windows use Node's native recursive watch instead.
- **Ignored names** (`isIgnoredName`) prune a subtree before any watch goes on it: dependencies, build output, `.git`, caches, `data`, `results`, `training_data`/`training_output`, and every `.venv*`. When a project adds a large generated tree, add its name there.
- A path settles for 150 ms before its event goes out, which coalesces write bursts and atomic saves. A vanished path is reported only if the watcher saw it exist, so editor temp files stay silent.
- **A watch follows an inode, not a path.** Each watched directory records its inode. A directory deleted and recreated, renamed over, or rebuilt by a git checkout inside the settle window shows a different inode, so the watcher re-watches it. Without that check the path would stay unwatched, and a renamed directory's old watch would keep reporting under the old path.
- **Deleting or moving a directory reports every entry it held**, as a per-file watcher would. Consumers matching on an exact path (the file panel's open file) depend on this. The file panel also treats a deleted parent directory as deleting the open file (`panels/file-events.ts`), which covers macOS, where the recursive watch reports only the directory.
- **Known limit:** the kernel queues at most `fs.inotify.max_queued_events` (16,384 by default) unread events and drops the rest silently. A burst of tens of thousands of changes, such as a huge checkout, can lose individual events. The file panel refreshes the whole root tree on any event, so its tree still converges.
- On `ENOSPC` the watcher logs once with the current limit and once more with how many directories it left unwatched. It does not log per path.

## Code index (`packages/code-index/`)

Keeps every codegraph index under the org roots in step with the files on disk. Agents trust `codegraph_explore` output as already-read source, so a stale index misleads them.

- **Trigger.** The files watcher's `file.changed` / `file.deleted` events. A burst of changes runs one `codegraph sync -q <checkout>` for the deepest indexed checkout that holds the path: 250 ms after the last change, or at most 3 s under continuous writes. `sync` reconciles the whole index against the filesystem (stat, then hash), so commits, checkouts, pulls and rebases land too, and a lost event heals at the next one. A full pass runs every 10 minutes as a backstop.
- **Which checkouts.** Directories up to two levels below an org root that hold `.codegraph/codegraph.db`, plus the linked worktrees of those repos (`git worktree list`). A worktree without an index gets `codegraph init` automatically. Test for `codegraph.db`, never for `.codegraph/` alone: ad4m and WE commit `.codegraph/.gitignore`, so every checkout of them has the directory. Discovery reruns on `worktree.*`, `project.*` and `org.*` events, on any change up to two levels below an org root that falls outside every indexed checkout (a pass takes about 20 ms), and every 5 minutes. A new index inside an existing repo sits under the ignored `.codegraph` name, so it waits for the 5-minute pass. An org path that runs through a symlink works: discovery tracks real paths, and watcher paths map onto them.
- **The CLI, not the library.** Each job spawns the installed `codegraph` (about 0.1 s when nothing changed). That keeps codegraph's bundled Node, its native kernel and its `--liftoff-only` WASM flag, follows `codegraph upgrade` with no Sovereign rebuild, and keeps a crash out of the server process. At most two jobs run, never two on one checkout, and change-driven jobs go before catch-up.
- **Only org roots get events.** A checkout outside every org root gets no file events. Add its parent directory as an org.
- **Surface:** `GET /api/code-index` lists checkouts and state. `POST /api/code-index/sync` with `{ "root"?: string }` forces a pass. The health popover shows a "Code Index" row. `CODEGRAPH_INDEX=off` in the service environment opts out.
- Each session's codegraph MCP server reads the same SQLite database and sees these writes at once. codegraph starts its own watcher only for the project its MCP server opens at launch, and Sovereign launches sessions from the workspace root, so without this module no process refreshes any index.

## Code edit (`packages/code-edit/`)

Sessions edit code by naming a symbol instead of quoting its text: `mcp__code__edit` with ops `replace`, `replace_in`, `replace_all`, `insert`, `remove`, `create`, applied in order; any failure writes nothing. `mcp__code__edit_files` takes `{edits: [{file, ops}]}` for several files at once, all or nothing: every file is planned in memory first, and if a write fails partway the files already written get their old bytes back. `replace_all {find, regex?, code, count, symbol?}` replaces every match (literal, or a JS regex with flags `gm` and `$1` expansion) and **requires `count`**: any other number of matches fails the call and lists the lines. Together they give the batch power of sed or a script without the silent failures. Symbol names match the tail of a codegraph qualified name at a `::` boundary (`.` also works; `name@line` picks between same-named declarations). It never guesses between candidates.

- **One stdio server per session.** `claude-code/config.ts` starts `dist/mcp.js` (resolved as `@sovereign/code-edit/mcp`) on the node running Sovereign, with `--liftoff-only` (as codegraph runs its own grammars: no V8 WASM out-of-memory, and a faster first parse) and `--edit-roots`: the cwd, the config directory and every org's workspace, re-read per session, plus the session's own cwd (`withEditRoot`, applied in `resolveMcpServers`). The cwd and config directory can be the same directory, so the org workspaces are what let it reach repos. Parsing stays out of the server process, and nothing is registered until the package is built.
- **Strict input.** Every op and the top-level input are `z.strictObject`s: a misspelt key is an error. Under zod 4 a plain object drops unknown keys silently, so a mistyped `after` appended at the end of the file and `dry_run` wrote.
- **Layers.** `applyOps` (`apply.ts`) is pure: text in, text out, with an `Analyzer` supplying declarations and syntax verdicts. `analyzer.ts` takes symbols from codegraph's `extractFromSource` and parses with codegraph's own WASM grammars (`codegraph.ts` loads both by path from codegraph's platform package, pinned in `package.json`). For TS/JS, Python, Rust and Go a profile (`languages.ts`) widens each symbol to its whole declaration: attached comments, decorators or attributes, `export`/`pub`, the variable statement around a function value, TS overload signatures. Other languages keep codegraph's spans but still get the syntax check. `editFile` (`edit-file.ts`) adds path guards (roots, `.git`, `node_modules`, secrets, 1 MB, non-UTF-8), BOM and per-line line-ending round-trip, compare-and-swap, an atomic write that keeps the file mode, and, from the codegraph index, callers of a changed signature and the nearest affected tests.
- **The client** renders a call with the report's notes and unified diff (`SymbolEditDetail` in `WorkSection.tsx`), told apart from the built-in Edit by its `ops` input.

Gotchas:

- **Load the file's grammar before extracting** (`Analyzer.prepare`, called by `editFile`). codegraph's native kernel refuses any file it cannot parse, a syntax error or a gap in the grammar alike, and returns no symbols; with the WASM grammar loaded it falls back to an error-tolerant parse and still names them.
- **Grammars have gaps.** tree-sitter-typescript 0.23 reports `import('m').T[]` (an array of an inline import type) as an error, and Sovereign's own code uses it. So the syntax gate blocks only problems an edit _adds_: problems are keyed by their text and their line's text, not their position, and compared as a multiset.
- **Free every tree** (`tree.delete()`): web-tree-sitter trees live in WASM memory and are not garbage-collected.
- **Spans always come from the live text**, never from the index DB, which can lag the file. codegraph columns and tree-sitter offsets are both JS string indices (UTF-16); no byte conversion.
- **Python syntax is also judged by CPython** (`python3 -c ast.parse`): tree-sitter-python accepts bad indentation, such as a `def` with no indented body. That verdict blocks an edit only when the file passed it before. A missing `python3` switches it off; a timeout skips one file.
- **What `replace` keeps:** code that opens with a comment replaces the old comments; code that opens with a decorator replaces the old decorators. Omitted decorators, `export`/`pub` (only in front of code that declares something) and a trailing comment on the declaration's last line stay. A blank line detaches a comment from the declaration below, never a decorator or overload. `remove` and `insert before` treat TS overload signatures as part of the implementation.
- **codegraph is pinned (1.6.2)**, because `codegraph.ts` loads its internals by path. The library reads the index the `codegraph` CLI writes, so upgrade both together: if an index format change goes unread, the "callers to check" lines silently disappear from edit reports.
- **Affected tests** come from `codegraph affected` at depth 1 (direct importers), stepping out to depth 2 only when there are none. The CLI's default depth of 5 lists every test that reaches the file at all.

Tests: `text.test.ts` (pure helpers, resolution), `mcp.test.ts` (the stdio server driven by an MCP client: strict schema, roots, exit on stdin close) and `edit-file.test.ts` (every op across TS, TSX, Python, Go, Rust, Java; grammar gaps; guards; CRLF/BOM; symlinks; the compare-and-swap race; a live codegraph index when the CLI is installed). `eval/` holds an A/B evaluation of the tool on real commits (README, pre-registered hypothesis in RESULTS.md).

## Graphcoder (`packages/graphcoder-*`)

Code structure (semantic identity, ArchDiff, annotations, module map, rules, flows) as a separable unit: Graphcoder never imports Sovereign, and Sovereign wires it in through ports. It could move to its own repo with a small standalone host and the same router. The port is phased; P0 (boundary and core), P1 (the structure of a change, on Forge PR cards), P2's concept map (no Canvas2D block view yet) and P1b (concept impact) are in.

| Package | Holds | Deps |
| --- | --- | --- |
| `graphcoder-core` | Pure TS, no I/O: graph types, `sha256Hex`, semantic identity, ArchDiff v2, annotation store v3 + kind registry, edge hygiene, manifests, the structure of a change (`structure/`), the concept tree, map and impact (`concepts/`), the ports, the contract types | none |
| `graphcoder-server` | `createGraphcoderService(ports, { cacheDir })`, `createGraphcoderRouter(service, auth)`, the read-only index reader (`./codegraph`), the indexer, the structure and concept stores (one serial job queue), `readSide`, test-case parsing, `createNodeRepoFiles` | core, express, typescript, `@colbymchenry/codegraph` 1.6.2 |
| `graphcoder-cli` | The standalone `graphcoder` binary | server (`./codegraph` only) |

- **The boundary.** No `graphcoder-*` package imports a Sovereign package other than another `graphcoder-*` one, and core imports nothing at runtime (tests may use node built-ins). Every other Sovereign package may import only `import type … from '@sovereign/graphcoder-core/contract'` (`ChangeStructure`, `ModuleTouch`, `TestRef`, `Violation`, `SymbolRef`, `StructureOf`, the concept types `ConceptTouch`, `ChangeConcepts`, `ConceptMapReport`, …). The one exception is the composition root, `packages/server/src/graphcoder.ts`, which builds the ports and mounts the router. Each graphcoder package has a `boundary.test.ts` (the scanner is `@sovereign/graphcoder-core/boundary`); core's also scans every other package for the contract-only rule. `.dependency-cruiser.cjs` carries the same rule.
- **Ports** (`graphcoder-core/src/ports.ts`): `GraphSource` (`list()` of openable checkouts, `open(repoPath)` → a read-only `CodeGraphHandle` with `stats()`, `snapshot()`, `close()`), `GitPort` (`resolve(repo, ref)` → sha or null, `mergeBase(repo, a, b)`, `fetch(repo, refs)` (`<remote>/<branch>` fetches that branch; a missing full sha is fetched from each remote), `diffRefs(repo, base, head)` = files head changes since its merge base with base, with their zero-context `hunks`, `checkout(repo, ref)` → `{ path, switchTo(ref), release() }`, `log(repo, { since, paths, limit })`), `AiPort` (`complete(prompt, { json })`; nothing calls it yet, so Sovereign does not wire one), `RepoFiles` (repo-relative `read`/`write`/`list`/`remove`: all of core's file access goes through it).
- **Sovereign's adapters** (`packages/server/src/graphcoder.ts`, `mountGraphcoder`, called once from `bootstrap.ts`). `GraphSource` lists the code index's tracked checkouts that hold `.codegraph/codegraph.db`, so it covers what code-index covers. Without the `codegraph` CLI (or with `CODEGRAPH_INDEX=off`) it lists nothing. `GitPort` runs git itself for refs, merge bases, fetches (`GIT_TERMINAL_PROMPT=0`, 2 min) and `git diff -U0 -M` (parsed by core's `parseUnifiedDiff`), `@sovereign/git`'s CLI for `log`, and `@sovereign/worktrees`' `worktreeAddDetached`. `mountGraphcoder` returns the service's `structureOf` (the Forge link, below) or undefined when off. Checkouts go under `<dataDir>/graphcoder/checkouts` and are refused when that lies inside the repo. Boot removes checkouts a crash left behind (`releaseLeftovers`). Refs starting with `-` are refused.
- **The index is read, never written.** codegraph's `CodeGraph.open` opens read-write and migrates old schemas (its `readOnly` option is ignored). `openCodegraphIndex` instead opens the SQLite file read-only through codegraph's own adapter and query builder, loaded by path, so the version is pinned exactly, as in code-edit. It refuses an index whose schema version differs from the library's (`codegraph sync` migrates an older one). The installed CLI and the library must stay on one version: check `codegraph --version` when bumping, bump `STRUCTURE_VERSION` (cached structures were computed on the old graph), and re-index every checkout (`codegraph index <path>`: a new engine fixes resolution only at index time). Reach skips `imports` edges: an import is a file-level link, and since 1.6.2 a barrel's re-exports are `imports` edges that would put every exported pair 2 apart.
- **Config:** `graphcoder: { enabled }`, default `false`, read at boot. Off, nothing is mounted (the routes 404).
- **Routes:** `GET /api/graphcoder/status` → `{ enabled: true, repos }`. `GET /api/graphcoder/repos/stats?path=<checkout>` → `{ path, nodeCount, edgeCount, fileCount, nodesByKind, annotations }`. `GET /api/graphcoder/structure?path=&base=&head=` → the `ChangeStructure`, from the cache or computed (waits). `GET /api/graphcoder/structure/cached?path=&base=&head=` never computes or fetches: `{ state: 'ready', structure }`, `{ state: 'computing' }`, `{ state: 'failed', error }` or `{ state: 'none' }`. `GET /api/graphcoder/concepts?path=[&ref=]` → the `ConceptMapReport` (below); a ref the checkout lacks is 404. A path the GraphSource does not list is 404, never opened; no path, or a ref that is empty, has whitespace or starts with `-`, is 400.
- **CLI:** `graphcoder stats [path] [--json]` opens the index of the nearest indexed checkout at or above `path` directly (no Sovereign); run it as `node packages/graphcoder-cli/dist/index.js` after a build. Exit 0 on success; 2 on errors and bad usage; 1 is kept for checks that find problems (P3).
- **Data in the repo:** `<repo>/.graphcoder/annotations/<slug>.json` (v3: `kind`, `label`, `description`, `ordered`, `members: [{ id, ref, file, note }]`, optional `module`, `status: 'proposed'`, `author: 'agent'`, `reasoning`; sorted keys, NFC, trailing newline) and `<repo>/.graphcoder/annotation-kinds.json`. Slugs are `[a-z0-9-]`; anything else is refused, so a slug never names a path outside the directory. Only v3 is read: no annotation file in use is older. `<repo>/.graphcoder/config.json` `{ "conceptDir": "<folder>" }` names the concept tree folder (default `mental-models`); it is read from the listed checkout, also for other commits, and a broken file is an error, not a silent default.
- **Semantic ids** hash `kind \0 name \0 normalised signature` (file and module nodes: their path). They collide for same-named symbols, so an annotation member resolves to the symbol with its id in its recorded `file`, else to the only symbol with that id, else to nothing (`createMemberResolver`).
- **ArchDiff v2:** canonical order (remove_edge, remove_node, modify, move, add_node, add_edge; ids by code unit, never `localeCompare`), `canonicalJson` (sorted keys, NFC, undefined fields dropped), `snapshotHash` over semantic ids (CodeGraph ids and lines left out). `compose` folds per node and edge: an add then a remove cancels; a remove then an add of the same identity becomes its field changes; modifies and moves merge, and one that undoes the other cancels. A chain no two real diffs can produce (add twice, remove twice, modify a removed node) throws.
- **Edge hygiene** (`createEdgeHygiene(nodes, { packages, testRanges, importNodes, keepTestSource })`): rejects with a reason (`edge-kind`, `low-confidence`, `enum-member`, `common-name`, `test-code`, `undeclared-package`, `shadowed-import`); `planned` edges get only the kind and test-code checks. `readPackages(files, paths)` maps files to their nearest Cargo.toml (with `[package]`) or package.json. Rust inline test ranges (`#[cfg(test)]`) are an input; `rustTestRanges(text)` finds them (a brace matcher that skips strings, raw strings, chars, lifetimes and nested comments). `nameNoise(edge, target)` is the enum-member and common-name rules alone.
- **The structure of a change** (`structureOf(repo, base, head)`, P1). The service resolves head and its merge base with base. A cache hit (`<cacheDir>/structure/<sha256(repo)[:16]>/<merge base>..<head>.json`, with `STRUCTURE_VERSION`; Sovereign's `cacheDir` is `<dataDir>/graphcoder`) answers at once, before any fetch. Otherwise the request joins a queue that runs one computation at a time (a second request for the same refs joins the queued one): fetch the refs, resolve again, diff, check the merge base out into one detached worktree, index it, `switchTo(head)` in the same worktree, index again, read both indexes, compute, release the worktree in `finally`. The indexer (`createCodegraphIndexer`) spawns the CLI of the pinned codegraph package (`codegraphCommand`: its `bin/codegraph`, the same build the reader loads) under `nice -n 19`.
  - **Always a full index of both sides, never the checkout's own index.** Measured on ad4m (22k nodes, 110k edges): a full index takes 4–6 s; `codegraph sync` after checking out a PR head held 373 fewer edges than a fresh index of the same tree, and seeding a worktree with a copy of the primary index then syncing took 12.9 s and drifted the same way. code-index keeps primary indexes with `sync`, so diffing one against a fresh index would show phantom edge changes. ad4m PR end to end: about 9 s computing, 12 s with the fetch, 12 ms from the cache.
  - **Symbols** (`changedSymbols`): only the files the diff touches, file, import, export and parameter nodes left out. Base and head symbols match by semantic id within a file (a renamed file maps to its old path, same-id symbols pair in line order), then by kind + qualified name within a file (a new signature), then by a semantic id unique among the leftovers (a move between files). A matched pair is modified when an ArchDiff-tracked field differs (a move included) or a changed line is its own on either side: a line belongs to the innermost symbols holding it, and a local declared in a function body gives its line to the function (`symbolsOnLines`). So a class that loses a method, blank line included, is modified too.
  - **Modules:** a side with a concept tree places each symbol on its concept page (`StructureSide.concepts`, head's map for added and modified symbols, base's for removed ones); the module id is the page file, the label its breadcrumb (`Agents › Access › Sessions`). Code no page claims, and a repo without a tree, fall back to `directoryModules(packages)`: the nearest manifest's directory, then one directory below it, a source root (`src`, `lib`) not counting (`rust-executor/src/perspectives`).
  - **Reach** (`changeReach`): the diameter of the changed non-test head symbols (the removed ones when the change only removes), the most hops between two of them on an undirected graph of `contains` links plus the dependency edges hygiene trusts. Symbols with no path between them fall into separate `parts`; `reach` is the widest part's diameter.
  - **Tests** (`testsReaching`, ported from Graphcoder's feat/test-reach and turned into one backward 0-1 search from the changed head symbols): `calls`, `instantiates` and `references` at any confidence, minus hygiene's name noise unless the calling file imports that very symbol (`testEdgeFilter`). Hops through test code cost nothing; depth 1 = the test calls a changed symbol, 0 = the change edits the test itself. vitest/jest cases come from the TypeScript compiler (`parseTestCases`; calls inside a callback are attributed by line), Rust `#[test]`/`#[tokio::test]`/… functions from `rustTestCases`; any other test-path file counts as one test.
- **Concept tree** (`concepts/tree.ts`, `readConceptTree(files, dir)` over `RepoFiles`; the format is ad4m's `mental-models/CONVENTIONS.md`). Pages are `README.md` (a node: its folder) and kebab-case `*.md` (a leaf); `CONVENTIONS.md`, `GLOSSARY.md` and other non-kebab names are tree docs, not pages. Page id = path under the folder without `.md`/`/README.md` (`''` = root); parent = nearest ancestor page; children in the order the `## Parts` list links them, then by id; pages pre-order. Per page: title (`# `), model (first paragraph after it that is not a `**Label:**` line), Why, and from `<details><summary>Where in the code</summary>` the **claims**: relative links (resolved from the page; external, absolute and in-tree links drop; `#L` anchors stripped) as `paths` with `kind` file / dir / missing, and backticked names as `symbols` scoped to the paths their bullet links (`A::{b, c}` expands, calls and generics drop, `.` reads as `::`, file names drop). `How it works` numbered lists become `flows` (a `Title:` line opens one; tables, headings and code fences are skipped).
- **Code → concept map** (`concepts/map.ts`, `createConceptMap(tree, nodes)`). D7 (Josh, 2026-10-21): a file belongs to the **deepest** page whose claims cover it (then the narrower claim, then by id); a backticked name resolves to the symbols with that name or `::`-suffix in its scope, else to the only such symbol, and stays with the page that names it (two pages naming one symbol: the deeper). `pageOf(node)` = the innermost claimed symbol holding it, else its file's page. Checks (`conceptChecks`, no LLM): coverage of indexed files (uncovered by directory), stale claims (`missing` paths), shared claims (indexed or linked files claimed by pages none of which is an ancestor of another; one finding per set of pages, under the files' common directory). `conceptDependencies` lifts hygiene-trusted edges (all dependency kinds, `imports` included) to page pairs; no cycle breaking or upward flags yet. `conceptMapReport` bundles pages with their counts, checks and dependencies.
- **Concept map route** (`concepts.ts` in the server). The checkout's own HEAD is read in place (its working tree and its own index through the GraphSource, ~0.8 s on ad4m) and never cached: both move under it. Another ref goes through the queue: detached checkout, full index, read, release in `finally`, cached at `<cacheDir>/concepts/<sha256(repo)[:16]>/<sha>.json` (`CONCEPTS_VERSION`, tree folder checked). Structures and concept maps share one `SerialQueue`, so one index runs at a time. The service's `cacheDir` is Graphcoder's cache root (Sovereign: `<dataDir>/graphcoder`; structures in `structure/`).
- **Concept impact** (P1b, `concepts/impact.ts`, `ChangeStructure.concepts`; `STRUCTURE_VERSION` 3). Each side's tree comes from its own checkout. A page file the diff adds, edits or deletes is a model shift (`page`: added / changed / removed; a leaf that becomes a folder, `x.md` → `x/README.md`, keeps its id: changed). Changed symbols land on pages through their side's map (`symbols` counts, `files`, `tests` = the tests reaching that page's head symbols; `SymbolRef.concept`). Signals: `stale-page` = own code changed, page did not; `docs-only` = page changed, no code changed in it or below it. `pages` = touched pages plus ancestors, pre-order (siblings in head's order, base-only pages after); `before` holds base's title/model/Why when the edit changed them. `summary` rolls up to the first two levels: "Shifts Agents › Executor (10 changed, 7 new), … and 13 more; touches X (code only)".
- **The Forge link.** `createForgeService({ structureOf })` (work-graph's `structure.ts`, typed by the contract only) asks after each membrane sync, for every open or draft change of a synced repo whose head is new, in the repo's first local checkout: `<remote>/<base branch>` against the head sha, one request at a time, fire and forget. A failure stays on the node and in the log, never in the sync. Nodes carry `WorkNode.structure` (`@sovereign/core` forge.ts: state, path, base, head, reach, parts, counts, and `concepts`: the concept summary line) and nothing more: full structures would bloat every graph poll, and the cache already lives in Graphcoder. After a restart the first sync reads every structure back from the cache. The client's `features/graphcoder/` (own `api.ts`, the cache-only route) renders the PR card's Structure section and the Kanban card's reach badge (its tooltip carries the concept line); the forge feature imports those two components and nothing else from it. The Structure section shows concept impact as skim (the summary line) → grok ("Concepts (n)": the pruned tree, each page marked new / changed / removed / code, with stale page? / docs only, model and Why before → after) → master (a page's symbols, tests, files) (`ConceptImpact.tsx`), and a "Concept map" fold that loads `ConceptTree.tsx` (the P2 Code view: nested outline with files, symbols and check badges per page, coverage, uncovered directories, what each page uses) at the change's head only when opened. Core's boundary test holds `features/graphcoder/` to its own files, solid-js and the Forge and contract types.
- **Tests:** core ports the reference suites (identity, diff, hygiene) plus new ones (compose rules, store, kinds, sha256 against node:crypto). Server and CLI tests index `graphcoder-server/test-fixtures/tiny-ts` (or inline files) with the real `codegraph` CLI and skip without it. `packages/server/src/graphcoder.test.ts` covers the adapters on temp git repos and `mountGraphcoder` on and off. Wind-tunnel **s48** makes `/app/.wt-fixtures/graphcoder` (the fixture, committed and indexed at image build) an org root. It waits for the code index to list it, then checks status, stats and the 404/400 refusals. For that, the image puts the codegraph CLI bundled with `@colbymchenry/codegraph` on PATH, which turns the code index on in the container, and sets `CODEGRAPH_MCP=off` so sessions keep their tool set, plus `DO_NOT_TRACK=1`. **s49** computes the structure of the fixture's `structure-base..feature` change (branches built at image build from `wind-tunnel/fixtures/graphcoder-change/*.patch`: patches, since `*.test.ts` stays out of the build context) and reads it back from the cache; the runtime image has `git` for it. `graphcoder-server/src/structure.test.ts` covers the same change with the real CLI, plus the cache, the queue, failures and the routes; `work-graph/src/structure.test.ts` the Forge hook. Concepts: core's `concepts/*.test.ts` run on a small shop tree in memory (`concepts/fixtures.ts`); `graphcoder-server/src/concepts.test.ts` builds `fixtureWithConcepts()` (tiny-ts plus a tree, a change that adds code under an unchanged page, rewrites a model and adds a page) and checks the route, the worktree path, the cache, the config folder and the impact through `structureOf`; `client/src/features/graphcoder/concept-model.test.ts` the view helpers. No wind-tunnel scenario covers concepts yet.
- **Measured on ad4m** (`docs/mental-models` at 2ac6e7d49, Oct 2026): 75 pages, 73 owning code, 583 path and 785 symbol claims (606 symbols resolved, 78 names unresolved), 71 flows, coverage 1,220 of 1,229 indexed files (99.3 %), 0 stale links, 143 shared-claim findings over 800 files (mostly directory claims from pages in different branches, e.g. `core/src/generated/api` claimed by Capabilities, RPC API and TypeScript SDK), 743 concept dependencies. Against `docs/mental-models-identity-epic` (84611f907, a docs-only branch): 102 page entries (35 new, 61 changed, 6 removed; git shows 38 A / 9 D because three leaves became folders), all docs-only, and 103 stale links on the head side (pages describing code not on that branch).
