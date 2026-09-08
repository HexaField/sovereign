# Holonic Task Ontology — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-09-08

Operational task graph backed by an AD4M perspective. Replaces the WatchStore + PresenceDigest text-summarisation pipeline with structured, observable, cross-thread task state. The presence system shifts from passively accumulating lossy text snippets to reading a live task graph and reacting to state transitions.

Requirements use MUST/SHOULD/MAY per RFC 2119.

---

## Motivation

### The problem today

The presence-internal thread's awareness of other threads runs through a three-stage pipeline:

1. **WatchStore** (`packages/presence/src/watch-store.ts`) — a persistent set of thread IDs the internal thread has chosen to watch. JSON file on disk.

2. **PresenceDigest** (`packages/presence/src/digest.ts`) — listens on the bus for `chat.turn.completed` events. When a watched thread's assistant produces output, the digest strips markdown, extracts the first sentence, clamps to 120 characters, and appends a `DigestEntry` to a capped buffer (50 entries). Persisted to `presence-digest.json`.

3. **Passive delivery** — when the internal thread next receives _any_ inbound message (AD4M mention, cron, forwarded context), the chat module calls `digest.take()`, prepends the accumulated entries as a `[Thread activity since last interaction]` block, and clears the buffer.

This architecture has three structural weaknesses:

**Lossy.** `summariseAssistantContent()` strips code blocks, reduces markdown to flat text, then truncates to the first sentence or 120 characters. A subagent that spent 10 minutes implementing a feature gets reduced to one fragment of whatever its final assistant turn happened to say first.

**Passive.** Entries queue silently until something else wakes the internal thread. If a subagent finishes critical work at 2pm and nothing triggers the internal thread until 5pm, that completion sits unseen for three hours.

**Thread-centric, not work-centric.** The WatchStore tracks _threads_. But what matters tracks _work_. Watching a thread captures everything it outputs — thinking-out-loud, tool call noise, error messages — alongside the actual state transitions that matter.

### What this spec does

Replace the observation unit from "what threads _said_" to "what threads _work on_". Threads declare structured tasks, update state as they go, and the presence system reads a live task graph instead of parsing compressed text.

Claude Code's built-in task tools (`TaskCreate`, `TaskGet`, etc.) track work within a single session. They vanish when the session ends. No other thread can see them. The holonic task ontology stores tasks in AD4M — persistent, cross-thread, observable, subscriptable.

### What holonic means here

A holon functions simultaneously as a whole and as a part. A task can contain subtasks (it acts as a whole) and belong to multiple parent tasks (it acts as a part). The structure forms a directed acyclic graph — not a tree. A single implementation task might serve two different feature efforts. A research spike might feed three separate design tasks.

Many-to-many parent/child. No single root. Multiple perspectives on the same work.

---

## Design Principles

1. **AD4M as source of truth.** Tasks live as subject-class instances in a private AD4M perspective. Links encode relationships. The perspective survives restarts, compaction, session loss. AD4M's auto-generated MCP tools provide the raw CRUD surface.

2. **Sovereign tools as the agent interface.** Thin wrappers around AD4M that add thread-awareness, bus events, and subscription semantics. Agents call `sovereign.task_*` tools, not raw AD4M tools.

3. **Tasks replace thread-watching.** The WatchStore + PresenceDigest pipeline gets subsumed. Instead of watching threads and summarising their output, the presence system observes structured task state. The unit of observation shifts from threads to tasks.

4. **Push and pull.** Two complementary mechanisms:
   - **Push:** task mutations emit bus events; waker subscriptions fire messages into subscribing threads. No waiting for a coincidental trigger.
   - **Pull:** `task_summary` gives any thread a snapshot of what runs in flight, what completed recently, what sits unassigned.

5. **Transient state for live observability.** Each task carries a freeform `transientState` string (e.g. "running tests", "waiting for CI", "reviewing diff"). Updated frequently, read by any thread that cares. Not persisted to daily notes — ephemeral by design.

