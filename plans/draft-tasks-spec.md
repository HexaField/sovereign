# Draft Tasks — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-19

This document specifies Draft Tasks for the Planning module. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/SHOULD/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

---

## Design Philosophy

**Local-first planning.** Drafts are local tasks that exist only in Sovereign's file store — they never touch a provider (GitHub, Radicle) until explicitly published. This lets users iterate on task breakdown, dependency structure, and prioritisation without polluting remotes with half-formed issues.

**First-class DAG citizens.** Drafts participate in the planning DAG identically to provider-sourced entities. They can depend on other drafts or on provider issues, and provider issues can depend on drafts. The graph engine treats them uniformly.

**Publish when ready.** A draft can be published to a specific workspace + project, at which point it becomes a provider issue. The local draft is replaced with a provider reference. Dependency links update automatically to point at the new provider ID.

---

## Data Model

### Draft

```typescript
interface Draft {
  id: string // Local UUID (crypto.randomUUID())
  title: string // Required, non-empty
  body: string // Markdown body, MAY contain dependency syntax
  labels: string[] // Freeform labels
  assignees: string[] // Freeform assignee names
  status: 'draft' | 'published' // Published drafts are historical records
  orgId: string | null // Optional workspace assignment (null = unassigned)
  projectId: string | null // Optional project assignment within org
  dependencies: DraftDep[] // Explicit dependency links
  createdAt: string // ISO-8601
  updatedAt: string // ISO-8601
  publishedAs: EntityRef | null // Set when published — the provider ref it became
}

interface DraftDep {
  type: 'depends_on' | 'blocks'
  target: DraftDepTarget
}

// A dependency target is either another draft or a provider entity
type DraftDepTarget = { kind: 'draft'; draftId: string } | { kind: 'provider'; ref: EntityRef }
```

### Storage

- Drafts MUST be stored at `{dataDir}/drafts/drafts.json` — a single JSON array.
- Writes MUST be atomic (write temp → rename).
- The store MUST NOT be scoped to any org — it is global.
- Published drafts (`status: 'published'`) MUST be retained for audit/history. A separate cleanup operation MAY remove them.

---

## Wave Strategy

**Wave 1:** Draft Store + API (server) **Wave 2:** DAG Integration (server — graph engine changes) **Wave 3:** Client UI (planning panel + DAG view) **Wave 4:** Publish Flow (server + client) **Wave 5:** Tests + Integration

---

## Wave 1: Draft Store + API

### 1.1 Draft Store

A file-backed CRUD store for drafts.

#### Requirements

- The store MUST implement `DraftStore`:

```typescript
interface DraftStore {
  list(filter?: DraftFilter): Draft[]
  get(id: string): Draft | undefined
  create(data: CreateDraft): Draft
  update(id: string, patch: UpdateDraft): Draft
  delete(id: string): void
  getByOrg(orgId: string | null): Draft[] // null = unassigned
}

interface DraftFilter {
  orgId?: string | null // Filter by workspace (null = unassigned only)
  status?: 'draft' | 'published'
  label?: string
}

interface CreateDraft {
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
  orgId?: string | null
  projectId?: string | null
  dependencies?: DraftDep[]
}

interface UpdateDraft {
  title?: string
  body?: string
  labels?: string[]
  assignees?: string[]
  status?: 'draft' | 'published'
  orgId?: string | null
  projectId?: string | null
  dependencies?: DraftDep[]
  publishedAs?: EntityRef | null
}
```

- `create` MUST generate a UUID, set `status: 'draft'`, `createdAt`/`updatedAt` to now, and `publishedAs: null`.
- `update` MUST set `updatedAt` to now.
- `delete` MUST remove the draft permanently (not soft-delete — published drafts serve as the historical record).
- `list` with no filter MUST return all non-published drafts.
- `getByOrg(null)` MUST return only unassigned drafts.
- All mutations MUST write to disk atomically.

#### File Layout

```
{dataDir}/
  drafts/
    drafts.json           # Array of Draft objects
```

### 1.2 REST API

#### Endpoints

| Method   | Path                                  | Description                                                   |
| -------- | ------------------------------------- | ------------------------------------------------------------- |
| `GET`    | `/api/drafts`                         | List drafts. Query: `?orgId=`, `?status=`, `?unassigned=true` |
| `POST`   | `/api/drafts`                         | Create draft. Body: `CreateDraft`                             |
| `GET`    | `/api/drafts/:id`                     | Get single draft                                              |
| `PATCH`  | `/api/drafts/:id`                     | Update draft. Body: `UpdateDraft`                             |
| `DELETE` | `/api/drafts/:id`                     | Delete draft                                                  |
| `POST`   | `/api/drafts/:id/publish`             | Publish draft to provider. Body: `{ orgId, projectId }`       |
| `POST`   | `/api/drafts/:id/dependencies`        | Add dependency. Body: `DraftDep`                              |
| `DELETE` | `/api/drafts/:id/dependencies/:index` | Remove dependency by index                                    |

#### Requirements

