# Phase 5: Planning — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-13

This document specifies the Planning module of Phase 5. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 5 depends on Phase 4 (issue tracker, review system) and Phase 2 (orgs, worktrees). The planning module is built directly on the provider-backed issue/review system — GitHub Issues/Projects and Radicle Issues are the single source of truth. Sovereign adds a lightweight dependency graph layer on top.

---

## Design Philosophy

**The issue tracker IS the plan store.** Every plan node is a provider issue. There is no `.sovereign/plans/` directory, no separate JSON files for plan nodes, no duplicated state. The planning module reads from the issue tracker (Phase 4), parses dependency information from issue content and references, builds a graph in memory, and writes changes back through the issue tracker.

**Minimal local metadata.** The only local data the planning module persists is a lightweight dependency index — a cache of parsed dependency edges for fast graph computation. This index is rebuilt from provider data on sync and MUST NOT be the source of truth for anything.

**Provider features first.** Where GitHub or Radicle provides native support for a concept (milestones, labels, sub-issues, assignees), the planning module MUST use the provider's feature rather than inventing its own. Local abstractions are only for features that span providers or that neither provider supports (cross-project dependencies, DAG computation).

---

## Wave Strategy

**Wave 1:** Dependency Graph Engine (server) **Wave 2:** Planning API + Routes (server, depends on Wave 1) **Wave 3:** Integration tests

---

## 1. Dependency Graph Engine

The core computation engine. Parses dependency information from issues, builds an in-memory directed acyclic graph, and provides graph queries.

### Requirements

#### 1.1 Dependency Parsing

- The parser MUST extract dependency references from issue bodies and comments using standard conventions:
  - GitHub: `depends on #42`, `blocked by #42`, `blocks #42`, `depends on org/repo#42` (cross-repo)
  - Radicle: `depends on <issue-id>` (same patterns, adapted for Radicle issue IDs)
- The parser MUST recognise these patterns case-insensitively.
- The parser MUST support both intra-project references (`#42`) and cross-project references (`org/repo#42` or `rad:<rid>#<id>`).
- The parser MUST extract dependency direction: `depends on` / `blocked by` = this issue depends on the referenced issue; `blocks` = the referenced issue depends on this issue.
- The parser MUST return structured edges: `{ from: EntityRef, to: EntityRef, type: 'depends_on' | 'blocks' }` where `EntityRef` is `{ orgId, projectId, remote, issueId }`.
- The parser SHOULD also extract milestone references from issue metadata (GitHub milestones, Radicle labels used as milestones).
- The parser MAY extract effort/size from labels (e.g. `size:small`, `effort:medium`).

#### 1.2 Graph Construction

- The graph engine MUST build a directed acyclic graph from a set of issues and their parsed dependency edges.
- Each node in the graph MUST reference a provider issue by `{ orgId, projectId, remote, issueId }` — it MUST NOT duplicate issue data.
- The graph engine MUST detect cycles and report them as errors (with the cycle path) rather than silently ignoring them.
- The graph engine MUST support incremental updates — when a single issue changes, only reparse that issue's dependencies and update affected edges, rather than rebuilding the entire graph.
- The graph engine MUST be a pure computation module — it takes issues + edges as input and produces graph query results. No I/O, no bus dependency, no persistence.

#### 1.3 Graph Queries

- The graph engine MUST compute **topological order** — a valid execution order respecting all dependencies.
- The graph engine MUST compute **critical path** — the longest dependency chain to a given target node (or to any leaf node if no target specified). Critical path is defined by number of nodes, not effort estimation.
- The graph engine MUST compute **blocked nodes** — nodes whose dependencies include at least one open (unresolved) issue.
- The graph engine MUST compute **ready nodes** — nodes whose dependencies are ALL resolved (closed) and which are themselves still open.
- The graph engine MUST compute **parallel sets** — groups of nodes that have no dependencies between them and could be worked on simultaneously.
- The graph engine MUST compute **impact analysis** — given a node, return all nodes that transitively depend on it (downstream impact).
- The graph engine MUST compute **ancestors** — given a node, return all nodes it transitively depends on.
- The graph engine MUST support **subgraph extraction** — given a set of filter criteria (project, label, milestone, assignee), return a subgraph containing only matching nodes and their relevant edges.
- The graph engine MUST support **cross-project graphs** — a single graph spanning issues across multiple projects within an org.
- The graph engine SHOULD compute **completion percentage** — ratio of closed to total issues in a subgraph (e.g. per milestone, per project).

