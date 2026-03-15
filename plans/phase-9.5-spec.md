# Phase 9.5: TLA+ Formal Verification for Agentic Coding — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-15

This document specifies a formal verification layer for Sovereign using TLA+ and the TLC model checker. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 9.5 depends on Phase 9 (agent core, agent loop, multi-agent orchestration) and cross-references Phase 5 (planning DAG), Phase 10 (CI pipeline), and Phase 2 (worktree lifecycle). It introduces TLA+ as the formal specification language for every concurrent state machine in Sovereign.

---

## §1 — Motivation & Problem Statement

### §1.1 — Why Agentic Coding Needs Formal Verification

Sovereign is an IDE for agent orchestration. Agents write code, review PRs, plan work, bind worktrees, and coordinate with other agents — all concurrently. Every one of these workflows is a state machine with well-defined states, transitions, and invariants. When agents modify these state machines, they fail in predictable ways:

**Linear reasoning on exponential state spaces.** An LLM agent modifying the agent session lifecycle thinks in sequences: "idle → working → streaming → complete." But the real system has multiple agents, concurrent message delivery, timeout handlers, and graceful shutdown — all interleaving. The agent handles the happy path. The actual state space has hundreds of reachable states.

**Invisible concurrency bugs.** When Agent A acquires a worktree while Agent B simultaneously attempts to acquire the same worktree, what happens? When a parent agent spawns three children and two complete while one errors, does the parent deadlock? These are emergent properties of concurrent execution that no agent reasons about from code alone.

**Incomplete implementations.** An agent implementing multi-agent orchestration handles spawn, completion, and error. But what happens when:

- A child agent errors while the parent is mid-compaction?
- Two child agents attempt to commit to the same branch simultaneously?
- A timeout fires for a child agent that is about to complete?
- A parent agent is killed while children are still running?

**Regression from partial understanding.** An agent modifies the worktree release logic without understanding how it interacts with the CI pipeline's artifact collection. The modification is correct in isolation but creates a race condition: a worktree is released while CI is still reading its artifacts.

The root cause: **the agent has no authoritative, machine-verifiable description of the complete state machine.** It works from code (the implementation, not the specification) and comments (incomplete, stale). It needs a formal spec.

### §1.2 — Why It Matters for Sovereign Specifically

Sovereign's architecture (PRINCIPLES.md §3, §9) places deterministic code — not LLMs — in the critical path. The event bus, agent loop, worktree binding, and CI pipeline are pure state machines that MUST be correct regardless of LLM availability. Formal verification validates these state machines at design time, before any agent touches the implementation.

Key failure domains:

1. **Multi-agent orchestration** — deadlocks, lost results, orphaned children
2. **Worktree binding** — concurrent access, lock leaks, commit races
3. **CI pipeline** — stage ordering violations, artifact dependency cycles, parallel job coordination failures
4. **Planning DAG** — dependency cycles, invalid state transitions, stale ready-set computation

Each of these has caused real bugs in comparable systems. TLA+ catches them exhaustively.

---

## §2 — Architecture

### §2.1 — Specs Directory

- All TLA+ specifications MUST live in `specs/` at the project root.
- Each specification MUST have a corresponding `.cfg` file for TLC configuration.
- Trace outputs MUST be stored in `specs/traces/`.

```
specs/
├── agent-session.tla          # Agent session lifecycle
├── agent-session.cfg
├── multi-agent.tla            # Multi-agent orchestration
├── multi-agent.cfg
├── worktree-binding.tla       # Worktree acquire/release
├── worktree-binding.cfg
├── ci-pipeline.tla            # CI stage ordering + artifacts
├── ci-pipeline.cfg
├── planning-dag.tla           # Task DAG invariants
├── planning-dag.cfg
├── chat-routing.tla           # Thread/entity message routing
├── chat-routing.cfg
├── config-reload.tla          # Hot-reload atomicity
├── config-reload.cfg
├── templates/                 # Reusable spec patterns
│   ├── request-response.tla
│   ├── pub-sub.tla
│   └── saga.tla
├── traces/                    # TLC counterexample traces
│   └── .gitkeep
└── README.md                  # How to read, write, and check specs
```

### §2.2 — Spec-First Workflow

The mandated workflow for any change to a concurrent state machine:

1. **Read the spec.** Understand all states, transitions, and invariants.
2. **Modify the spec.** Add new states/transitions, update invariants.
3. **Model check.** Run `tlc specs/<name>.tla` — all invariants MUST pass.
4. **Implement.** Write the code, using the spec as the authoritative reference.
5. **Test.** Unit tests + trace-driven scenarios from TLC output.

This inverts the typical flow (code → test → hope) into spec → verify → implement → test.