6. **Simple schema, versatile relationships.** The Task model has few properties. Complexity lives in the link graph, not in the data model.

---

## Data Model

### Task Subject Class

Registered in a dedicated `hex-tasks` AD4M perspective via `add_model`.

```
Class:    Task
Namespace: task://

Properties (single-valued):
  name          xsd://string   required   — short imperative title
  state         xsd://string   required   — pending | in_progress | completed | cancelled
  threadId      xsd://string              — sovereign thread UUID currently working this
  description   xsd://string              — what needs doing (markdown)
  transientState xsd://string             — live status line, updated frequently
  createdAt     xsd://string   required   — ISO-8601
  updatedAt     xsd://string              — ISO-8601, set on every mutation

Collections (multi-valued):
  parentTasks   IRI collection            — holonic: tasks this task belongs to
  childTasks    IRI collection            — holonic: tasks contained by this task
  tags          xsd://string collection   — freeform labels
```

### SHACL Registration

```json
{
  "target_class": "task://Task",
  "constructor_actions": [
    { "action": "addLink", "source": "this", "predicate": "rdf://type", "target": "task://Task" }
  ],
  "destructor_actions": [
    { "action": "removeLink", "source": "this", "predicate": "rdf://type", "target": "task://Task" }
  ],
  "properties": [
    {
      "path": "task://name",
      "name": "name",
      "datatype": "xsd://string",
      "min_count": 1,
      "max_count": 1,
      "writable": true,
      "setter": [{ "action": "setSingleTarget", "source": "this", "predicate": "task://name", "target": "value" }]
    },
    {
      "path": "task://state",
      "name": "state",
      "datatype": "xsd://string",
      "min_count": 1,
      "max_count": 1,
      "writable": true,
      "setter": [{ "action": "setSingleTarget", "source": "this", "predicate": "task://state", "target": "value" }]
    },
    {
      "path": "task://threadId",
      "name": "threadId",
      "datatype": "xsd://string",
      "max_count": 1,
      "writable": true,
      "setter": [{ "action": "setSingleTarget", "source": "this", "predicate": "task://threadId", "target": "value" }]
    },
    {
      "path": "task://description",
      "name": "description",
      "datatype": "xsd://string",
      "max_count": 1,
      "writable": true,
      "setter": [
        { "action": "setSingleTarget", "source": "this", "predicate": "task://description", "target": "value" }
      ]
    },
    {
      "path": "task://transientState",
      "name": "transientState",
      "datatype": "xsd://string",
      "max_count": 1,
      "writable": true,
      "setter": [
        { "action": "setSingleTarget", "source": "this", "predicate": "task://transientState", "target": "value" }
      ]
    },
    {
      "path": "task://createdAt",
      "name": "createdAt",
      "datatype": "xsd://string",
      "min_count": 1,
      "max_count": 1,
      "writable": true,
      "setter": [{ "action": "setSingleTarget", "source": "this", "predicate": "task://createdAt", "target": "value" }]
    },
    {
      "path": "task://updatedAt",
      "name": "updatedAt",
      "datatype": "xsd://string",
      "max_count": 1,
      "writable": true,
      "setter": [{ "action": "setSingleTarget", "source": "this", "predicate": "task://updatedAt", "target": "value" }]
    },
    {
      "path": "task://parentTasks",
      "name": "parentTasks",
      "node_kind": "IRI",
      "collection": true,
      "adder": [{ "action": "addLink", "source": "this", "predicate": "task://parentTasks", "target": "value" }],
      "remover": [{ "action": "removeLink", "source": "this", "predicate": "task://parentTasks", "target": "value" }]
    },
    {
      "path": "task://childTasks",
      "name": "childTasks",
      "node_kind": "IRI",
      "collection": true,
      "adder": [{ "action": "addLink", "source": "this", "predicate": "task://childTasks", "target": "value" }],
      "remover": [{ "action": "removeLink", "source": "this", "predicate": "task://childTasks", "target": "value" }]
    },
    {
      "path": "task://tags",
      "name": "tags",
      "datatype": "xsd://string",
      "collection": true,
      "adder": [{ "action": "addLink", "source": "this", "predicate": "task://tags", "target": "value" }],
      "remover": [{ "action": "removeLink", "source": "this", "predicate": "task://tags", "target": "value" }]
    }
  ]
}
```

