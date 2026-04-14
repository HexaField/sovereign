# CI baseline fix spec

## Objective

Restore the current client CI baseline by fixing the TypeScript check failures in `packages/client/src/features/workspace/WorkspaceView.tsx` and aligning the workspace tests/types with the current sidebar model, without changing unrelated behaviour or expanding scope beyond the failing CI baseline.

## Problem statement

The repository's CI `check` step currently fails in `@sovereign/client` during `tsc --noEmit`. Reproduced locally with `pnpm run check`, which reports:

- unused imports in `WorkspaceView.tsx` for `threads` and `createThread`
- an invalid comparison against sidebar tab key `'threads'`
- invalid property access on the value narrowed from `Show` in file-viewer branches, where TypeScript still allows `""` in the union instead of only `OpenFileTab`

These baseline type errors block PR CI even when unrelated changes are made.

## Scope

In scope:

- `WorkspaceView.tsx` fixes required for the current `pnpm run check` failure
- workspace tests updated only as needed to match the current sidebar/tab model
- verification with the actual failing checks and related client checks

Out of scope:

- feature additions
- unrelated refactors
- server/core changes unless a directly dependent check proves necessary
- broad UI redesign or thread feature redesign

## Acceptance criteria

1. Given the current repo state, when `pnpm run check` is executed, then the command completes successfully.
2. Given `WorkspaceView.tsx`, when TypeScript checks it, then there are no unused imports or unreachable sidebar-tab comparisons.
3. Given the desktop and mobile file-viewer branches, when the active tab is resolved, then the component accesses file-tab properties through a value that TypeScript can safely narrow to `OpenFileTab`.
4. Given the workspace tests, when they assert available sidebar tabs, then they reflect the current `SidebarTab`/`SIDEBAR_TABS` contract.
5. Given the change set, when reviewed, then it remains tightly scoped to CI-baseline fixes only.

## Behaviour spec

### A. Sidebar tab handling

- Input/trigger: rendering sidebar content or asserting sidebar-tab options in tests.
- Expected behaviour: the code only references sidebar keys that exist in the current `SidebarTab` union and `SIDEBAR_TABS` constant.
- Error handling: no compile-time unreachable comparisons against removed keys.
- Edge case: tests must not rely on stale tab keys that are no longer part of the current sidebar.

### B. File-viewer tab resolution

- Input/trigger: rendering the active file tab in desktop and mobile file-viewer branches.
- Expected behaviour: the selected tab is resolved through a typed lookup/memo that yields `OpenFileTab | null` (or equivalent safe type), and `FileViewerTab` receives `path`, `projectId`, and `id` from that typed value.
- Error handling: if no active file tab exists, the existing fallback UI remains rendered.
- Edge case: `activeFileTabId()` may be null, and lookups may return no matching tab; both paths must keep fallback behaviour unchanged.

### C. Unused thread-store imports

- Input/trigger: TypeScript compilation of `WorkspaceView.tsx`.
- Expected behaviour: only imports used by the component remain imported.
- Edge case: removing unused imports must not alter runtime behaviour.

## Data/API/component boundaries

- No data model changes.
- No API surface changes.
- Components touched:
  - `packages/client/src/features/workspace/WorkspaceView.tsx`
  - `packages/client/src/features/workspace/WorkspaceView.test.ts` (if needed for alignment)

## Implementation design

### File-level plan

1. `specs/ci-baseline-fix.md`
   - Record the problem, acceptance criteria, and implementation plan.
2. `packages/client/src/features/workspace/WorkspaceView.tsx`
   - Remove unused thread-store imports.
   - Remove the stale `'threads'` sidebar `Match` branch.
   - Introduce typed active-tab memos/helpers for desktop and mobile file-viewer rendering so `FileViewerTab` props are type-safe.
3. `packages/client/src/features/workspace/WorkspaceView.test.ts`
   - Update stale expectations so tests match the current sidebar-tab contract.

### Key decisions

- Prefer a tiny type-safe helper/memo over casts so the fix is explicit and maintainable.
- Remove stale sidebar references rather than reintroducing the deprecated sidebar key, keeping the change aligned with the existing store contract.
- Limit test changes to contract alignment; do not expand unrelated coverage unless directly helpful for this regression.

### Risks

- Solid `Show` control-flow typing can be subtle; the selected-tab helper must avoid ambiguous falsy unions.
- Removing a stale `'threads'` branch must stay consistent with current tests and store definitions.

## Verification plan

- Run the reproduced failing command: `pnpm run check`
- Run targeted client tests impacted by the change
- Run any additional baseline build/test checks needed to confirm CI parity for this scope