### §2.3 — Module Integration

TLA+ specs describe the **design** of Sovereign's state machines. They relate to the codebase as follows:

| Spec | Primary Module(s) | Event Bus Events |
| --- | --- | --- |
| `agent-session.tla` | `packages/server/src/agent-backend/` (Phase 9) | `agent.session.*` |
| `multi-agent.tla` | Phase 9 orchestration layer | `agent.spawn`, `agent.complete`, `agent.error` |
| `worktree-binding.tla` | `packages/server/src/worktrees/` | `worktree.acquired`, `worktree.released` |
| `ci-pipeline.tla` | Phase 10 CI runner | `ci.stage.*`, `ci.job.*` |
| `planning-dag.tla` | `packages/server/src/planning/graph.ts` | `planning.graph.updated` |
| `chat-routing.tla` | `packages/server/src/chat/`, `threads/` | `chat.message.*` |
| `config-reload.tla` | `packages/server/src/config/` | `config.changed` |

Specs MUST NOT import runtime code. They are pure mathematical models. The connection between spec and code is maintained by convention (AGENTS.md spec table) and verified by trace-driven tests.

### §2.4 — Integration with Phase 9 (Agent Core)

Phase 9 introduces the agent loop as a deterministic state machine (PHASES.md: "agent loop (deterministic state machine)"). The `agent-session.tla` spec MUST be written alongside or before the Phase 9 agent loop implementation. The spec defines the canonical states, transitions, and invariants; the Phase 9 implementation MUST conform to them.

Phase 9's multi-agent orchestration — parent spawns children, work distribution, result aggregation — MUST have its concurrency properties verified by `multi-agent.tla` before implementation.

### §2.5 — Integration with Phase 5 (Planning Engine)

The planning engine (`packages/server/src/planning/graph.ts`) builds a directed acyclic graph from issue dependencies. The `planning-dag.tla` spec MUST verify:

- Cycle detection is complete (no cycle escapes detection)
- The ready-set computation is consistent with the graph state
- Incremental updates preserve all graph invariants

This connects to Phase 5's `GraphEngine` interface (§1.2–1.3 of phase-5-spec.md).

---

## §3 — Target State Machines

### §3.1 — Agent Session Lifecycle

**Module:** Phase 9 agent core (`packages/server/src/agent-backend/`)

**States:** `Idle`, `Working`, `Streaming`, `Compacting`, `Complete`, `Error`, `ShuttingDown`

**Key transitions:**

- `Idle → Working`: user message received, context assembled
- `Working → Streaming`: LLM begins token generation
- `Streaming → Working`: tool call received, agent executes tool
- `Working → Compacting`: context exceeds window, compaction triggered
- `Compacting → Working`: compaction complete, resume
- `Working → Complete`: agent emits final response, no pending tool calls
- `Streaming → Complete`: stream ends naturally
- `* → Error`: unrecoverable failure (LLM timeout, tool crash)
- `* → ShuttingDown`: graceful shutdown requested
- `ShuttingDown → Complete`: pending work drained

**Concurrency concerns:**

- Messages arriving while agent is `Streaming` or `Compacting`
- Timeout firing simultaneously with completion
- Shutdown requested while tool call is in-flight
- Multiple concurrent sessions sharing the same LLM router

**Invariants:**

1. **NoWorkWithoutSession** — An agent MUST NOT be in `Working` or `Streaming` without an active session context.
2. **CompactionConverges** — If compaction starts, the agent MUST eventually reach `Working` or `Error` (no infinite compaction loop).
3. **GracefulShutdownCompletes** — If `ShuttingDown` is entered, the agent MUST eventually reach `Complete` or `Error` (no hanging shutdown).

### §3.2 — Multi-Agent Orchestration

**Module:** Phase 9 orchestration layer

**States per agent:** `Spawned`, `Assigned`, `Running`, `WaitingForChildren`, `Aggregating`, `Complete`, `Error`, `Cancelled`

**Key transitions:**

- `Spawned → Assigned`: work item bound to agent
- `Assigned → Running`: agent acquires resources (worktree, context)
- `Running → WaitingForChildren`: parent spawns child agents
- `WaitingForChildren → Aggregating`: all children complete or error
- `Aggregating → Complete`: parent merges results
- `Running → Complete`: leaf agent finishes work
- `* → Cancelled`: parent cancelled, cascade to children
- `* → Error`: unrecoverable failure

**Concurrency concerns:**

- Parent waiting on N children; subset completes, subset errors — does the parent deadlock?
- Two children racing to commit to the same branch
- Parent cancelled while children are mid-execution
- Child timeout versus child completion race

**Invariants:**