#### 1.4 Dependency Index (Cache)

- The planning module MUST maintain a local dependency index at `{dataDir}/planning/{orgId}/deps.json`.
- The index MUST contain: parsed dependency edges, last-synced timestamp per project, and a hash of the source issue body (to detect changes without re-parsing unchanged issues).
- The index MUST be rebuilt from provider data on explicit sync or when the issue cache is refreshed.
- The index MUST NOT be the source of truth — it is a derived cache. If deleted, it is rebuilt on next sync.
- Index writes MUST be atomic (write temp file → rename).

### Interface

```typescript
// Entity reference — points to a provider issue without duplicating its data
interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

interface DependencyEdge {
  from: EntityRef // this issue depends on...
  to: EntityRef // ...this issue
  type: 'depends_on' | 'blocks'
  source: 'body' | 'comment' // where the reference was parsed from
}

interface CycleError {
  cycle: EntityRef[] // nodes forming the cycle
  message: string
}

interface GraphNode {
  ref: EntityRef
  state: 'open' | 'closed'
  labels: string[]
  milestone?: string
  assignees: string[]
  dependencies: EntityRef[] // issues this node depends on
  dependents: EntityRef[] // issues that depend on this node
}

interface GraphQueryResult {
  nodes: GraphNode[]
  edges: DependencyEdge[]
}

interface CriticalPath {
  path: EntityRef[]
  length: number
}

interface GraphEngine {
  // Construction
  build(issues: IssueSnapshot[], edges: DependencyEdge[]): GraphBuildResult
  update(issueId: EntityRef, newEdges: DependencyEdge[]): void

  // Queries
  topologicalOrder(): EntityRef[]
  criticalPath(target?: EntityRef): CriticalPath
  blocked(): EntityRef[]
  ready(): EntityRef[]
  parallelSets(): EntityRef[][]
  impact(node: EntityRef): EntityRef[]
  ancestors(node: EntityRef): EntityRef[]
  subgraph(filter: GraphFilter): GraphQueryResult
  completionRate(filter?: GraphFilter): { total: number; closed: number; percentage: number }
}

// Minimal snapshot of issue state needed for graph computation
// NOT a copy of the full Issue — just the fields the graph needs
interface IssueSnapshot {
  ref: EntityRef
  state: 'open' | 'closed'
  labels: string[]
  milestone?: string
  assignees: string[]
  body: string // for dependency parsing
  bodyHash: string // for change detection
}

interface GraphBuildResult {
  graph: GraphEngine
  errors: CycleError[]
}

interface GraphFilter {
  projectId?: string
  remote?: string
  label?: string
  milestone?: string
  assignee?: string
}
```

### Files

```
packages/server/src/planning/
├── types.ts             # EntityRef, DependencyEdge, GraphNode, etc.
├── parser.ts            # Dependency reference parser (issue body → edges)
├── parser.test.ts       # Parser tests
├── graph.ts             # Graph engine (pure computation, no I/O)
├── graph.test.ts        # Graph engine tests
```

---

## 2. Planning Service + API

The orchestration layer. Connects the graph engine to the issue tracker, manages the dependency index, and exposes REST endpoints.

### Requirements

#### 2.1 Planning Service

- The planning service MUST be created via `createPlanningService(bus, dataDir, deps)` following the established module pattern.
- Dependencies MUST be injected: `{ issueTracker: IssueTracker, getConfig: () => Config }`. The planning service MUST NOT import from the issues module directly.
- The planning service MUST build a dependency graph by:
  1. Listing issues from the issue tracker (Phase 4) for a given org (optionally filtered by project/milestone/label)
  2. Parsing dependency references from issue bodies
  3. Constructing the graph via the graph engine
  4. Caching the dependency index to disk