- `GET /api/drafts` MUST support query parameter filtering:
  - `?orgId=<id>` — drafts assigned to this workspace
  - `?unassigned=true` — drafts with `orgId: null`
  - `?status=draft` (default) or `?status=published` or `?status=all`
  - No filter returns all non-published drafts
- `GET /api/drafts?orgId=<id>` MUST also include unassigned drafts (they are globally visible). To get ONLY assigned drafts, the client filters client-side.
- `POST /api/drafts` MUST validate that `title` is non-empty. MUST return 400 otherwise.
- `PATCH /api/drafts/:id` MUST return 404 if draft not found.
- `DELETE /api/drafts/:id` MUST return 204 on success, 404 if not found.
- `POST /api/drafts/:id/publish` is specified in Wave 4.

---

## Wave 2: DAG Integration

The planning graph engine currently only knows about provider-sourced `IssueSnapshot` objects. Drafts MUST be injected into the graph as first-class nodes.

### 2.1 Graph Node Abstraction

#### Requirements

- `GraphNode` MUST gain a `source` discriminator:

```typescript
interface GraphNode {
  ref: EntityRef
  source: 'provider' | 'draft'
  state: 'open' | 'closed'
  labels: string[]
  milestone?: string
  assignees: string[]
  dependencies: EntityRef[]
  dependents: EntityRef[]
  // Draft-specific (only when source === 'draft')
  draftId?: string
  draftTitle?: string
}
```

- `EntityRef` for drafts MUST use a synthetic format: `{ orgId: '_drafts', projectId: '_local', remote: '_local', issueId: draft.id }`. This ensures no collision with real provider refs.
- The graph engine MUST NOT distinguish between draft and provider nodes for any graph computation (topological order, critical path, blocked/ready, parallel sets, impact analysis).

### 2.2 Draft Injection into Graph Build

#### Requirements

- `PlanningService.buildGraph()` MUST, after loading provider issues, also load drafts from the draft store.
- Drafts with `orgId` matching the requested org MUST be included. Unassigned drafts (`orgId: null`) MUST also be included in every graph build (they are global).
- Each draft MUST be converted to an `IssueSnapshot` equivalent using its synthetic `EntityRef`.
- Draft `dependencies` MUST be resolved to `DependencyEdge` objects:
  - `{ kind: 'draft', draftId }` → resolved to the draft's synthetic `EntityRef`
  - `{ kind: 'provider', ref }` → used directly as `EntityRef`