### Link Predicates

Beyond the collection links embedded in the schema, explicit link predicates connect tasks to the broader knowledge graph:

| Predicate           | Source   | Target           | Meaning                                                   |
| ------------------- | -------- | ---------------- | --------------------------------------------------------- |
| `task://parent_of`  | Task IRI | Task IRI         | Structural containment (inverse maintained automatically) |
| `task://child_of`   | Task IRI | Task IRI         | Inverse of parent_of                                      |
| `task://depends_on` | Task IRI | Task IRI         | Ordering dependency (distinct from containment)           |
| `task://related_to` | Task IRI | hex://Entity IRI | Links a task to a knowledge-graph entity                  |

**Bidirectional maintenance.** When a Sovereign tool adds a parent/child link, it MUST add both directions: `parentTasks` collection on the child AND `childTasks` collection on the parent. AD4M stores the links; the tool layer enforces consistency.

### Perspective

- **Name:** `hex-tasks`
- **Scope:** Private, local only (never published as a neighbourhood)
- **Bootstrap:** Created on first use if absent. Schema registered automatically.
- **Separate from `hex-knowledge`.** The knowledge graph stores durable facts (entities, notes). The task perspective stores operational state that churns frequently. Separate perspectives keep query costs independent.

---

## Sovereign Tool Surface

Eight MCP tools, registered on the Sovereign MCP server. Thread identity flows from the calling session context.

### `sovereign.task_create`

Create a task. Available to every thread.

```
Parameters:
  name:          string    required
  description:   string    optional
  parentTaskIds: string[]  optional  — IRIs of parent tasks (holonic)
  tags:          string[]  optional
  autoAssign:    boolean   optional  default true — assign to calling thread

Returns:
  { id: string, name: string, state: "pending", threadId: string | null }
```

Behaviour:

- Sets `state` to `"pending"`, `createdAt` to now.
- When `autoAssign` holds true, sets `threadId` to the calling thread's UUID.
- When `parentTaskIds` contains entries, adds bidirectional parent/child links.
- Emits `task.created` on the event bus.

### `sovereign.task_update`

Update task properties. Available to every thread.

```
Parameters:
  taskId:         string   required
  state:          string   optional  — pending | in_progress | completed | cancelled
  transientState: string   optional  — freeform live status
  name:           string   optional
  description:    string   optional
  threadId:       string   optional  — reassign (null to unassign)
  tags:           string[] optional  — replaces entire tag set

Returns:
  { id: string, ...updated fields }
```

Behaviour:

- Sets `updatedAt` to now on every call.
- When `state` changes, emits `task.state_changed` with both old and new state.
- When `threadId` changes, emits `task.reassigned`.
- When `transientState` changes, emits `task.transient_updated`.
- All other mutations emit `task.updated`.

### `sovereign.task_get`

Retrieve a single task with its full relationship graph. Available to every thread.

```
Parameters:
  taskId:  string  required

Returns:
  { id, name, state, threadId, description, transientState,
    parentTasks: [{ id, name, state }],
    childTasks:  [{ id, name, state }],
    tags, createdAt, updatedAt }
```

### `sovereign.task_list`

List tasks with filtering. Available to every thread.

```
Parameters:
  state:     string   optional  — filter by state
  threadId:  string   optional  — filter by assigned thread (null = unassigned)
  parentId:  string   optional  — only direct children of this task
  rootsOnly: boolean  optional  — only tasks with no parents

Returns:
  [{ id, name, state, threadId, transientState, childCount, parentCount }]
```