1. **NoOrphanedChildren** — If a parent reaches `Complete`, `Error`, or `Cancelled`, ALL children MUST eventually reach a terminal state.
2. **NoDeadlock** — The orchestration MUST NOT reach a state where a parent waits on children that will never complete.
3. **CancellationPropagates** — If a parent enters `Cancelled`, all non-terminal children MUST eventually enter `Cancelled` or `Error`.

### §3.3 — Worktree Binding

**Module:** `packages/server/src/worktrees/`

**States per worktree:** `Free`, `Acquiring`, `Bound`, `Working`, `Committing`, `Releasing`

**Key transitions:**

- `Free → Acquiring`: agent requests worktree for branch
- `Acquiring → Bound`: lock acquired, branch checked out
- `Bound → Working`: agent begins file operations
- `Working → Committing`: agent commits changes
- `Committing → Working`: more changes needed
- `Committing → Releasing`: work complete
- `Working → Releasing`: work abandoned
- `Releasing → Free`: lock released, worktree cleaned
- `Acquiring → Free`: lock contention, back off

**Concurrency concerns:**

- Two agents acquiring the same worktree simultaneously
- Agent crash while worktree is `Bound` (lock leak)
- CI reading worktree while agent is `Committing`
- Release during active file I/O

**Invariants:**

1. **ExclusiveBinding** — At most one agent MUST be bound to a given worktree at any time.
2. **NoLockLeak** — If an agent reaches a terminal state (`Complete`, `Error`), any worktree it held MUST eventually reach `Free`.
3. **CommitAtomicity** — A worktree in `Committing` MUST NOT be readable by CI or other agents until the commit completes.

### §3.4 — CI Pipeline Execution

**Module:** Phase 10 CI runner

**States per stage:** `Pending`, `Ready`, `Running`, `Passed`, `Failed`, `Skipped`

**Key transitions:**

- `Pending → Ready`: all upstream stages passed, artifacts available
- `Ready → Running`: runner picks up the stage
- `Running → Passed`: exit code 0, artifacts produced
- `Running → Failed`: non-zero exit, or timeout
- `Pending → Skipped`: upstream failed, skip policy active

**Concurrency concerns:**

- Parallel stages sharing artifact cache
- Stage timeout racing with completion
- Pipeline cancellation while stages are `Running`
- Matrix builds: N jobs per stage, fan-out/fan-in

**Invariants:**

1. **DependencyRespected** — A stage MUST NOT enter `Running` unless ALL upstream stages are `Passed`.
2. **ArtifactAvailability** — If stage B depends on stage A's artifacts, those artifacts MUST exist before B enters `Running`.
3. **TerminalConvergence** — Every pipeline MUST eventually reach a state where all stages are in a terminal state (`Passed`, `Failed`, or `Skipped`).

### §3.5 — Planning DAG

**Module:** `packages/server/src/planning/graph.ts`

**States per task:** `Open`, `InProgress`, `Blocked`, `Closed`

**Key transitions:**

- `Open → InProgress`: work begins (assignee set, agent starts)
- `Open → Blocked`: dependency on open task detected
- `Blocked → Open`: blocking dependency closed
- `InProgress → Closed`: work complete (issue closed)
- `InProgress → Blocked`: new dependency added to in-progress task

**Concurrency concerns:**

- Concurrent issue updates creating cycles
- Ready-set computation racing with new dependency edges
- Cross-project dependency resolution timing
- Incremental graph update atomicity

**Invariants:**

1. **Acyclicity** — The dependency graph MUST be acyclic at all times. Any operation that would create a cycle MUST be rejected.
2. **ReadySetConsistency** — A task reported as "ready" MUST have ALL dependencies in `Closed` state.
3. **BlockedImpliesDependency** — A task in `Blocked` MUST have at least one `Open` or `InProgress` dependency.

### §3.6 — Chat/Thread Routing

**Module:** `packages/server/src/chat/`, `packages/server/src/threads/`

**States per message:** `Queued`, `Routed`, `Delivered`, `Acknowledged`

**Key transitions:**

- `Queued → Routed`: thread resolved, entity binding matched
- `Routed → Delivered`: message reaches agent or user
- `Delivered → Acknowledged`: recipient confirms processing

**Concurrency concerns:**

- Message arriving for a thread whose entity binding is being changed
- Thread deletion while messages are in-flight
- Agent response racing with user's next message
- Entity event routing versus direct message routing

**Invariants:**

1. **NoLostMessages** — A queued message MUST eventually reach `Delivered` or `Error`.
2. **EntityConsistency** — Messages routed to a thread MUST match the thread's entity binding at the time of routing.
3. **OrderPreservation** — Messages from a single source MUST be delivered in send order within a thread.

### §3.7 — Config Hot-Reload

**Module:** `packages/server/src/config/`