- The planning service MUST support **sync** — refresh the dependency index from provider data. Sync MUST be incremental: only reparse issues whose `bodyHash` has changed since last sync.
- The planning service MUST listen for issue events on the bus (`issue.created`, `issue.updated`, `issue.synced`) and update the dependency index accordingly.
- The planning service MUST expose all graph queries (critical path, blocked, ready, parallel sets, impact, ancestors, subgraph, completion rate) scoped to an org.
- The planning service MUST support **creating issues with dependencies** — a convenience method that creates an issue via the issue tracker AND adds dependency references to the issue body.
- The planning service MUST support **batch operations** — create multiple related issues with dependency edges in a single call (for task decomposition). Each issue is created via the issue tracker; dependency references are included in issue bodies.
- The planning service MUST emit events: `planning.graph.updated`, `planning.sync.completed`, `planning.cycle.detected`.
- The planning service MUST expose `status(): ModuleStatus`.

#### 2.2 REST API

- The planning service MUST expose a REST API:
  - `GET /api/orgs/:orgId/planning/graph?projectId=...&milestone=...&label=...&assignee=...` — get the dependency graph (filtered subgraph)
  - `GET /api/orgs/:orgId/planning/critical-path?target=...` — compute critical path
  - `GET /api/orgs/:orgId/planning/blocked` — list blocked issues
  - `GET /api/orgs/:orgId/planning/ready` — list ready (actionable) issues
  - `GET /api/orgs/:orgId/planning/parallel` — list parallel work opportunities
  - `GET /api/orgs/:orgId/planning/impact/:projectId/:issueId` — impact analysis for an issue
  - `GET /api/orgs/:orgId/planning/completion?milestone=...&projectId=...` — completion stats
  - `POST /api/orgs/:orgId/planning/issues` — create issue with dependency references
  - `POST /api/orgs/:orgId/planning/decompose` — batch create issues with edges (task decomposition)
  - `POST /api/orgs/:orgId/planning/sync` — force sync dependency index
- All endpoints MUST be protected by auth middleware.
- Graph query endpoints MUST return results with `EntityRef` identifiers. The client can then fetch full issue details from the issue tracker API as needed (no data duplication in graph responses).
- The `POST /api/orgs/:orgId/planning/issues` endpoint MUST accept: `{ remote, projectId, title, body?, labels?, assignees?, dependsOn?: EntityRef[], blocks?: EntityRef[] }`. The service formats dependency references into the issue body before creating via the issue tracker.
- The `POST /api/orgs/:orgId/planning/decompose` endpoint MUST accept: `{ remote, projectId, issues: [{ title, body?, labels?, assignees?, dependsOn?: EntityRef[], blocks?: EntityRef[] }] }`. Returns all created issues with their graph positions.

#### 2.3 WebSocket Integration

- The planning service MUST register a `planning` WS channel.
- WS messages (server → client): `planning.graph.updated` (when dependency graph changes), `planning.sync.completed`, `planning.cycle.detected`.
- WS subscriptions MUST support scope: `{ orgId }` — only receive updates for the subscribed org.

### Interface