### `sovereign.task_link`

Add a holonic parent/child relationship. Available to every thread.

```
Parameters:
  parentId:  string  required
  childId:   string  required

Returns:
  { linked: true }
```

Behaviour:

- Adds `childId` to parent's `childTasks` collection.
- Adds `parentId` to child's `parentTasks` collection.
- MUST reject cycles (walk parents of `parentId`; if `childId` appears, reject).
- Emits `task.linked`.

### `sovereign.task_unlink`

Remove a holonic parent/child relationship. Available to every thread.

```
Parameters:
  parentId:  string  required
  childId:   string  required

Returns:
  { unlinked: true }
```

### `sovereign.task_subscribe`

Subscribe the calling thread to task events matching a query. Available to every thread.

```
Parameters:
  taskId:   string  optional  — watch a specific task
  threadId: string  optional  — watch all tasks assigned to a thread
  state:    string  optional  — watch for transitions to this state
  query:    string  optional  — SPARQL pattern (advanced)

Returns:
  { subscriptionId: string }
```

Behaviour:

- Registers a waker subscription in AD4M that fires when matching links change.
- The waker delivers a message to the subscribing thread with the change summary.
- Subscriptions persist across restarts (stored in the perspective as links).
- A thread SHOULD subscribe to its own task changes by default on session start.

### `sovereign.task_summary`

Read-only snapshot of the operational landscape. Available to every thread (primary consumer: presence-internal).

```
Parameters: (none)

Returns:
  {
    inFlight: [{ taskId, name, threadId, threadLabel, state, transientState }],
    recentlyCompleted: [{ taskId, name, completedAt, threadLabel }],
    unassigned: [{ taskId, name, state, parentCount }]
  }
```

---

## Event Bus Integration

All task mutations emit events on the Sovereign event bus.

### Event Types

```typescript
interface TaskEvent {
  type:
    | 'task.created'
    | 'task.updated'
    | 'task.state_changed'
    | 'task.reassigned'
    | 'task.transient_updated'
    | 'task.linked'
    | 'task.unlinked'
  payload: {
    taskId: string
    taskName: string
    threadId: string | null // assigned thread
    sourceThreadId: string // thread that made the change
    // state_changed specific:
    oldState?: string
    newState?: string
    // reassigned specific:
    oldThreadId?: string | null
    newThreadId?: string | null
    // transient_updated specific:
    transientState?: string
    // linked/unlinked specific:
    parentId?: string
    childId?: string
  }
}
```

---

## Presence System Redesign

### Current architecture (what gets replaced)

```
chat.turn.completed (bus event)
    │
    ▼
PresenceDigest.onTurnCompleted()
    │ checks WatchStore.has(threadId)
    │ calls summariseAssistantContent() — strips markdown, clamps 120 chars
    │ appends DigestEntry to capped buffer (50 entries)
    │
    ▼  (passive — waits for next inbound)
digest.take() called by chat module
    │ formats "[Thread activity since last interaction]"
    │ prepends to user message
    │ clears buffer
    │
    ▼
presence-internal thread sees lossy text fragments
```

**Weaknesses:**

- `summariseAssistantContent()` loses meaning. A 50-turn implementation session reduces to one truncated sentence.
- Delivery depends on an unrelated message arriving. No proactive wake.
- Thread-centric: captures everything a thread says, including noise.

### New architecture

```
task.* (bus events from task mutations)
    │
    ├──► TaskDigest (replaces PresenceDigest)
    │       │ formats structured DigestEntry from TaskEvent payload
    │       │ no text extraction — reads taskName, state, transientState directly
    │       │ delivers on next inbound (backward-compatible path)
    │       ▼
    │    "[Task activity since last interaction]"
    │
    ├──► Waker subscriptions (new — proactive wake)
    │       │ AD4M waker fires on matching link changes
    │       │ delivers message directly to subscribing thread
    │       │ no waiting for coincidental trigger
    │       ▼
    │    presence-internal thread wakes with: "Task X → completed"
    │
    └──► task_summary (new — pull on demand)
            │ any thread calls for snapshot
            ▼
         { inFlight, recentlyCompleted, unassigned }
```