**States:** `Stable`, `Reading`, `Validating`, `Applying`, `NotifyingModules`

**Key transitions:**

- `Stable → Reading`: file change detected or API write
- `Reading → Validating`: raw config parsed
- `Validating → Applying`: schema validation passed
- `Applying → NotifyingModules`: in-memory state updated
- `NotifyingModules → Stable`: all `config.changed` handlers complete
- `Validating → Stable`: validation failed, revert

**Concurrency concerns:**

- Two config changes arriving simultaneously (file edit + API call)
- Module reading config while another module is reacting to a change
- Config change triggering a cascade of module reactions with ordering dependencies

**Invariants:**

1. **AtomicUpdate** — All modules MUST see either the old config or the new config, never a partial update.
2. **ConsistentRead** — A module reading config during `NotifyingModules` MUST see the new values (not stale).
3. **NoReactionCycle** — A module's reaction to `config.changed` MUST NOT trigger another `config.changed` for the same namespace.

---

## §4 — Agent Workflow Integration

### §4.1 — Spec-Aware Agent Development

Sovereign agents (Phase 9) MUST consult TLA+ specs before modifying any state machine listed in §3. The workflow:

1. Agent receives a task that touches a state machine (e.g., "add timeout handling to the agent loop").
2. Agent reads the corresponding spec (`specs/agent-session.tla`).
3. Agent identifies which states and transitions the change affects.
4. Agent modifies the spec first — adds new states, transitions, or invariants.
5. Agent runs TLC: `tlc specs/agent-session.tla -config specs/agent-session.cfg`.
6. If TLC finds an invariant violation, the agent fixes the spec before touching code.
7. Agent implements the code change, using the verified spec as the reference.
8. Agent writes tests, including trace-driven scenarios from TLC output.

### §4.2 — AGENTS.md Integration

The project's `AGENTS.md` (or equivalent agent instructions file) MUST include a spec table:

```markdown
## Formal Specifications

Before modifying any of these subsystems, read the corresponding TLA+ spec:

| Subsystem | Spec | Key Invariants |
| --- | --- | --- |
| Agent Session | `specs/agent-session.tla` | NoWorkWithoutSession, CompactionConverges, GracefulShutdownCompletes |
| Multi-Agent | `specs/multi-agent.tla` | NoOrphanedChildren, NoDeadlock, CancellationPropagates |
| Worktree Binding | `specs/worktree-binding.tla` | ExclusiveBinding, NoLockLeak, CommitAtomicity |
| CI Pipeline | `specs/ci-pipeline.tla` | DependencyRespected, ArtifactAvailability, TerminalConvergence |
| Planning DAG | `specs/planning-dag.tla` | Acyclicity, ReadySetConsistency, BlockedImpliesDependency |
| Chat Routing | `specs/chat-routing.tla` | NoLostMessages, EntityConsistency, OrderPreservation |
| Config Reload | `specs/config-reload.tla` | AtomicUpdate, ConsistentRead, NoReactionCycle |

### How to use specs:

1. Read the spec — understand all states and transitions
2. Find the states your change touches
3. Check all transitions from those states are handled in your code
4. If adding a new state/transition, update the spec first and run TLC
5. Run: `sovereign spec check` to model-check all specs
```

### §4.3 — CI Integration

- TLC model checking MUST run in the CI pipeline (Phase 10) for all specs in `specs/`.
- A spec that fails model checking MUST block the pipeline.
- CI MUST run: `sovereign spec check --ci` which model-checks all `.tla` files with their corresponding `.cfg`.
- CI SHOULD cache TLC state to accelerate incremental checking.

### §4.4 — Spec-Code Drift Detection

Specs describe the design; code is the implementation. Drift between them is inevitable without active measures.

- Each spec MUST include a header comment listing the source files it describes.
- PRs that modify source files listed in a spec header MUST include a "Spec Review" section confirming the spec is still accurate or updating it.
- The `sovereign spec drift` command SHOULD compare spec headers against git diff to flag files that changed without a corresponding spec update. This is advisory, not blocking.

---

## §5 — Tooling

### §5.1 — TLC Integration

- TLC (the TLA+ model checker) MUST be available in the development environment and CI.
- Installation:
  ```bash
  # macOS
  brew install tlaplus
  # or manual
  curl -L -o tla2tools.jar \
    https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
  ```
- Java 11+ MUST be available (TLC is Java-based).
- The VS Code TLA+ extension (`alygin.vscode-tlaplus`) SHOULD be recommended in `.vscode/extensions.json`.

### §5.2 — Sovereign CLI Commands

The `sovereign` CLI MUST include spec-related subcommands:

