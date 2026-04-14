# Spec: Preserve distinct thinking work-item boundaries in watched threads

## Objective

Ensure live chat threads preserve separate agent thinking entries when OpenClaw emits multiple reasoning steps in one turn. Watching a running thread should show each distinct thinking message as its own item, while still updating an in-progress thinking block in place when the backend is streaming cumulative text for that same block.

## Problem Statement

Sovereign already parses stored history correctly: `parseTurns()` preserves separate assistant text blocks around tool calls as distinct `thinking` work items. The live watched-thread path does not. In the client chat store, every incoming live `thinking` work item replaces the previous live `thinking` item whenever it is the last item in `liveWork`, regardless of whether the new payload is an incremental extension of the same reasoning block or a brand-new reasoning step.

That means the live UI can collapse multiple thinking steps into one apparent blob while a thread is being watched. Once history reloads, the persisted turn is correct, but the live watched-thread experience is wrong and misleading.

## Requirements

- Live watched threads MUST preserve distinct thinking entries when consecutive `thinking` work items represent different reasoning steps.
- Live watched threads MUST continue replacing the current thinking item when the backend is sending cumulative updates for the same reasoning block.
- The distinction MUST be deterministic and local to the client store; no protocol change is required for this fix.
- Existing tool-call / tool-result ordering MUST remain unchanged.
- Stored history parsing behaviour MUST remain unchanged.

## Acceptance Criteria

1. **Given** a live thinking update whose text is an extension of the previous live thinking item's text, **when** the client receives it, **then** the client replaces the previous thinking item instead of appending a new one.
2. **Given** a live thinking update whose text does not extend the previous live thinking item's text, **when** the client receives it, **then** the client appends a new thinking item so both steps remain visible.
3. **Given** a tool call between two thinking updates, **when** the client receives the later thinking update, **then** it is appended as a new item after the tool call.
4. **Given** persisted history for the same turn, **when** the turn is later reloaded from the server, **then** the stored work-item boundaries remain unchanged.

## Scope

- Client chat-store logic for merging live `thinking` work items.
- Focused regression tests covering the live merge behaviour.
- No gateway protocol changes.
- No server history parsing changes unless additional evidence shows they are required.

## Out of Scope

- Redesigning the SSE protocol.
- Adding explicit work-item IDs to live thinking events.
- Changing `parseTurns()` history semantics.
- UI redesign of `WorkSection` or message rendering.

## Component Boundaries

- `packages/client/src/features/chat/store.ts` owns the live `thinking` merge policy.
- `packages/server/src/agent-backend/parse-turns.ts` remains the owner of persisted history parsing.
- `packages/server/src/chat/routes.ts` and `packages/server/src/chat/chat.ts` continue to relay/replay live work without semantic changes for this fix.

## Implementation Notes

- Treat a live thinking event as an in-place update only when the new text clearly extends the previous live thinking text (prefix match after trimming the existing value).
- Otherwise treat it as a new thinking boundary and append it.
- Encapsulate the merge policy in a small helper so it can be unit-tested directly.