### What changes in `packages/presence/`

#### PresenceDigest → TaskDigest

The digest service retains its shape (capped buffer, `take()` → formatted block, disk persistence) but swaps its data source:

**Before:** listens on `chat.turn.completed`, checks WatchStore membership, runs `summariseAssistantContent()` to extract a 120-char fragment.

**After:** listens on `task.state_changed`, `task.reassigned`, and `task.created`. Formats entries directly from the event payload — no text extraction needed:

```typescript
bus.on('task.state_changed', (event) => {
  const { taskName, newState, oldState, sourceThreadId } = event.payload
  const label = resolveLabel(sourceThreadId) ?? sourceThreadId.slice(0, 8)
  append({
    threadId: sourceThreadId,
    threadLabel: label,
    summary: `"${taskName}": ${oldState} → ${newState}`,
    at: Date.now()
  })
})

bus.on('task.reassigned', (event) => {
  const { taskName, newThreadId } = event.payload
  const label = newThreadId ? (resolveLabel(newThreadId) ?? newThreadId.slice(0, 8)) : 'unassigned'
  append({
    threadId: event.payload.sourceThreadId,
    threadLabel: resolveLabel(event.payload.sourceThreadId) ?? '?',
    summary: `"${taskName}" → assigned to ${label}`,
    at: Date.now()
  })
})
```

The `[Thread activity]` header becomes `[Task activity since last interaction]`:

```
[Task activity since last interaction]
- main (2m ago): "Build auth module": created, assigned to subagent-3
- subagent-3 (1m ago): "Build auth module": pending → in_progress
- subagent-3 (just now): "Build auth module": running tests (4/7 passing)
[End task activity]
```

Structured, lossless, actionable. The internal thread reads precise state instead of guessing from text fragments.

#### WatchStore — deprecated for operational awareness

The WatchStore (`presence-watched.json`, `presence_watch`/`presence_unwatch` tools) currently serves as the filter for which threads feed the digest. With the task system, that filter inverts: the presence system observes _tasks_, not threads. Any thread that creates a task becomes visible automatically — no explicit watch needed.

**Migration path:**

- Wave 3 (presence integration) introduces the TaskDigest alongside the existing text digest. Both run in parallel during migration.
- Wave 5 removes the `chat.turn.completed` listener from the digest. The WatchStore remains available but stops feeding the digest. The `presence_watch`/`presence_unwatch`/`presence_watched` tools stay functional for debug/audit use but leave the critical path.

#### PresenceModule changes

`createPresenceModule()` currently composes: LastOriginTracker, WatchStore, PresenceDigest, ResponseTools. After this spec:

- **LastOriginTracker** — unchanged. Still tracks the most recent `MessageOrigin` per modality for response routing.
- **WatchStore** — retained but decoupled from the digest. No longer a dependency of the digest service.
- **PresenceDigest → TaskDigest** — new implementation. Depends on the event bus for `task.*` events. Does not depend on WatchStore.
- **ResponseTools** — unchanged. `reply_voice`, `reply_ad4m`, `reply_text` still route responses back to the correct surface.
- **TaskService** — new dependency. The module holds a reference to the `TaskService` so `task_summary` can query the perspective.

```typescript
export interface PresenceModule {
  internalThreadId(): string | null
  gatewayThreadId(): string | null
  watchStore: WatchStore // retained, decoupled from digest
  digest: TaskDigest // replaces PresenceDigest
  lastOrigin: LastOriginTracker // unchanged
  tools: PresenceResponseTools // unchanged
  tasks: TaskService // new
  forwardToInternal(text: string, opts?: { deviceId?: string }): Promise<{ delivered: boolean }>
  dispose(): void
}
```