| Command                       | Description                                                               |
| ----------------------------- | ------------------------------------------------------------------------- |
| `sovereign spec check`        | Model-check all specs in `specs/`. Exit 1 on any violation.               |
| `sovereign spec check <name>` | Model-check a specific spec (e.g., `sovereign spec check agent-session`). |
| `sovereign spec check --ci`   | CI mode: model-check all specs, output machine-readable results.          |
| `sovereign spec drift`        | Compare spec file headers against recent git changes. Advisory.           |
| `sovereign spec trace <name>` | Run TLC with trace generation, output to `specs/traces/`.                 |

### §5.3 — Trace-Driven Testing

TLC can generate traces — sequences of (state, action) pairs representing concrete execution paths. These traces bridge the gap between spec and implementation:

1. **TLC generates traces.** Counterexample traces (invariant violations) and valid traces (state exploration).
2. **Traces become test scenarios.** A trace like `Init → UserMessage → StartWorking → ToolCall → Timeout → Error` becomes a test: "send message, agent starts working, tool call begins, timeout fires — verify error state."
3. **Counterexample traces are regression tests.** When TLC finds a violation, the trace IS the bug report. Convert it to a test and it catches the bug forever.

Trace files MUST be stored as JSON in `specs/traces/`:

```json
{
  "spec": "agent-session",
  "type": "counterexample",
  "invariant": "GracefulShutdownCompletes",
  "steps": [
    { "state": { "session": "Working", "pending": ["toolCall"] }, "action": "ShutdownRequested" },
    { "state": { "session": "ShuttingDown", "pending": ["toolCall"] }, "action": "ToolCallHangs" }
  ]
}
```

### §5.4 — Spec Templates

Common concurrency patterns MUST have reusable templates in `specs/templates/`:

- **Request-Response** — client sends request, server processes, returns response. Timeout handling, retry logic.
- **Pub-Sub** — publisher emits events, subscribers process asynchronously. At-least-once delivery, ordering.
- **Saga** — multi-step workflow with compensating actions on failure. Forward progress guarantee.

Templates MUST be parameterized (PlusCal macros or TLA+ module instantiation) so they can be adapted to specific use cases.

---

## §6 — Implementation Waves

### Wave 1: Agent Session Lifecycle + Tooling Setup

**Depends on:** Phase 9 agent core design (concurrent or immediately after)

**Deliverables:**

- `specs/agent-session.tla` — complete, model-checkable spec (see §7)
- `specs/agent-session.cfg` — TLC configuration
- `sovereign spec check` CLI command (shell script wrapping TLC)
- TLC in dev environment and CI
- AGENTS.md spec table
- `specs/README.md` — how to read, write, and check specs
- TLC run report: states explored, invariants verified

### Wave 2: Multi-Agent Orchestration + Worktree Binding

**Depends on:** Wave 1, Phase 9 multi-agent design

**Deliverables:**

- `specs/multi-agent.tla` — orchestration spec with deadlock freedom proof
- `specs/worktree-binding.tla` — concurrent access prevention spec
- At least one bug found and documented from spec analysis
- Trace-driven test scenarios for critical interleavings

### Wave 3: CI Pipeline + Planning DAG

**Depends on:** Wave 2, Phase 10 CI design, Phase 5 graph engine

**Deliverables:**

- `specs/ci-pipeline.tla` — stage ordering and artifact dependency spec
- `specs/planning-dag.tla` — DAG invariant spec
- `specs/templates/` — request-response, pub-sub, saga templates
- `sovereign spec drift` command

### Wave 4: Trace-Driven Test Generation + Full CI Integration

**Depends on:** Wave 3

**Deliverables:**

- `sovereign spec trace` command
- Trace-to-test conversion tooling
- `specs/chat-routing.tla`, `specs/config-reload.tla`
- Full CI pipeline integration (all specs checked on every PR)
- Spec coverage report (advisory)

---

## §7 — Example Spec: Agent Session Lifecycle

This is a complete, model-checkable PlusCal/TLA+ spec for the agent session lifecycle. It models concurrent message delivery, timeout handling, tool execution, context compaction, and graceful shutdown.