- Drafts MUST appear as `state: 'open'` in the graph (they are always open until published).
- After a draft is published, it MUST NOT appear in future graph builds (its `status` is `'published'`, filtered out by the store's default listing).

### 2.3 Dependency Edges Between Drafts and Provider Issues

#### Requirements

- A draft MAY depend on a provider issue. The edge MUST be: `{ from: draft.syntheticRef, to: providerRef }`.
- A draft MAY depend on another draft. The edge MUST be: `{ from: draft.syntheticRef, to: otherDraft.syntheticRef }`.
- A provider issue MAY reference a draft (via body text `depends on draft:<uuid>`). The parser MUST recognise `draft:<uuid>` patterns and resolve them to the draft's synthetic `EntityRef`.
- When a draft is published and becomes provider issue `#N`, all other drafts that depended on it MUST have their `dependencies` updated to point at the new provider `EntityRef` instead of the old `{ kind: 'draft', draftId }`.

---

## Wave 3: Client UI

### 3.1 Planning Sidebar — Drafts Section

#### Requirements

- The Planning sidebar panel MUST show a "Drafts" section above the provider issue sections (Ready, In Progress, Blocked).
- The Drafts section MUST show all drafts visible to the current workspace:
  - Drafts assigned to the active workspace's `orgId`
  - Unassigned drafts (always visible)
- Each draft item MUST display: title, labels (as chips), assigned workspace name (or "Unassigned").
- There MUST be an inline "New Draft" input at the top of the Drafts section — type a title and press Enter to create a draft.
- Clicking a draft MUST open an edit panel in the main content area (see §3.3).
- Drafts MUST be visually distinct from provider issues (e.g. dashed border, draft icon, muted colour).
- Drafts SHOULD show a dependency count badge if they have dependencies.

### 3.2 DAG View — Draft Nodes

#### Requirements

- Draft nodes MUST appear in the DAG alongside provider nodes.
- Draft nodes MUST be visually distinct: dashed border, different fill colour (e.g. a muted amber/yellow vs the green/red/grey of provider nodes).
- Draft nodes MUST show their title (not a provider issue number).
- Dependency edges to/from drafts MUST render identically to provider edges (same arrow style).
- Clicking a draft node in the DAG MUST open the edit panel (same as clicking in sidebar).

### 3.3 Draft Edit Panel

#### Requirements

- The edit panel MUST open in the main content area (replacing file editor / DAG view).
- Fields:
  - **Title** — editable text input, auto-saves on blur or Enter.
  - **Body** — multi-line textarea, markdown. Auto-saves on blur.
  - **Labels** — inline tag input (type + Enter to add, click × to remove).
  - **Workspace** — dropdown to assign/reassign to a workspace, or "Unassigned".
  - **Project** — dropdown (only shown when workspace is assigned), scoped to the workspace's projects.
  - **Dependencies** — list of current dependencies with remove button. "Add dependency" button opens a picker.
- The dependency picker MUST show:
  - Other drafts (searchable by title)
  - Provider issues from the assigned workspace (searchable by title/number)
  - A search input to filter both lists
- Changes MUST auto-save (debounced PATCH to server, ~500ms after last keystroke).
- A "Publish" button MUST be visible when the draft has a workspace + project assigned. Clicking it triggers the publish flow (Wave 4).
- A "Delete" button MUST be present with a confirmation prompt.

### 3.4 Client Store

#### Requirements

- A `drafts` store MUST be created at `features/drafts/store.ts`.
- The store MUST expose:

```typescript
// Signals
drafts(): Draft[]
selectedDraftId(): string | null

// Actions
fetchDrafts(orgId?: string): Promise<void>
createDraft(title: string): Promise<Draft>
updateDraft(id: string, patch: UpdateDraft): Promise<void>
deleteDraft(id: string): Promise<void>
publishDraft(id: string, orgId: string, projectId: string): Promise<void>
selectDraft(id: string | null): void
addDependency(id: string, dep: DraftDep): Promise<void>
removeDependency(id: string, index: number): Promise<void>
```

- `fetchDrafts` MUST be called when the Planning tab becomes active and when the workspace changes.
- The store MUST refetch after create/update/delete/publish to keep the list fresh.

---

## Wave 4: Publish Flow

### 4.1 Server — Publish Endpoint

#### Requirements

- `POST /api/drafts/:id/publish` MUST:
  1. Validate that the draft exists and has `status: 'draft'`.
  2. Accept `{ orgId, projectId }` in the body (MAY override the draft's current assignment).
  3. Determine the correct provider for the project (GitHub or Radicle) via `getRemotes`.
  4. Create the issue on the provider via `issueTracker.create()`:
     - Title from draft
     - Body from draft, with dependency syntax appended for any provider-targeted dependencies
     - Labels and assignees from draft
  5. Update the draft: set `status: 'published'`, `publishedAs: { orgId, projectId, remote, issueId: newIssue.id }`.
  6. Update all other drafts that depended on this draft: replace `{ kind: 'draft', draftId }` with `{ kind: 'provider', ref: publishedAs }`.
  7. Return the created issue and the updated draft.

- If the provider create fails, the endpoint MUST return 502 with the error and MUST NOT change the draft's status.
- The endpoint MUST emit `planning.draft.published` on the event bus.

### 4.2 Client — Publish Dialog

#### Requirements

- Clicking "Publish" on a draft MUST open a confirmation dialog showing:
  - Draft title
  - Target workspace + project (editable dropdowns, pre-filled from draft assignment)
  - A list of dependencies that will be included in the issue body
  - "Publish" and "Cancel" buttons
- After successful publish, the draft MUST disappear from the Drafts section and appear as a provider issue in the appropriate section (Ready/In Progress/Blocked).
- The client MUST show a brief success toast: "Published as #{issueNumber} in {projectName}".

---

## Wave 5: Tests + Integration

### 5.1 Server Tests

#### Requirements

- `drafts/store.test.ts` — CRUD operations, filtering, atomic writes, concurrent access safety.
- `drafts/routes.test.ts` — all REST endpoints, validation (empty title → 400, not found → 404), query parameter filtering.
- `planning/planning.test.ts` — verify drafts appear in graph builds, dependency resolution (draft→draft, draft→provider, provider→draft), publish updates dependency links.
- `planning/graph.test.ts` — verify graph engine handles mixed draft+provider nodes for all query types (blocked, ready, critical path, etc.).

### 5.2 Client Tests

#### Requirements

- `drafts/store.test.ts` — store actions, fetch lifecycle, optimistic updates.
- `PlanningPanel.test.ts` — drafts section renders, inline creation, click to edit.
- `DraftEditPanel.test.ts` — field editing, auto-save, dependency picker, publish button visibility.

### 5.3 Spec Tests (stub `it.todo`)

Every MUST requirement in this spec MUST have a corresponding `it.todo()` stub before implementation begins. These stubs define the test contract.

---

## Integration Points

| Module | Integration |
| --- | --- |
| Planning Service | Injects drafts into `buildGraph()` alongside provider issues |
| Issue Tracker | `publish` calls `issueTracker.create()` to push to provider |
| Event Bus | `planning.draft.created`, `planning.draft.updated`, `planning.draft.deleted`, `planning.draft.published` events |
| Orgs | Draft `orgId` references org registry; workspace dropdown uses org list |
| Config | No config dependencies — drafts are always enabled |

## Non-Goals (Explicit)

- **Drag-and-drop reordering** — MAY be added later, not in this spec.
- **Draft templates** — out of scope.
- **Bulk publish** — out of scope (publish one at a time).
- **Draft comments/discussion** — out of scope.
- **Effort/size estimation on drafts** — deferred per user request ("will add later as needed").
- **Offline queue for publish** — if provider is unreachable, publish fails. No queuing.
