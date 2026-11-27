# Holonic task system (`packages/tasks/`)

Cross-thread task coordination via a holonic DAG, and the backbone of Forge's work graph. Tasks form many-to-many parent/child relationships (a holon acts as both whole and part). A **work stream** is a task flagged `isStream`; its members are its children, and streams nest as trees (one parent stream each; a PR or issue has one owning stream: `ownedByOneStream`). Tasks persist in the `sovereign-forge` AD4M perspective (clean slate: the old `hex-tasks` perspective is neither read nor migrated).

## Architecture

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

`createForgePersistence({ ad4m, dataDir })` (bootstrap.ts) builds the task store and the Forge meta store (saved `ForgeView`s, `RelatedEdge`s, `NodeCategory`s and `Decision`s, meta.ts) over one perspective. The server wires it in place of the old in-memory store.

**The work graph's one way in: `TaskPort`.** The contract lives in `@sovereign/core` (forge.ts, "Task port"), so tasks implements it without depending on work-graph. `createForgeTaskPort({ service, meta })` (`forge-port.ts`) binds it: task writes go through `TaskService` (sourceThreadId `forge`), so every Forge-driven change emits the `task.*` events the TaskDigest and presence read; views and suggested edges go to the meta store. Provider status maps both ways (`statusOf` / `withStatus`): a field the work graph did not read keeps its stored value. View ids are the client's, stored as `forge-view://<membrane>/<id>` with a `position`, so a membrane's list keeps its order. A task with no membrane joins the one that asks for it (`ensureTask`). `packages/work-graph/src/task-port.contract.test.ts` holds this port to the contract (including a restart through the snapshot), and the work graph's tests run on it (`createTestTaskPort` in `testing.ts`).

## Ontology (`ontology.ts`, namespace `forge://`)

SHACL subject classes, registered when the perspective is first opened (`ad4m-perspective.ts`):

| Class | Subject | Properties |
| --- | --- | --- |
| `Task` | `task://<uuid>`, `rdf://type forge://Task` | name, state, transientState, description, tag (many), createdAt, updatedAt, threadId, membrane, providerKind, providerKey, provider (JSON), subtask (many, IRI) |
| `WorkStream` | a Task that also has `rdf://type forge://WorkStream` | as Task |
| `RelatedEdge` | `forge-edge://<uuid>` | from, to (work-graph node ids), kind (default `related`), accepted, reason, confidence, source (`sync` \| `rethink` \| `user`), membrane, createdAt |
| `ForgeView` | `forge-view://<membrane>/<view id>` | membrane, title, repo (many), filters (JSON), height, position |
| `NodeCategory` | `forge-category://<membrane>/<source>/<node id>` (encoded) | membrane, node, category, source (`rethink` \| `user`), reason, createdAt |
| `Decision` | `forge-decision://<membrane>/<uuid>` (membrane encoded) | membrane, question, context, options (JSON), origin (the source, JSON), group, threadId, decisionStatus (`open` \| `resolved`), resolution, resolved, createdBy, createdAt |

Subtasks are one `forge://subtask` link per pair, parent → child. Values are AD4M string literals. The perspective is found by the uuid cached in `<dataDir>/tasks/forge-perspective.json`, else by name, else created. A cached uuid that the executor does not list is treated as not loaded yet for `missGraceMs` (2 minutes): `connect()` throws and the durable stores retry. Right after a restart the executor lists perspectives it has not loaded yet as missing, and creating one then orphaned the real store (2026-10-31, after a power cut).

## Resilience (`durable.ts`)

The AD4M executor is not always up, so every store keeps an in-memory copy:

- **Reads** always come from memory.
- **Writes** apply to memory, append to `<dataDir>/tasks/outbox.jsonl` (write-ahead), then replay to AD4M in order. The outbox is rewritten (tmp + rename) after each replay pass, so a crash mid-replay replays ops AD4M already holds. Every op is idempotent on the perspective (a property write removes that property's links first; a subtask link is removed before it is added), so that never duplicates links.
- **Replay** runs on every write, on AD4M's reconnect signal (`onConnected`), and every 15 s while anything is pending. An op AD4M rejects while it still answers pings is retried, then moved to `outbox.jsonl.dead.jsonl` after 5 attempts.
- **Restart**: the copy loads from `<dataDir>/tasks/snapshot.json` (tmp + fsync + rename, debounced) plus the outbox, then from AD4M once it answers: AD4M is the source of truth, with pending ops applied on top.
- **Seeding**: a snapshot written without AD4M (AD4M not configured) or for another perspective uuid is pushed into the perspective on first connect, so turning AD4M on, or a recreated perspective, loses nothing.
- **Without AD4M configured** the snapshot alone is the store.
- The meta store does the same with `meta-outbox.jsonl` / `meta-snapshot.json`. `GET /api/tasks/store-status` shows both (`backend`, `pending`, `loadedFromBackend`, `lastError`, ...).

## Providers

```
{ kind: 'change', refs: ForgeRef[], url, status, checksStatus, reviewDecision, unresolvedComments, failedChecks?, lastPolledAt }
{ kind: 'issue',  refs: ForgeRef[], url, issueState, closedReason?, unresolvedComments?, lastPolledAt }
{ kind: 'plan',   project, path, status }
```

`refs[0]` is the primary ref; the provider key is `refKey(refs[0])` (`@sovereign/core` forge.ts) or `plan:<project>/<path>`. Only one task may hold a key. The pre-Forge `{ kind: 'github-pr', repo, number, prStatus, ... }` shape converts to `change` wherever it is read (snapshot, outbox, AD4M, API input). The status fields are written by the work graph (see Tracked items in `packages/work-graph/AGENTS.md`); the tasks package polls nothing itself (`pr-poll.ts` is gone).

## Filters

`list` (and `GET /api/tasks`, `task_list`) filters by state, threadId, parentId, rootsOnly, **membrane**, **repo** (`owner/name`, case-insensitive), **workstream** (a stream's id: every task below it, through nested streams), **providerKind** (`change` \| `issue` \| `plan` \| `none`) and isStream. A task's membrane defaults to the creating thread's `membraneId`.

## MCP tools and routes

Sovereign tools: `task_create` (`stream`, `membrane`), `task_update` (a `threadId` on a PR or issue task also sets the forge assignee, and moves a pending task to in progress: the work graph follows the `task.reassigned` event), `task_get`, `task_list` (Forge filters above), `task_link`, `task_unlink`, `task_subscribe`, `task_summary`, `task_import`, `task_send_prompt`. Registered in `packages/agent-backend/src/claude-code/mcp-server.ts` via `TaskMcpDeps`. The Forge's `decision_open` / `decision_close` sit beside them (see Decisions in `packages/work-graph/AGENTS.md`).

`task_import { ref | url | plan, threadId?, parentTaskIds?, tags?, prompt?, membrane? }` replaces `task_import_pr` (`import.ts`). `ref` is a refKey (`github:github.com/owner/name#123`) or `owner/name#123`; `url` a GitHub PR or issue URL; `plan` `{ project, path, name? }`. A refKey does not say PR or issue, so the importer asks GitHub (`gh api repos/<repo>/issues/<n>`, `pull_request` set for PRs) unless the item is already tracked. Imports are idempotent (`created: false` returns the existing task; a task with no membrane takes the importer's); with `threadId` the task is assigned and the thread gets a prompt. A PR's title and state come from `gh pr view`; from then on the work graph reads it (CI, reviews, merge) within a second of the import and at every open poll. When the membrane (the import's, else the known task's; none: `"*"`) has a `forge.trustedAuthors` list, the importer first reads the item's author (`gh api repos/<repo>/issues/<n> --jq .user.login`) and refuses one not on it before anything else is read or stored: `<repo>#<n> by <login>: author not in forge.trustedAuthors` (403 on `POST /api/tasks/import`).

REST: `GET/POST /api/tasks`, `GET/PATCH /api/tasks/:id`, `POST /api/tasks/link`, `POST /api/tasks/unlink`, `GET /api/tasks/streams`, `POST /api/tasks/import`, `GET /api/tasks/store-status`, `POST /api/tasks/:id/poll` (re-reads the task's PR or issue through the work graph). Tasks have no delete; cancel them. Forge views and suggested edges are served by the work graph's routes only (`/api/forge/views`, `/api/forge/edges/...`, membrane-scoped, through the TaskPort).

## Tests

`store.contract.test.ts` runs one contract against the in-memory store, the resilient store without AD4M and the resilient store over a fake perspective (`testing/helpers.ts`: it can go down, hang mid-replay or reject ops). `resilience.test.ts` covers the outbox, ordered replay, crash mid-replay, snapshot restarts, seeding and legacy data; `ad4m-perspective.test.ts` the SDK adapter against a fake client. `ad4m.integration.test.ts` runs against a real executor only with `SOVEREIGN_AD4M_IT=1 SOVEREIGN_AD4M_HOST=… SOVEREIGN_AD4M_TOKEN_FILE=…`; it creates and removes its own `sovereign-forge-it-*` perspective. Wind-tunnel s44 restarts the container and checks the graph (and a membrane's ordered views); with `--ad4m` it also stops the AD4M node mid-run. `forge-port.test.ts` covers the status mapping.

## Task states

`pending` → `in_progress` → `completed` | `cancelled`, plus `paused` (set aside: neither in flight nor unassigned work in `summary()`; a work stream's "paused" epic status). A paused PR or issue task still completes or cancels when its item merges or closes. The task MCP tools take every state (`TASK_STATES`; agent-backend keeps its own copy because it does not depend on `@sovereign/tasks`).

## Digest migration (Wave 4 — complete)

TaskDigest replaced PresenceDigest as the sole operational-context injection. The PresenceDigest's `chat.turn.completed` listener gets disposed at bootstrap. WatchStore and its MCP tools (`presence_watch`, `presence_unwatch`, `presence_watched`) have been fully removed.

Task events never wake the internal thread on their own: TaskDigest entries ride along with its next external trigger. A wake per `task.state_changed` / `task.created` (removed 2026-10-17) turned every Forge sync into an internal turn that told the user nothing; owner threads get Forge's notices, and Forge rethink posts the one "needs your attention" list.