```tla
--------------------------- MODULE AgentSession ---------------------------
(**************************************************************************)
(* Agent Session Lifecycle — formal specification                         *)
(*                                                                        *)
(* Models an agent processing user messages through an LLM, executing     *)
(* tool calls, handling compaction, timeouts, and graceful shutdown.       *)
(* Concurrent message arrival and multiple in-flight operations.          *)
(*                                                                        *)
(* Target: packages/server/src/agent-backend/ (Phase 9)                   *)
(* Run with: tlc specs/agent-session.tla -config specs/agent-session.cfg  *)
(**************************************************************************)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    MaxMessages,        \* Max messages in queue before backpressure
    MaxToolCalls,       \* Max concurrent tool calls
    CompactionThreshold \* Context tokens before compaction triggers

VARIABLES
    state,          \* Agent state: "idle", "working", "streaming",
                    \* "compacting", "complete", "error", "shutting_down"
    messageQueue,   \* Sequence of pending user messages
    contextSize,    \* Current context window usage (abstract token count)
    toolsInFlight,  \* Number of tool calls currently executing
    shutdownReq,    \* TRUE if graceful shutdown has been requested
    sessionActive   \* TRUE if a session context exists

vars == <<state, messageQueue, contextSize, toolsInFlight, shutdownReq, sessionActive>>

\* --- Type invariant ---
TypeOK ==
    /\ state \in {"idle", "working", "streaming", "compacting",
                   "complete", "error", "shutting_down"}
    /\ messageQueue \in Seq({"msg"})
    /\ Len(messageQueue) <= MaxMessages + 1
    /\ contextSize \in 0..CompactionThreshold + 10
    /\ toolsInFlight \in 0..MaxToolCalls
    /\ shutdownReq \in BOOLEAN
    /\ sessionActive \in BOOLEAN

\* --- Initial state ---
Init ==
    /\ state = "idle"
    /\ messageQueue = <<>>
    /\ contextSize = 0
    /\ toolsInFlight = 0
    /\ shutdownReq = FALSE
    /\ sessionActive = FALSE

\* ====================================================================
\* Actions
\* ====================================================================

\* --- User sends a message (can happen at any time) ---
UserMessage ==
    /\ state /= "complete"
    /\ state /= "error"
    /\ Len(messageQueue) < MaxMessages
    /\ messageQueue' = Append(messageQueue, "msg")
    /\ UNCHANGED <<state, contextSize, toolsInFlight, shutdownReq, sessionActive>>

\* --- Agent picks up a message and starts working ---
StartWorking ==
    /\ state = "idle"
    /\ Len(messageQueue) > 0
    /\ messageQueue' = Tail(messageQueue)
    /\ state' = "working"
    /\ sessionActive' = TRUE
    /\ contextSize' = contextSize + 1  \* Message adds to context
    /\ UNCHANGED <<toolsInFlight, shutdownReq>>

\* --- Agent sends context to LLM, begins streaming response ---
StartStreaming ==
    /\ state = "working"
    /\ toolsInFlight = 0  \* All tool calls resolved before next LLM turn
    /\ state' = "streaming"
    /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight, shutdownReq, sessionActive>>

\* --- LLM emits a tool call during streaming ---
ToolCallReceived ==
    /\ state = "streaming"
    /\ toolsInFlight < MaxToolCalls
    /\ state' = "working"
    /\ toolsInFlight' = toolsInFlight + 1
    /\ contextSize' = contextSize + 1  \* Tool call adds to context
    /\ UNCHANGED <<messageQueue, shutdownReq, sessionActive>>

\* --- A tool call completes ---
ToolCallComplete ==
    /\ state = "working"
    /\ toolsInFlight > 0
    /\ toolsInFlight' = toolsInFlight - 1
    /\ contextSize' = contextSize + 1  \* Tool result adds to context
    /\ UNCHANGED <<state, messageQueue, shutdownReq, sessionActive>>

\* --- Context exceeds threshold, trigger compaction ---
TriggerCompaction ==
    /\ state = "working"
    /\ contextSize >= CompactionThreshold
    /\ toolsInFlight = 0
    /\ state' = "compacting"
    /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight, shutdownReq, sessionActive>>

\* --- Compaction completes, context reduced ---
CompactionComplete ==
    /\ state = "compacting"
    /\ state' = "working"
    /\ contextSize' = contextSize \div 2  \* Compaction reduces context
    /\ UNCHANGED <<messageQueue, toolsInFlight, shutdownReq, sessionActive>>

\* --- Stream ends naturally (LLM done, no more tool calls) ---
StreamComplete ==
    /\ state = "streaming"
    /\ state' = "working"  \* Back to working to check for pending messages
    /\ contextSize' = contextSize + 1  \* Response adds to context
    /\ UNCHANGED <<messageQueue, toolsInFlight, shutdownReq, sessionActive>>

\* --- Agent finishes: no pending tools, no pending messages, done ---
AgentComplete ==
    /\ state = "working"
    /\ toolsInFlight = 0
    /\ Len(messageQueue) = 0
    /\ ~shutdownReq  \* Normal completion, not shutdown-driven
    /\ state' = "complete"
    /\ sessionActive' = FALSE
    /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight, shutdownReq>>

\* --- Process next message if queue has items after completing a turn ---
ProcessNextMessage ==
    /\ state = "working"
    /\ toolsInFlight = 0
    /\ Len(messageQueue) > 0
    /\ contextSize < CompactionThreshold
    /\ messageQueue' = Tail(messageQueue)
    /\ contextSize' = contextSize + 1
    \* Stay in working state, process next message
    /\ UNCHANGED <<state, toolsInFlight, shutdownReq, sessionActive>>

\* --- Unrecoverable error (LLM timeout, tool crash, etc.) ---
AgentError ==
    /\ state \in {"working", "streaming", "compacting"}
    /\ state' = "error"
    /\ toolsInFlight' = 0  \* All in-flight tools are abandoned
    /\ sessionActive' = FALSE
    /\ UNCHANGED <<messageQueue, contextSize, shutdownReq>>

\* --- Graceful shutdown requested ---
ShutdownRequested ==
    /\ state \notin {"complete", "error", "shutting_down"}
    /\ shutdownReq' = TRUE
    /\ IF state = "idle"
       THEN /\ state' = "complete"
            /\ sessionActive' = FALSE
            /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight>>
       ELSE /\ state' = "shutting_down"
            /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight, sessionActive>>

\* --- Shutdown drains: in-flight work completes, then done ---
ShutdownDrain ==
    /\ state = "shutting_down"
    /\ toolsInFlight = 0
    /\ state' = "complete"
    /\ sessionActive' = FALSE
    /\ UNCHANGED <<messageQueue, contextSize, toolsInFlight, shutdownReq>>

\* --- Shutdown timeout: forced termination ---
ShutdownTimeout ==
    /\ state = "shutting_down"
    /\ state' = "error"
    /\ toolsInFlight' = 0
    /\ sessionActive' = FALSE
    /\ UNCHANGED <<messageQueue, contextSize, shutdownReq>>

\* ====================================================================
\* Next-state relation
\* ====================================================================

Next ==
    \/ UserMessage
    \/ StartWorking
    \/ StartStreaming
    \/ ToolCallReceived
    \/ ToolCallComplete
    \/ TriggerCompaction
    \/ CompactionComplete
    \/ StreamComplete
    \/ AgentComplete
    \/ ProcessNextMessage
    \/ AgentError
    \/ ShutdownRequested
    \/ ShutdownDrain
    \/ ShutdownTimeout

Spec == Init /\ [][Next]_vars

\* ====================================================================
\* Invariants — MUST hold in EVERY reachable state
\* ====================================================================

\* 1. Agent must not be working without an active session
NoWorkWithoutSession ==
    state \in {"working", "streaming", "compacting", "shutting_down"}
    => sessionActive = TRUE

\* 2. Tool calls only exist during working state
ToolCallsOnlyWhenWorking ==
    toolsInFlight > 0 => state \in {"working", "shutting_down"}

\* 3. Idle means no in-flight tools
IdleMeansClean ==
    state = "idle" => toolsInFlight = 0

\* 4. Terminal states are truly terminal (checked via spec structure,
\*    but also as invariant: complete/error means no session)
TerminalStatesClean ==
    state \in {"complete", "error"} =>
    /\ sessionActive = FALSE
    /\ toolsInFlight = 0

\* 5. Context size is non-negative
ContextNonNegative ==
    contextSize >= 0

\* 6. Compaction only when context is large
CompactionJustified ==
    state = "compacting" => contextSize >= CompactionThreshold

\* ====================================================================
\* Liveness properties (under fairness)
\* ====================================================================

\* Compaction must eventually complete (not loop forever)
CompactionConverges ==
    state = "compacting" ~> state /= "compacting"

\* Graceful shutdown must eventually reach a terminal state
GracefulShutdownCompletes ==
    state = "shutting_down" ~> state \in {"complete", "error"}

\* Every message is eventually processed or the agent terminates
MessageEventuallyProcessed ==
    Len(messageQueue) > 0 ~>
    (Len(messageQueue) = 0 \/ state \in {"complete", "error"})

\* ====================================================================
\* Model checking configuration (for agent-session.cfg)
\* ====================================================================
\* CONSTANTS
\*   MaxMessages = 3
\*   MaxToolCalls = 2
\*   CompactionThreshold = 5
\* INVARIANTS
\*   TypeOK
\*   NoWorkWithoutSession
\*   ToolCallsOnlyWhenWorking
\*   IdleMeansClean
\*   TerminalStatesClean
\*   ContextNonNegative
\*   CompactionJustified
\* PROPERTIES
\*   CompactionConverges
\*   GracefulShutdownCompletes
\*   MessageEventuallyProcessed

=========================================================================
```