```typescript
interface PlanningDeps {
  issueTracker: IssueTracker
  getConfig: () => Record<string, unknown>
}

interface CreateIssueWithDeps {
  remote: string
  projectId: string
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
  dependsOn?: EntityRef[]
  blocks?: EntityRef[]
}

interface DecomposeRequest {
  remote: string
  projectId: string
  issues: CreateIssueWithDeps[]
}

interface PlanningService {
  // Graph queries
  getGraph(orgId: string, filter?: GraphFilter): Promise<GraphQueryResult>
  getCriticalPath(orgId: string, target?: EntityRef): Promise<CriticalPath>
  getBlocked(orgId: string, filter?: GraphFilter): Promise<EntityRef[]>
  getReady(orgId: string, filter?: GraphFilter): Promise<EntityRef[]>
  getParallelSets(orgId: string, filter?: GraphFilter): Promise<EntityRef[][]>
  getImpact(orgId: string, ref: EntityRef): Promise<EntityRef[]>
  getCompletion(orgId: string, filter?: GraphFilter): Promise<{ total: number; closed: number; percentage: number }>

  // Write operations (proxy to issue tracker with dependency formatting)
  createIssue(orgId: string, data: CreateIssueWithDeps): Promise<{ issue: Issue; ref: EntityRef }>
  decompose(orgId: string, data: DecomposeRequest): Promise<{ issues: Issue[]; graph: GraphQueryResult }>

  // Sync
  sync(orgId: string, projectId?: string): Promise<{ parsed: number; edges: number; cycles: CycleError[] }>

  // Module
  status(): ModuleStatus
}
```

### Files

```
packages/server/src/planning/
├── types.ts             # (shared with graph engine)
├── parser.ts            # (shared with graph engine)
├── parser.test.ts
├── graph.ts
├── graph.test.ts
├── index.ts             # Dependency index persistence (cache read/write)
├── index.test.ts        # Dependency index tests
├── planning.ts          # Planning service (orchestration)
├── planning.test.ts     # Planning service tests
├── ws.ts                # WS channel registration
├── ws.test.ts           # WS tests
└── routes.ts            # Express REST API router
```

---

## Cross-Cutting Concerns

### Integration Tests

Phase 5 MUST include integration tests covering:

- Create issues with dependency references → sync → graph shows correct edges
- Cycle detection: create circular dependency → sync reports cycle error
- Blocked detection: issue A depends on open issue B → A is blocked; close B → A is ready
- Critical path: chain of dependent issues → critical path returns correct sequence
- Cross-project dependencies: issue in project A depends on issue in project B → graph spans both
- Batch decompose: create parent + child issues → graph shows hierarchy
- Incremental sync: update one issue body → only that issue is reparsed
- Graph filter: filter by milestone/label → subgraph contains only matching nodes
- Impact analysis: given node in middle of chain → impact returns all downstream nodes
- Completion rate: mix of open/closed issues → percentage correct
- WS notifications: graph update → subscribed clients receive `planning.graph.updated`
- Event-driven update: `issue.updated` event → dependency index updated automatically

Integration tests go in `packages/server/src/__integration__/phase5.test.ts`.

### Data Directory Extension

```
{dataDir}/
├── ... (Phase 1–4 directories)
├── planning/
│   └── {orgId}/
│       └── deps.json    # Dependency edge index (cached, derived)
```

### Dependencies (New)

No new external dependencies. The planning module uses:

- The issue tracker from Phase 4 (injected)
- The event bus from Phase 1
- The config module from Phase 3

### Module Registration

The Phase 5 module MUST follow the established pattern:

- Export `createPlanningService(bus: EventBus, dataDir: string, deps: PlanningDeps)` factory
- Export `status(): ModuleStatus`
- Communicate only via event bus and shared types from `@sovereign/core`
- Express router mounted by the main server, not self-mounting
- Read configuration from the config module (Phase 3)
- MUST NOT import from issues module internals — only via injected `IssueTracker` interface

### Testing

- **Parser tests** — test dependency extraction from markdown strings (inline fixtures, no I/O)
- **Graph tests** — test pure graph computation (topological sort, critical path, cycle detection, etc.) with hand-built node/edge sets
- **Index tests** — test cache persistence (write/read/rebuild) with temp directories
- **Service tests** — test orchestration with mocked issue tracker (no real GitHub/Radicle)
- **WS tests** — test channel registration and message emission
- **Integration tests** — end-to-end flow from issue creation through graph queries

### Config

No new config namespace. The planning module reads project configuration from the existing `projects` namespace to determine which remotes/providers each project uses.

Planning-specific configuration (if needed later) SHOULD use `planning.*` namespace, but Phase 5 requires no configurable values — all behaviour is derived from the issue tracker and graph computation.
