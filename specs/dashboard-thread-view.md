# Dashboard thread-focused view spec

## Objective

Add a dashboard-level expand/collapse control that keeps the current dashboard as the default collapsed state and switches into a thread-focused mode on demand. The thread-focused mode should surface the six most recently active threads, ordered by recency, in a horizontally scrollable strip so users can jump from the dashboard straight into active work without losing the existing dashboard layout as the baseline experience.

## Problem statement

The current dashboard shows workspace thread previews inside each workspace card, but it does not provide a single thread-centric mode for quickly scanning the most recent work across the system. Users have to stay in the mixed dashboard layout or navigate into the workspace view to focus on threads.

## Proposed solution

Add a view toggle inside `DashboardView` that swaps between the existing dashboard content and a dedicated recent-threads mode. Implement the thread-focused mode using the existing `/api/threads` listing pattern, extended to respect a `limit` query parameter so the client can request only the six most recent threads. Reuse the existing navigation behaviour used by dashboard thread previews so clicking a recent thread opens the workspace view on that thread.

## Requirements

1. The dashboard defaults to the current mixed dashboard layout when first loaded.
2. A visible expand/collapse button in the dashboard toggles between:
   - the existing dashboard view, and
   - a thread-focused dashboard view.
3. The thread-focused view fetches and renders the 6 most recent threads across all workspaces.
4. Recent threads are ordered by descending `lastActivity`.
5. The recent-thread row is horizontally scrollable, including when all 6 items do not fit on screen.
6. Clicking a recent thread switches to the existing workspace/thread view using current dashboard navigation patterns.
7. The implementation stays scoped to the dashboard/thread-listing feature and remains production-ready.

## Acceptance criteria

### AC1 — default dashboard remains intact

**Given** the user opens Sovereign on the dashboard **when** no action has been taken on the new control **then** the current dashboard layout remains the default visible state **and** the thread-focused layout is not shown.

### AC2 — expand into thread-focused mode

**Given** the user is on the default dashboard **when** they activate the expand control **then** the dashboard swaps to a thread-focused view **and** the control updates to offer collapsing back to the default view.

### AC3 — recent thread list contents

**Given** there are more than 6 threads available **when** the thread-focused view loads **then** it requests recent threads using the existing thread-listing API pattern **and** displays exactly the 6 most recent threads by `lastActivity`.

### AC4 — horizontally scrollable layout

**Given** the thread-focused view is visible **when** the recent-thread cards exceed the viewport width **then** the row remains horizontally scrollable **and** each thread card keeps a fixed readable width instead of shrinking to illegibility.

### AC5 — navigation from dashboard recent threads

**Given** the user clicks a recent thread card from the thread-focused view **when** the interaction completes **then** Sovereign switches to the workspace view **and** activates the clicked thread using the existing dashboard thread navigation flow.

### AC6 — empty/error states

**Given** the recent-thread request returns no threads or fails **when** the thread-focused view renders **then** the dashboard shows a stable empty-state message instead of crashing **and** the expand/collapse control remains usable.

## Behaviour spec

### Dashboard toggle behaviour

- The control lives inside `DashboardView` and is always visible while the dashboard is active.
- Collapsed/default mode renders the existing dashboard content without changing its structure or data flow.
- Expanded/thread-focused mode replaces the main dashboard content region with a recent-thread section and supporting explanatory copy.
- The button label and accessibility text must reflect the current mode (`Expand threads` / `Collapse threads`, or equivalent clear wording).

### Recent thread fetching behaviour

- The client fetches recent threads from `/api/threads?limit=6`.
- Server-side thread ordering continues to use `lastActivity` descending after gateway activity reconciliation.
- The server respects `limit` when provided and applies it after sorting, so callers receive the true most-recent subset.
- Missing or invalid `limit` values fall back to the existing unbounded list behaviour.

### Recent thread rendering behaviour

- Each thread card shows the thread label (or key fallback), org label if available, relative last-activity text, and current agent-status affordance when available.
- The card row uses horizontal overflow scrolling and cards retain a minimum/fixed width for consistent scanning.
- Clicking a card uses the same state updates as dashboard thread previews: activate workspace, switch nav view, switch thread.

### Error and edge cases

- If `lastActivity` is missing, the card still renders with a safe fallback time label.
- If the fetch fails, the section renders a muted failure/empty message and does not throw.
- If fewer than 6 threads exist, all available threads are shown without filler items.
- The toggle remains responsive regardless of loading, empty, or failed thread fetch state.

## Data model changes

- None.

## API surface changes

- Extend `GET /api/threads` to honour an optional `limit` query parameter.

## Component boundaries

- `packages/client/src/features/dashboard/DashboardView.tsx`
  - owns the expand/collapse state and mode switch.
- `packages/client/src/features/dashboard/ThreadPreviews.tsx`
  - remains the per-workspace collapsed dashboard preview component.
- `packages/server/src/threads/routes.ts`
  - continues to provide sorted thread listings and gains optional `limit` handling.
- Tests:
  - client dashboard tests cover the new toggle/recent-thread helpers or structure assertions.
  - server thread route tests cover `limit` behaviour.

## Implementation design

### File-level plan

1. Update `specs/dashboard-thread-view.md` with the contract for the change.
2. Add dashboard recent-thread UI logic in `DashboardView.tsx`, keeping the current layout intact as the default mode.
3. Add any small dashboard helper utilities needed for formatting/thread projection in the dashboard feature folder.
4. Extend `packages/server/src/threads/routes.ts` to apply an optional `limit` after sorting.
5. Add/adjust tests for dashboard helper behaviour and thread route limit behaviour.
6. Add a focused Playwright dashboard test for the expand/collapse thread-focused flow.

### Key decisions

- Use the existing `/api/threads` route rather than inventing a dashboard-only endpoint.
- Keep default mode collapsed to preserve the current dashboard experience and minimise behavioural blast radius.
- Apply the `limit` on the server after sort so all callers requesting recent threads receive the correct subset.
- Reuse existing dashboard-to-workspace navigation functions rather than introducing new routing logic.

### Risks and mitigations

- **Risk:** `limit` is already passed by `ThreadPreviews` but currently ignored.  
  **Mitigation:** implement server-side support and verify existing previews continue to function.
- **Risk:** dashboard tests are mostly structural and node-based.  
  **Mitigation:** add route tests and focused dashboard helper assertions, then verify the UI end-to-end with Playwright/browser screenshots.
- **Risk:** dashboard fetch failures could leave the expanded view blank.  
  **Mitigation:** include explicit loading/empty/failure rendering paths.