### What an agent learns from reading this spec

1. **All seven states** — any code touching session state must handle all seven.
2. **Tool calls gate streaming** — `StartStreaming` requires `toolsInFlight = 0`. The agent MUST resolve all tool calls before the next LLM turn.
3. **Compaction is interruptible only by error** — once in `compacting`, the only exits are `CompactionComplete` (→ `working`) or `AgentError` (→ `error`).
4. **Shutdown has two exit paths** — drain (clean) or timeout (forced). Both are modelled.
5. **Messages can arrive at any time** — `UserMessage` fires in any non-terminal state. The agent must handle message arrival during streaming, compaction, and shutdown.
6. **The CompactionJustified invariant** prevents spurious compaction — compaction only fires when context is genuinely full.

---

## §8 — Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Stale specs** — spec diverges from code | Agents get wrong information, worse than no spec | CI model-checking; PR rule requiring spec updates; `sovereign spec drift` command |
| **Over-specification** — specifying simple sequential logic | Wasted effort, maintenance burden | Only spec state machines with concurrency or >4 states. Simple request-response handlers don't need TLA+. |
| **Learning curve** — team members can't review specs | Specs become agent-only artifacts, no human oversight | Use PlusCal for readability; every spec includes a plain-English summary of invariants; agents can explain any spec on request |
| **Model explosion** — TLC runs too long for CI | Blocks pipeline, discourages spec use | Keep CI models small (3–4 agents, bounded queues). Larger models for deep analysis runs. Symmetry reduction. Target <60s per spec in CI. |
| **False confidence** — "the spec passes so the code is correct" | Bugs in spec-to-code translation | Specs verify DESIGN, not implementation. Tests verify implementation. Trace-driven testing bridges the gap. Both are required. |
| **Maintenance burden** — another artifact per state machine | Developer fatigue | Only maintain specs for the 7 state machines listed in §3. Low-value specs can be retired. |
| **Java dependency** — TLC requires JVM | Environment setup friction | Document in `specs/README.md`. TLC jar is self-contained (~15MB). Containerized option for CI. |