### What changes in the internal thread's experience

**Before:**

```
[Thread activity since last interaction]
- subagent-3 (5m ago): Implemented the route handler and added validation...
- main (2m ago): Committed theme toggle changes to australia-commons-tech.
[End thread activity]

[ad4m-origin] You were @mentioned in neighbourhood...
```

**After:**

```
[Task activity since last interaction]
- main (10m ago): "Build auth module": created with 3 subtasks
- subagent-3 (5m ago): "Implement route handler": pending → in_progress
- subagent-3 (2m ago): "Implement route handler": running tests (6/7 passing)
- subagent-3 (1m ago): "Implement route handler": in_progress → completed
- main (just now): "Write integration tests": assigned to subagent-4
[End task activity]

[ad4m-origin] You were @mentioned in neighbourhood...
```

The internal thread sees _what happened_ with precision. It can make informed decisions: "All subtasks of 'Build auth module' completed — notify Josh." Or: "Task 'Design API' assigned to subagent-2 has shown no transient-state update in 15 minutes — investigate."

### Proactive wake via subscriptions

The most significant architectural shift: the internal thread no longer waits passively for a coincidental trigger.

On startup (or on task system bootstrap), the presence module registers a blanket waker subscription on the `hex-tasks` perspective for `task.state_changed` events. When any task transitions to `completed` or `cancelled`, the waker fires a message into the internal thread:

```
[task-waker] Task "Implement route handler" completed (thread: subagent-3)
```

This wakes the internal thread immediately. No 3-hour delay waiting for an AD4M mention or cron job. The task system itself becomes a wake source.

More targeted subscriptions serve orchestration:

```
task_subscribe taskId="root-1" state="completed"
→ "Notify me when all children of root-1 reach completed state"
```

The subscribing thread (presence-internal or any orchestrator) receives a message when the condition matches.

### What stays unchanged

The internal thread retains its unique role as the judgment + routing layer:

- **AD4M mentions** → still arrive via the waker → bootstrap listener → `chatModule.handleSend(internalId, text, { origin })`. Someone @mentions you in a neighbourhood, the internal thread decides whether to reply. Tasks do not replace this.
- **Response routing** → `reply_ad4m`, `reply_voice`, `reply_text` stay. The internal thread decides _how_ to surface something to you, through which modality.
- **Forwarded context** → `forwardToInternal()` from the gateway or any other surface stays. The internal thread processes explicit context pushes.
- **LastOriginTracker** → still tracks the most recent origin per modality so response tools default-target the right surface.

---

## Subscription Mechanism

Two layers work together:

### Layer 1: AD4M Waker Subscriptions

The existing AD4M waker system (`WakerSubscriptionManager` + `generate_waker_query`) watches for link changes in the `hex-tasks` perspective. When a matching change occurs, the waker fires a message into the subscribing thread.

`task_subscribe` generates a SPARQL pattern or link-pattern filter and registers it via `generate_waker_query`. The subscription ID maps to the waker subscription ID for management (cancel, list).

### Layer 2: EventBus → TaskDigest

For broad awareness (the presence thread wanting all task events), the bus listener approach works without per-task AD4M subscriptions. The TaskDigest subscribes to `task.*` events on the bus at startup. Entries accumulate and deliver on next inbound — the backward-compatible passive path.

### Layer 3: EventBus → Waker → Proactive Wake

For time-sensitive events (task completion, stall detection), the presence module registers AD4M waker subscriptions that fire messages directly into the internal thread. This combines AD4M's persistence (subscriptions survive restarts) with the bus's immediacy.

### When to use which

| Need                                                    | Mechanism                          |
| ------------------------------------------------------- | ---------------------------------- |
| Presence: broad awareness of all task activity          | TaskDigest (Layer 2)               |
| Presence: immediate wake on task completion             | Waker subscription (Layer 3)       |
| Worker thread: "notify me when parent task completes"   | Waker subscription (Layer 1)       |
| Orchestrator: "notify me when all subtasks of X finish" | Waker subscription (Layer 1)       |
| Any thread: "what runs right now?"                      | `task_summary` (pull)              |
| Dashboard / UI: live task board                         | Bus listener (Layer 2) + WebSocket |

