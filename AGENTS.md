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

Cross-thread task coordination via a holonic DAG, and the backbone of Forge's work graph. Tasks form many-to-many parent/child relationships (a holon acts as both whole and part). A **work stream** is a task flagged `isStream`; its members are its children, and streams nest. Tasks persist in the `sovereign-forge` AD4M perspective (clean slate: the old `hex-tasks` perspective is neither read nor migrated).

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

### Ontology (`ontology.ts`, namespace `forge://`)

SHACL subject classes, registered when the perspective is first opened (`ad4m-perspective.ts`):

| Class | Subject | Properties |
| --- | --- | --- |
| `Task` | `task://<uuid>`, `rdf://type forge://Task` | name, state, transientState, description, tag (many), createdAt, updatedAt, threadId, membrane, providerKind, providerKey, provider (JSON), subtask (many, IRI) |
| `WorkStream` | a Task that also has `rdf://type forge://WorkStream` | as Task |
| `RelatedEdge` | `forge-edge://<uuid>` | from, to (work-graph node ids), reason, confidence, source (`sync` \| `rethink` \| `josh`), membrane, createdAt |
| `ForgeView` | `forge-view://<uuid>` | membrane, title, repo (many), filters (JSON), height |

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
{ kind: 'change', refs: ForgeRef[], url, status, checksStatus, reviewDecision, unresolvedComments, lastPolledAt }
{ kind: 'issue',  refs: ForgeRef[], url, issueState, lastPolledAt }
{ kind: 'plan',   project, path, status }
```

`refs[0]` is the primary ref; the provider key is `refKey(refs[0])` (`@sovereign/core` forge.ts) or `plan:<project>/<path>`. Only one task may hold a key. The pre-Forge `{ kind: 'github-pr', repo, number, prStatus, ... }` shape converts to `change` wherever it is read (snapshot, outbox, AD4M, API input). `pr-poll.ts` polls GitHub `change` tasks as before (to be retired in Forge P1).

### Filters

`list` (and `GET /api/tasks`, `task_list`) filters by state, threadId, parentId, rootsOnly, **membrane**, **repo** (`owner/name`, case-insensitive), **workstream** (a stream's id: every task below it, through nested streams), **providerKind** (`change` \| `issue` \| `plan` \| `none`) and isStream. A task's membrane defaults to the creating thread's `membraneId`.

### MCP tools and routes

Sovereign tools: `task_create` (`stream`, `membrane`), `task_update`, `task_get`, `task_list` (Forge filters above), `task_link`, `task_unlink`, `task_subscribe`, `task_summary`, `task_import`, `task_send_prompt`. Registered in `packages/agent-backend/src/claude-code/mcp-server.ts` via `TaskMcpDeps`.

`task_import { ref | url | plan, threadId?, parentTaskIds?, tags?, prompt?, membrane? }` replaces `task_import_pr` (`import.ts`). `ref` is a refKey (`github:github.com/owner/name#123`) or `owner/name#123`; `url` a GitHub PR or issue URL; `plan` `{ project, path, name? }`. A refKey does not say PR or issue, so the importer asks GitHub (`gh api repos/<repo>/issues/<n>`, `pull_request` set for PRs) unless the item is already tracked. Imports are idempotent (`created: false` returns the existing task); with `threadId` the task is assigned and the thread gets a prompt.

REST: `GET/POST /api/tasks`, `GET/PATCH /api/tasks/:id`, `POST /api/tasks/link`, `POST /api/tasks/unlink`, `GET /api/tasks/streams`, `POST /api/tasks/import`, `GET /api/tasks/store-status`, `GET/POST/DELETE /api/forge/views`, `GET/POST/DELETE /api/forge/edges`. Tasks have no delete; cancel them.

### Tests

`store.contract.test.ts` runs one contract against the in-memory store, the resilient store without AD4M and the resilient store over a fake perspective (`testing/helpers.ts`: it can go down, hang mid-replay or reject ops). `resilience.test.ts` covers the outbox, ordered replay, crash mid-replay, snapshot restarts, seeding and legacy data; `ad4m-perspective.test.ts` the SDK adapter against a fake client. `ad4m.integration.test.ts` runs against a real executor only with `SOVEREIGN_AD4M_IT=1 SOVEREIGN_AD4M_HOST=… SOVEREIGN_AD4M_TOKEN_FILE=…`; it creates and removes its own `sovereign-forge-it-*` perspective. Wind-tunnel s43 restarts the container and checks the graph; with `--ad4m` it also stops the AD4M node mid-run.