---

## §9 — Open Questions

1. **PlusCal vs raw TLA+?** PlusCal reads like pseudocode and is more accessible. Raw TLA+ is more flexible for concurrent composition. The example in §7 uses raw TLA+ because agent sessions are fundamentally concurrent. RECOMMENDATION: raw TLA+ for protocol-level specs, PlusCal for sequential algorithms.

2. **Spec-code generation.** Could we auto-generate TypeScript state machine boilerplate (enum + switch/match) from TLA+ specs? Tools like Apalache extract type information from TLA+. A code generator that produces a typed state machine skeleton would close the spec-to-code gap. RESEARCH needed — high value if feasible.

3. **Spec review process.** Who reviews specs? The AGENTS.md table tells agents to read them, but human review ensures domain accuracy. RECOMMENDATION: every spec MUST include a plain-English "Invariants" section. Human reviewers check the English; agents check the TLA+.

4. **Integration with Phase 9 timeline.** Should Wave 1 (agent session spec) block Phase 9 implementation, or run in parallel? RECOMMENDATION: parallel — write the spec alongside the agent loop implementation, iterate both until they converge.

5. **Distributed specs.** Phase 10 introduces peer-to-peer sync via Radicle. Should P2P protocol specs live in `specs/` alongside local state machine specs? They're qualitatively different (network model vs local concurrency). RECOMMENDATION: yes, same directory, but clearly labeled in the README.

6. **Spec testing in CI.** How long is acceptable for TLC in CI? With small constants (3 agents, 3 messages, 2 tool calls), each spec should complete in <60 seconds. But model explosion is real. RECOMMENDATION: CI uses minimal constants; a nightly job runs larger models.

7. **Can agents write specs from code?** The ideal flow is spec-first. But for existing modules (worktrees, config, planning), the code already exists. Agents can reverse-engineer specs from code — this often finds bugs (as demonstrated in the original AD4M TLA+ proposal where the glare condition was discovered). RECOMMENDATION: new features get spec-first; existing code gets spec-after as a bug-finding exercise.

---

## Cross-Cutting Concerns

### Dependencies (New)

- **TLC** (tla2tools.jar) — Java-based model checker. ~15MB self-contained jar.
- **Java 11+** — runtime for TLC.
- No npm dependencies. No build system changes. Specs are standalone.

### Testing

- Specs are tested by TLC (the model checker). A spec that passes TLC with no invariant violations is "tested."
- Trace-driven tests connect spec verification to implementation testing.
- Integration tests (existing) remain the implementation correctness check.

### Data Directory

No data directory changes. Specs are source artifacts (`specs/`), not runtime data.

### Module Registration

No module registration. TLA+ specs are design-time artifacts that do not run as part of Sovereign's server process. The `sovereign spec` CLI commands are standalone tools.