---

## Holonic Patterns

### Decomposition

A top-level agent receives "build feature X". It creates a root task, then decomposes:

```
task_create name="Build feature X"
  → taskId: "root-1"

task_create name="Design API" parentTaskIds=["root-1"]
  → taskId: "design-1"

task_create name="Implement backend" parentTaskIds=["root-1"]
  → taskId: "impl-1"

task_create name="Write tests" parentTaskIds=["impl-1"]
  → taskId: "test-1"
```

The presence thread sees:

```
[Task activity since last interaction]
- main (just now): "Build feature X": created (root)
- main (just now): "Design API": created (child of "Build feature X")
- main (just now): "Implement backend": created (child of "Build feature X")
```

### Cross-cutting concerns

A single task can serve multiple parents:

```
task_create name="Update shared types" parentTaskIds=["feature-a", "feature-b"]
```

Both feature efforts see it as a child. Completing it advances both.

### Thread handoff

When the top-level agent dispatches a subtask to a subagent thread:

```
task_update taskId="impl-1" threadId="subagent-thread-uuid" state="in_progress"
```

The presence thread sees the reassignment immediately (via waker) or on next inbound (via TaskDigest). If the subagent stalls, the presence thread can detect it: "Task 'Implement backend' assigned to subagent-3 — no transient-state update in 15 minutes."

### Transient state as a heartbeat

Subagent threads update `transientState` as they work:

```
task_update taskId="impl-1" transientState="reading auth module..."
task_update taskId="impl-1" transientState="writing route handler"
task_update taskId="impl-1" transientState="running tests (3/7 passing)"
```

Any thread can call `task_get` or `task_list` to see live progress. The presence thread uses `task_summary` for the aggregate view.

### Stall detection

The presence-internal thread can compare `updatedAt` timestamps against wall clock. A task marked `in_progress` whose `updatedAt` sits more than N minutes in the past suggests a stalled or crashed thread. The internal thread surfaces this to the user proactively:

```
"Task 'Implement backend' (subagent-3) — no update for 20 minutes.
 Last transient state: 'running tests (3/7 passing)'. May have stalled."
```

No custom stall-detection service needed. The internal thread runs this check on wake (triggered by task wakers or cron) using `task_summary` data.

---

## Relationship to Existing Systems

### vs Claude Code Task tools

Claude's tools track in-session tasks that vanish on session end. Holonic tasks persist in AD4M, survive restarts, and cross thread boundaries. Agents MAY use both: Claude tasks for session-local scratchpad tracking, holonic tasks for cross-thread coordination.

### vs WatchStore + PresenceDigest (superseded)

The WatchStore tracks threads; the digest summarises their text output. Both get superseded by the task system for operational awareness:

| Concern             | WatchStore + Digest (current)      | Task system (proposed)                |
| ------------------- | ---------------------------------- | ------------------------------------- |
| Unit of observation | Thread                             | Task                                  |
| Data fidelity       | 120-char lossy text extraction     | Structured state fields               |
| Delivery            | Passive (waits for next inbound)   | Push (waker) + passive (digest)       |
| Filtering           | Explicit thread watch list         | Automatic (any thread creating tasks) |
| Wake mechanism      | None (piggybacks on other inbound) | Waker subscriptions fire proactively  |

