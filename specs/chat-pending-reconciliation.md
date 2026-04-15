# Chat Pending-State Reconciliation Cleanup

## Objective

Clean up Sovereign chat send-state handling so the UI reflects the real direct-send model: optimistic user messages should show `Pending…` while awaiting authoritative reconciliation, failed sends should expose retry/remove actions, and stale queue-era wording or behaviour should be removed.

## Problem statement

Sovereign no longer uses the old server-side message queue in the live chat send path, but the client still leaks queue-era semantics:

- pending optimistic user bubbles still render `Queued`
- the message context menu still says `Remove from queue`
- accepted sends can remain visually pending until a manual page refresh
- failed-send transitions do not consistently clear the pending state

That leaves the UI out of sync with the actual model and breaks the intended single-source-of-truth approach.

## Proposed solution

Keep backend history and authoritative turn events as the source of truth for committed chat transcript state, while treating client pending-send tracking as ephemeral transport metadata only. Rename stale queue-era UI to `Pending…`, ensure failed sends transition to explicit failed state, and trigger authoritative history refresh whenever an unresolved optimistic user turn still exists at a lifecycle boundary that should reconcile it.

## Requirements

- Replace stale queue wording with pending/send-failure wording.
- Ensure optimistic user turns do not require a full page refresh to reconcile once the backend has progressed the thread.
- Keep the rendered transcript sourced from authoritative history/turn events, not local queue state.
- Invalidate or refresh cached history whenever a chat event should make it stale.
- Keep the change tightly scoped to chat send/reconciliation cleanup.

## Acceptance criteria

1. Given an optimistic user message is awaiting authoritative reconciliation, when rendered, then the bubble shows `Pending…`, not `Queued`.
2. Given a send fails or is rejected, when the client marks it failed, then the bubble no longer remains pending and instead shows failed-state UI with retry/remove affordances.
3. Given an assistant turn or idle transition completes while unresolved optimistic user turns still exist, when reconciliation logic runs, then the client requests authoritative history without needing a page refresh.
4. Given the pending-message context menu is opened, when the message is still optimistic, then its action wording no longer references a queue and the action is actually wired.
5. Given chat history is cached for performance, when a turn event should invalidate that cached history, then the invalidation path still causes the next reconciliation fetch to observe fresh data.

## Scope

In scope:

- `packages/client/src/features/chat/store.ts`
- `packages/client/src/features/chat/MessageBubble.tsx`
- focused chat tests covering pending/failure/reconciliation behaviour

Out of scope:

- larger chat architecture rewrites
- changing the backend protocol shape
- removing every legacy queue helper file if it is currently dead but harmless

## Implementation design

- Add small helpers in the chat store for unresolved optimistic user turns and idle reconciliation decisions.
- Ensure nack/timeout/failure paths clear `pending` alongside setting `sendFailed`.
- Update both SSE and WS fallback lifecycle handling so unresolved optimistic user turns trigger history refresh on the relevant transition.
- Rename stale queue-era UI text in `MessageBubble` and wire the pending-message removal action.
- Add regression tests for the failure-state and reconciliation logic.

## Verification plan

- Run focused chat store/message tests locally.
- Build the merged client/server artifacts locally.
- Restart Sovereign from clean `main`.
- Verify in the running app that a sent message shows `Pending…` rather than `Queued`, and that it reconciles without manual page refresh.
- Verify a failure path still exposes retry/remove behaviour.