### Task states

`pending` → `in_progress` → `completed` | `cancelled`

### Digest migration (Wave 4 — complete)

TaskDigest replaced PresenceDigest as the sole operational-context injection. The PresenceDigest's `chat.turn.completed` listener gets disposed at bootstrap. WatchStore and its MCP tools (`presence_watch`, `presence_unwatch`, `presence_watched`) have been fully removed.

A debounced proactive-wake listener (`task.state_changed`, `task.created`) forwards a trigger message to the internal thread so TaskDigest entries surface immediately — not deferred until the next external event.

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

- **GraphQL** `POST /graphql` (or `/api/graphql`), dispatched by operation name: `ForgeChanges`, `ForgeIssues`, `ForgeBranches` (the queries in `packages/forges/src/queries.ts` — rename one and the mock answers with an error). Ordered by `updatedAt` desc, `first` ≤ 100, cursors, `states`, issue `since`. A missing repo answers `NOT_FOUND`, as GitHub does.
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

s43 drives the adapter from the runner against this container (there are no Forge server routes yet): mapping, paging and `since`, assignee writes, ETag 304s, retries over injected 502s and a `Retry-After`, merge → issue closed.

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
- **Subagents: `agents_spawn` (Sovereign's runner).** `spawnSubagent` (claude-code backend) starts the child as its own Claude Code session (own CLI process) in the `cwd` the parent passes, keyed by a fresh UUID with `parentSessionKey` set. Any session with a parent gets the slim context in `startSessionLoop`: the raw system prompt is `<configDir>/SUBAGENT.md` + the nearest repo `AGENTS.md`/`CLAUDE.md` + an environment block (`subagent-runner.ts`); no `claude_code` preset, no global CLAUDE.md, no membrane, `settingSources: ['local']`, `tools` = Read/Write/Edit/Bash/Grep/Glob (no Agent, so no nesting). MCP: `codegraph`, `semble` (merged from `~/.claude.json`, which `'local'` skips), `code`, and the narrow `/api/mcp/subagent` endpoint. The call returns at once; when the child's turn ends (its `result`, not the Stop hook's earlier idle; or its CLI exits), `finishRun` emits `subagent.completed`/`subagent.failed` with `parentMessage`, and `wiring.ts` delivers it into the parent thread through the cron path (`handleSend`, system card, queued while busy). Limits: 4 running per parent, 60 min timeout, `agents_stop` ends a run; stop and timeout abort the child's CLI rather than interrupt it. An error result fails the run even after some text. A run cut off by a restart (`run` persists in the session state store) sends a failure message after rehydrate; children stay out of `active-sessions.json`, so the resume orchestrator never continues one. Local-LLM threads have no `agents_spawn`.
- **Subagent cards.** The parent message format lives in `@sovereign/core/subagent-result` (`formatSubagentResult` / `parseSubagentResult`). History turns get `kind.variant: 'subagent-result'` from `classify.ts`; the live turn the chat module synthesizes stays raw, so the client's `subagentResultOf` handles both and `ChatView` renders `SubagentResultCard` (status, minutes, report as markdown, "Open session"). The `agents_spawn` tool call itself renders the live `SubagentCard` (`extractSubagentSpawns` reads the MCP `[{ type: 'text' }]` result).
- **Built-in `Agent` tool.** Main sessions still have it. Its in-process subagents use the parent's API endpoint, so an `~/.claude/agents/*.md` definition whose `model:` names a non-Claude model fails every call with HTTP 404 under a Claude parent; the backend warns at startup (`findUnreachableAgentModels`). Sovereign no longer seeds an agent definition.

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

- **Adapter** (`github.ts`, `createGithubForge`): lists over GraphQL (`queries.ts`: `ForgeChanges`, `ForgeIssues`, `ForgeBranches`), single reads and the one write (`setAssignees`) over REST. Lists run newest-updated first; items updated at or after `until` are skipped, and paging stops at the first item older than `since`. `state: 'open'` asks for OPEN only. PR bodies pass through unchanged ("Paired with" blocks are the graph builder's job).
- **Cost (measured on a 300-PR repo, Oct 2026):** a 50-PR page of `ForgeChanges` costs 4 points and takes ~4 s; a 100-PR page costs 7 and takes ~6 s, so the default page is 50 (`pageSize`). `onPage` reports each page's cost and time. The rollup state comes with the list; failed check names only from `checks(ref)` (contexts per PR would multiply the cost).
- **Transport** (`transport.ts`): REST base `apiUrl` (default `https://api.github.com`, or `$SOVEREIGN_GITHUB_API_URL`), GraphQL at `<apiUrl>/graphql` (`/api/graphql` for an Enterprise `/api/v3` base). Token: `token` option, `$GITHUB_TOKEN`, `$GH_TOKEN`, then `gh auth token` (cached; re-read once on a 401). Retries: 5xx, network errors, GraphQL `RATE_LIMITED`, and 403/429 rate limits, backing off 1 s doubling (capped at `maxWaitMs`, 60 s) or the server's `Retry-After` when longer; a spent primary limit whose reset is further off than `maxWaitMs` fails at once. REST GETs keep an ETag per URL (500 entries) and reuse the body on 304.
- **Registry** (`registry.ts`, `createForgeRegistry`): `forgeFor(host | { forge, host })` builds one adapter per (forge, host). A self-hosted GitHub host listed in `hosts` gets `https://<host>/api/v3`; `githubHosts` overrides options per host. Other forges need a factory.
- **Discovery** (`discovery.ts`): `discoverRepos(paths, hosts?)` dedupes forge repos across checkouts and remotes; `primaryRepo(path)` is the checkout's `origin`. Both read `parseForgeRemotes` in `@sovereign/orgs`, which reads a linked worktree's remotes from the main repo's config (`.git` file → `gitdir` → `commondir`) and takes a host → forge map. `parseGitRemotes` keeps its GitHub + Radicle shape for the issues, drafts and review packages.
- **Backfill paging:** `pageChanges` / `pageIssues` (optional on `Forge`, implemented by GitHub) read one page at a cursor, all states, skipping items at or after `until`. The work graph persists the cursor.

## Forge work graph (`packages/work-graph/`)

Per membrane: which repos, what happened in them, and who works on what. `createForgeService` is wired in `bootstrap.ts` behind `forge.enabled` (read at boot).

- **Scope** (`scope.ts`): membrane → `workspaceIds` (orgs) → projects → remotes (`discoverRepos`), plus `forge.repos[<membrane>]`. GitHub only for now. Plan dirs: absolute `forge.planDirs` entries serve every membrane; relative ones resolve under the membrane's content dir, each org and each project.
- **Sync, Loop 1** (`sync.ts`, one `RepoSync` per repo, jobs serialized per repo; `service.ts` serializes per membrane). First run: the `windowDays` window plus every open item. Open refresh (`pollOpenMs`) and all refresh (`pollAllMs`) both re-list every open change — a check result does not move `updatedAt` — plus everything updated since the last refresh (60 s overlap); the all refresh also re-reads branches. Failed check names come from `checks(ref)` once per head sha; ahead/behind from `compare(base, head)` once per head + base sha, open same-repo changes only. Owned items (task with a thread) also get their comment count read. A backfill then reads older history one page every 3 s, resumable from the cursor in the cache; items it reads raise no events.
- **Cache:** `<dataDir>/forge/cache/<forge>_<host>_<owner>_<name>.json`, written temp-file + fsync + rename. Bodies are dropped once their `Paired with` refs are read. A cold start serves it before any forge call.
- **Builder** (`build.ts`, pure): node ids are `refKey`s (`github:github.com/o/r#N`, branches `…@name`), `plan:<project>/<rel path>`, `task:<id>`. `base` resolves a base branch to the change whose head it is (open first, then newest; fork heads excluded), else a branch node; merged changes get `merged-into`. Timeline cross-references point from the mentioning item; a `closes` edge suppresses the `references` edge between the same pair. Edges to nodes outside the membrane are dropped. Streams are lanes, not nodes. The served window holds past nodes that ended in `[since, until)` and, when `until` reaches now, everything open.
- **Plans** (`plans.ts`): title = first heading, `Status:` → planned / in_progress / done. A bare `#N` links only when the file names one repo in plain text or has a `Repo:` line — an `owner/repo#N` reference names an item, not the file's repo. Rescanned on each sync and on `file.changed` under a plan dir (files outside org roots get no events, so the next sync catches those).
- **Events + triage** (`events.ts`): `<dataDir>/forge/<membrane>/events.jsonl`, append-only. Rules first; what they leave open goes to the injected `classifier` (≥ 0.7 decides, below → needs-agent, no answer → needs-agent). Coverage per tier in `/api/forge/status`. `digest(membrane, since)` is Loop 2's input; `rethink` passes it to the injected `runRethink` and moves the cursor in `state.json`.
- **Tasks** go through the `TaskPort` interface (`types.ts`). Until the tasks package binds it, bootstrap uses `createMemoryTaskPort` (snapshot in `<dataDir>/forge/tasks.json`, emits the same `task.*` events as TaskService). `task-sync.ts` writes status, state (plan §7.3, forward only; a reopen moves a terminal task back) and the `transientState` line, and sends pr-poll's thread notifications (CI red, review, merge, new comments) as system cards. pr-poll still runs beside it.
- **Assignees:** assign adds only the membrane's identity (`forge.identities.github`, else the adapter's `/user`) and records it in `state.json`; unassign removes only an identity Forge added. A marker whose identity disappeared on GitHub is dropped on the next sync.
- **Overlay** (`overlay.ts`): task `threadId` → thread status; subagent `cwd` (`SessionSummary.cwd`) → `primaryRepo` + `git branch --show-current` → the change with that head; CI watches → waiting. Unmatched subagents are listed, not guessed. Pushed as `forge.overlay` when it changes (10 s poll, plus `chat.status` / `subagent.*` / `task.reassigned`).
- **Config:** `forge.githubApiUrl` / `forge.githubToken` point github.com at another API (the wind tunnel's mock). `/api/config` returns config as stored, so keep a real token out of `githubToken`; the default (`gh auth token`) needs none.
- **Wind tunnel s45** turns forge on in `docker/config.json` (membrane `forge-wt`, two mock repos) and drives `/api/forge*` end to end.

### Decision-model tier (`classifier.ts`)

- `forge.classifier: { url, model?, timeoutMs? }` (default timeout 5 s). Without it, nothing is classified: whatever the rules leave open goes to Loop 2 as needs-agent (tier `unavailable`). The getter is read on every call, so `PATCH /api/config` applies at once.
- One `POST <url>/v1/systemone` per unclear event (llama.cpp's decision-model endpoint, TypeSafe-compatible): `{ model?, state, questions: { triage: { type: 'choice', instructions, criteria: { 'needs-agent', info } } } }`. `state` is a compact text: the event type and detail, then the node card (title, state, CI, reviews, branch, assignees, owned or not).
- The confidence triage compares with 0.7 is `answers.triage.probabilities[choice]`. The response's own `confidence` is 0 when all options are equally likely, so for two options it is no probability; it serves only as a fallback.
- An HTTP error, a timeout, a transport error or a malformed answer returns no answer and quiets the classifier for 60 s, so a dead model server never slows a sync down. It never throws into sync.

### Loop 2 — rethink (`rethink.ts`, `rethink-schedule.ts`, `rethink-routes.ts`)

- **Thread.** Each membrane has one thread labelled `forge-rethink`, found by label or created, with its id in `<dataDir>/forge/<membrane>/rethink/state.json` (and the card notes beside it).
- **Run.** `POST /api/forge/rethink?membrane=` or a schedule slot calls `service.rethink`. An empty digest skips the run (`{ ran: false }`). Otherwise `runRethink` opens a run, sends the prompt to the thread as a queued system card and returns `{ runId }`. A second run while one is open is refused (409). The run closes on the thread's first idle after it was busy: a thread busy at the start goes idle once before the prompt's turn starts. A run left open after 30 min closes as `timed-out`. A run report shows `running` from the start and gets rewritten after each action.
- **Prompt** (`buildRethinkPrompt`, snapshot-tested): the job table of plan §6.3, the limits, the six tools, the membrane's streams, and the digest grouped by stream, then node. Each node gets its id, url, card lines, owner thread (from the overlay), streams and events with their triage tier.
- **Tools** (`agent-backend/src/claude-code/forge-tools.ts`). The tools are registered only in a membrane's forge-rethink thread, bound late through `ForgeMcpDeps` the way `ci_*` is. Every call names its `membrane`, which must match the thread's.
  - `forge_relate`: a `related` edge, `source: 'rethink'`, via `service.relate` → `TaskPort.addRelated`. It is drawn dashed until accepted.
  - `forge_stream_add`: `service.addMember`.
  - `forge_dispatch`: sends `[Forge rethink · <run>] <ref> …` plus the prompt to the owner thread or a given `threadId`. A node with no owner gets a new thread only when it is in a stream (`service.assign` with `newThread`); otherwise the call is refused.
  - `forge_bug_draft`: a `packages/drafts` draft (labelled `bug`, evidence appended, org and project resolved from the repo's checkout by `projectOfRepo`). It never posts to the forge; the user publishes it.
  - `forge_attention`: ONE message per run to the presence (gateway) thread.
  - `forge_note`: a note on the card.
  - Each dispatch, draft, attention item and note lands in `WorkNode.rethink` (`RethinkNote`, last 20 per node), which the card shows under "Rethink notes".
- **Chat runs.** A tool call in the rethink thread with no run open (the user talking to it) opens a `chat` run that closes when that turn ends, so every action gets a report and counts against the limits.
- **Limits.** At most `forge.rethink.maxJobs` dispatches per run. The token budget (`tokenBudget`) counts the run's fresh tokens: input + cache writes + output of every API call since the run started, read from the session JSONL (`usageSinceFromFile`, once per message id). Cache reads are reported but do not count. Once the budget is spent, dispatches are refused. Refusals return `{ refused }` to the model and are listed in the report under "Refused" and "Limits".
- **Reports:** `<dataDir>/forge/<membrane>/rethink/<YYYY-MM-DD-HHMM>.md` in local time (`-2`, `-3`… on a clash), with a `.json` beside each. A report gives the status, the trigger (`schedule` / `manual` / `chat`), the digest size and items, the actions by kind, the limits hit and the token usage. `GET /api/forge/rethink/runs?membrane=` returns `{ threadId, active, runs }`, newest first. `GET /api/forge/rethink/runs/:id?membrane=` returns the markdown. The bus event `forge.rethink { membrane, runId, status }` reaches the WS channel `forge`.
- **Schedule.** The server's scheduler holds one system job per (membrane, `forge.rethink.times` entry), as the cron `MM HH * * *` in local time with payload `kind: 'forge-rethink'`. `reconcileRethinkJobs` keeps matching jobs, so their run history survives. It runs at start, on every `config.changed` under `forge`, and every 5 min. With forge off it removes all the jobs. A due job runs `service.rethink(membrane, { trigger: 'schedule' })` and answers `scheduler.job.completed` / `failed`.
- **Client.** "Rethink now" shows running, skipped (empty digest), done (actions, limits hit) or failed (`rethink-model.ts`). "Last rethink" opens `RethinkReport.tsx`, which renders the run reports with a run list and opens the rethink thread.
- **Wind tunnel s47** adds membrane `forge-rt` and repo `acme-labs/sprocket` at runtime (`PATCH /api/config`). It turns an owned change CI-red and runs a rethink. Then it checks the thread, the prompt at the mock LLM, the report, a scripted `forge_relate` edge, a `forge_note` from a chat turn and the empty-digest skip.

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
- **codegraph is pinned (1.5.0)**, because `codegraph.ts` loads its internals by path. The library reads the index the `codegraph` CLI writes, so upgrade both together: if an index format change goes unread, the "callers to check" lines silently disappear from edit reports.
- **Affected tests** come from `codegraph affected` at depth 1 (direct importers), stepping out to depth 2 only when there are none. The CLI's default depth of 5 lists every test that reaches the file at all.

Tests: `text.test.ts` (pure helpers, resolution), `mcp.test.ts` (the stdio server driven by an MCP client: strict schema, roots, exit on stdin close) and `edit-file.test.ts` (every op across TS, TSX, Python, Go, Rust, Java; grammar gaps; guards; CRLF/BOM; symlinks; the compare-and-swap race; a live codegraph index when the CLI is installed). `eval/` holds an A/B evaluation of the tool on real commits (README, pre-registered hypothesis in RESULTS.md).