The WatchStore remains available for edge cases (raw assistant output audit, threads that don't use tasks). The digest gains a parallel task-event listener that dominates in practice.

### vs Knowledge Graph (hex-knowledge)

The knowledge graph stores durable facts. The task perspective stores operational state that churns. Separate perspectives, separate lifecycles. Tasks MAY link to knowledge-graph entities (projects, people) via `task://related_to` predicates.

---

## Implementation Waves

### Wave 1: Perspective + Schema Bootstrap

- Create `hex-tasks` perspective on first use (check existence, create if absent).
- Register the Task SHACL schema via `add_model`.
- Package as a Sovereign module (`packages/tasks/`) that initialises during bootstrap, similar to how `packages/presence/` initialises.
- Export `TaskService` interface for other modules to consume.

### Wave 2: Sovereign MCP Tools

- Implement `task_create`, `task_update`, `task_get`, `task_list`, `task_link`, `task_unlink`, `task_subscribe`, `task_summary`.
- Thread identity binding: tools receive calling thread ID from session context.
- Cycle detection for `task_link`.
- Event bus emission on all mutations.
- Register tools on the Sovereign MCP server.

### Wave 3: Presence Integration

- Introduce TaskDigest alongside the existing PresenceDigest. Both run in parallel — the `[Task activity]` and `[Thread activity]` blocks both appear in the internal thread's context during migration.
- Decouple WatchStore from the digest dependency chain.
- Register blanket waker subscription on `hex-tasks` for task state transitions → presence-internal thread.
- Wire `task_summary` into the presence module.
- Update `PRESENCE.md` template to describe task-aware behaviour.

### Wave 4: Digest Migration

- Remove the `chat.turn.completed` listener from the digest service. The text-summarisation path stops feeding the buffer.
- `[Thread activity]` block disappears; `[Task activity]` block becomes the sole operational context injection.
- WatchStore tools (`presence_watch`, `presence_unwatch`, `presence_watched`) remain functional but leave the critical path. Mark as deprecated in tool descriptions.
- `summariseAssistantContent()` and related text-extraction code can be removed or retained for a debug/audit mode behind a flag.

### Wave 5: Tests

- Unit tests for TaskService CRUD, link management, cycle detection.
- Integration tests for bus event emission and TaskDigest pickup.
- Integration test: waker subscription fires message into internal thread on task state change.
- E2E test: create task in thread A, observe state change in thread B via both TaskDigest and waker subscription.
- Regression test: verify presence-internal still receives AD4M mentions and responds via `reply_ad4m` (unchanged path).

---

## Non-Goals

- **UI / client-side task board.** Valuable but separate concern. This spec covers the backend ontology and tool surface.
- **Time tracking / estimation.** No duration or effort fields. Add later if needed.
- **Priority ordering.** Tasks have state, not priority. Ordering emerges from the holonic structure and the agent's judgement.
- **Approval workflows.** No "needs review" gates. The state machine stays minimal: pending → in_progress → completed|cancelled.
- **Automatic task completion.** Agents decide when a task finishes. No automated state transitions based on heuristics.
- **Neighbourhood sync.** The task perspective stays private. Multi-user task coordination requires a separate design.

---

## Open Questions

1. **Garbage collection.** Completed/cancelled tasks accumulate. SHOULD the system auto-archive tasks older than N days? Or leave that to manual cleanup? Leaning toward a `task_archive` tool that moves old tasks to a separate collection/perspective.

2. **Task templates.** Recurring decomposition patterns (e.g. "every feature gets: design, implement, test, review"). Worth building into Wave 2, or leave for a later extension?

3. **Transient state write amplification.** High-frequency `transientState` updates generate many AD4M link mutations. Options:
   - (a) All updates go through AD4M (durable, simple, noisy).
   - (b) `transientState` lives only on the bus + in-memory map, with periodic AD4M snapshots (fast, lossy on restart).
   - (c) Hybrid: AD4M for `state` changes, in-memory for `transientState`. `task_summary` reads the in-memory map; `task_get` merges both. Leaning toward (c). Transient state matters in the moment, not across restarts.

4. **WatchStore removal timeline.** Wave 4 deprecates the text digest path. SHOULD the WatchStore + `presence_watch` tools get fully removed in a later wave, or remain as a dormant capability? Leaning toward dormant — low maintenance cost, occasional debug value.
