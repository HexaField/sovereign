# Spec: Dashboard — Expanded Thread View

## Objective

Add an expanded thread view to the Dashboard which shows the 6 most recent threads in a horizontally scrollable container, and an expand/collapse control that toggles between the existing dashboard content and this thread view.

This makes threads discoverable from the Dashboard and provides a quick way to navigate to a thread without leaving the dashboard context.

## Problem Statement

Users need a fast way to see and jump to recent threads from the Dashboard. Currently thread previews are available per-workspace and in the quick switch modal, but the Dashboard doesn't provide a consolidated, horizontally-scrollable strip showing the latest global activity with an easy expand/collapse control.

## Proposed Solution

- Add a compact, horizontally-scrollable strip that lists the 6 most recently active threads (server-ordered by lastActivity desc) with: label, status dot, relative last-activity time, unread count.
- Add an expand/collapse button in the Dashboard Quick Actions row that toggles between the current dashboard content and the new thread view.
- Fetch threads from `/api/threads` (use the existing REST API). No server changes required.
- Implement responsive design — cards are touch-friendly on mobile and the strip scrolls horizontally.

## Requirements (observable behaviour)

1. A toggle button exists in the Dashboard Quick Actions row with data-testid `toggle-threads-view`.
2. When the toggle is active (threads view), the dashboard content (workspace cards, activity feed, notifications, voice widget) is replaced by the thread view component.
3. Thread view displays up to 6 most recently active threads fetched from `/api/threads`, in order of lastActivity descending.
4. Each thread card shows: status dot (working/failed/idle visual), thread label (fallback to key), relative last activity time, and unread count if > 0.
5. Clicking a thread card switches to the workspace view and selects that thread (using existing client navigation: setActiveWorkspace + setActiveView('workspace') + switchThread).
6. The thread strip is horizontally scrollable with appropriate snap alignment and mobile-friendly spacing.
7. If no threads are returned, the strip gracefully shows "No threads found".

## Acceptance Criteria

- Given a Dashboard, when the user clicks the toggle, then the UI switches to the thread view and shows up to 6 threads.
- Given the thread view is active, when the user clicks a thread card, then the app navigates to the thread's workspace view and selects that thread.
- Given fewer than 6 threads exist, the thread view shows exactly the returned threads without layout breakage.
- Given `/api/threads` returns an empty array, the thread view shows "No threads found" and does not crash.

## Constraints & Scope

- Work only in the client package; server endpoints are consumed as-is.
- Keep changes focused to Dashboard view and a new thread view component.
- No global state changes other than normal navigation calls.

## Implementation Design (file-level plan)

Files to add or modify:

- Add: `packages/client/src/features/dashboard/DashboardThreadsView.tsx` — new component that fetches `/api/threads`, displays up to 6 thread cards in a horizontally-scrollable container, handles click navigation.
- Modify: `packages/client/src/features/dashboard/DashboardView.tsx` — import new component, add a showThreadsView signal, add toggle button to Quick Actions row, and conditionally render the thread view in place of existing dashboard content.
- Add test: `packages/client/src/features/dashboard/DashboardThreadsView.test.ts` — simple unit test ensuring the component exists (follows project test patterns).
- Spec file (this document) added to `specs/`.

Key decisions:

- Use `/api/threads` since the server returns threads sorted by gateway lastActivity. Slice to six on the client.
- Do not attempt to resolve preview messages to keep implementation reliable and network-light.
- Reuse existing navigation helpers (setActiveWorkspace, setActiveView, switchThread) for consistent behaviour.

Order of implementation:

1. Write spec (this file).
2. Implement DashboardThreadsView component.
3. Wire toggle into DashboardView and conditionally render the thread view.
4. Add a basic unit test.
5. Run unit tests and lint/type checks.
6. Launch dev server, create some threads via API, and verify visually with screenshots.

Risk areas

- Cross-origin/TLS issues when starting dev server locally (vite + HTTPS certs). Mitigation: repo provides `pnpm certs` script to generate `.certs/localhost.{key,cert}`.
- Server may have no threads initially — manual test will create threads via POST `/api/threads`.

## Testing

- Unit: DashboardThreadsView.test.ts ensures component is defined.
- Manual E2E: start client+server dev server, POST to `/api/threads` to create sample threads (6), open the dashboard in a browser, click toggle and verify thread cards present, click a thread and verify navigation.

## Manual Verification Steps

1. Generate certs: `pnpm certs` at repository root.
2. Start dev servers: `VITE_API_URL=https://localhost:3001 pnpm dev` (runs client + server).
3. Create threads for testing (six POST requests to `https://localhost:3001/api/threads` with JSON bodies `{ "label": "Thread X" }`).
4. Open https://localhost:3000 in browser, wait for networkidle.
5. Click the toggle (data-testid `toggle-threads-view`) to expand the thread view.
6. Confirm the strip shows up to 6 cards and is horizontally scrollable.
7. Click a card and confirm navigation to workspace view and selected thread (URL hash `#thread=<key>`).

## Notes

- This spec intentionally keeps changes small and reversible, respecting existing UI patterns.
- If further UX refinement is requested (preview messages, richer status badges, persistent toggle state), open follow-up issues.
