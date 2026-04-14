# Spec: Harden OpenClaw gateway handshake and auth token selection

## Objective

Make the Sovereign server's OpenClaw backend connect deterministically to the gateway: the configured `OPENCLAW_GATEWAY_TOKEN` must override any stale persisted device token during the initial handshake, and no RPC request may be sent until the gateway handshake has completed successfully.

## Problem Statement

Sovereign can get stuck in `connecting` even when the local gateway is up. Two protocol bugs contribute to that state:

- the backend currently prefers a persisted device token over the configured `gatewayToken`, so a stale token on disk can override the operator-provided `OPENCLAW_GATEWAY_TOKEN` and cause an unauthorized handshake
- the backend currently allows normal RPC requests as soon as the WebSocket is open, even if the handshake is still in progress, so gateway methods like `sessions.list` or `chat.send` can be sent before `connect` completes and trigger `invalid handshake: first request must be connect`

These failures leave the backend disconnected or flapping, and the watchdog reports the gateway as unavailable even though the local gateway itself is reachable.

## Requirements

- The OpenClaw backend MUST prefer the configured `gatewayToken` over any persisted device token when building the `connect` handshake auth payload.
- The persisted device token MUST still be used as a fallback when no configured `gatewayToken` is present.
- The backend MUST NOT send any non-`connect` RPC request until the handshake has completed successfully.
- Requests attempted before handshake completion MUST wait for readiness instead of racing the gateway protocol.
- If handshake completion fails, waiting RPC requests MUST reject rather than hang indefinitely.
- Existing successful handshake behaviour, device token persistence, and reconnect behaviour MUST remain intact.

## Acceptance Criteria

1. **Given** a persisted device token exists on disk and `gatewayToken` is configured, **when** the backend sends the `connect` request, **then** the configured token is used in `auth.token`.
2. **Given** no configured `gatewayToken` is present and a persisted device token exists, **when** the backend sends the `connect` request, **then** the persisted token is used in `auth.token`.
3. **Given** the WebSocket is open but the gateway has not yet sent or accepted `connect.challenge`/`connect`, **when** backend code issues another RPC like `sessions.list`, **then** that RPC is not sent until after the `connect` handshake succeeds.
4. **Given** the handshake never completes or is rejected, **when** an RPC is waiting on readiness, **then** the RPC rejects with a connection/handshake failure instead of sending early.
5. **Given** the local OpenClaw gateway is healthy and the correct configured token is available, **when** Sovereign restarts, **then** `/api/system/watchdog` reports the gateway check as reachable/connected.

## Scope

- `packages/server/src/agent-backend/openclaw.ts`
- Focused regression coverage in `packages/server/src/agent-backend/openclaw.test.ts`
- Manual verification against the live local gateway at `ws://127.0.0.1:18789/ws`
- Restarting the local Sovereign service/process and checking `/api/system/watchdog`

## Out of Scope

- Changes to the OpenClaw gateway protocol itself
- Broad auth/device-pairing UX changes outside the server backend
- Client-side connection state UI changes unless required by the backend fix

## Behaviour Spec

### Auth token selection

- When a handshake challenge arrives, the backend resolves the auth token in this order:
  1. configured `gatewayToken` if non-empty
  2. persisted device token for the current device if present
  3. empty string otherwise
- If the gateway returns a replacement `deviceToken` in the successful `connect` response, the backend persists it as before.

### Handshake readiness gate

- The backend tracks handshake readiness separately from raw WebSocket open state.
- The internal request path waits for handshake completion before sending any non-`connect` RPC.
- The `connect` RPC itself remains the first request sent after `connect.challenge`.
- If the socket closes or handshake fails while requests are waiting, those requests reject promptly with the underlying connection failure.
- After reconnect, the readiness gate resets and again blocks non-`connect` RPC traffic until the new handshake completes.

## Component Boundaries

- `openclaw.ts` owns handshake state, token resolution, and RPC request gating.
- `openclaw.test.ts` owns regression tests for token precedence and handshake ordering.
- No API surface changes are required outside the backend internals.

## Implementation Design

### File-level plan

- **`specs/openclaw-gateway-handshake-hardening.md`**: spec and implementation contract for the fix.
- **`packages/server/src/agent-backend/openclaw.ts`**: add handshake-ready state/promise helpers, gate requests on readiness, and change auth token precedence to prefer configured token.
- **`packages/server/src/agent-backend/openclaw.test.ts`**: add regression tests covering configured-token precedence and deferred RPC sending until after handshake completion.

### Key decisions

- Treat handshake completion, not socket openness, as the condition for request readiness.
- Keep the fix minimal and internal: no public API changes, just corrected auth precedence and request sequencing.
- Preserve persisted device tokens for reuse, but never let them override an explicit operator configuration.

### Risks and mitigations

- **Deadlock risk:** the `connect` request must bypass the readiness gate; only follow-on RPCs should wait.
- **Reconnect race risk:** readiness state must reset on each new socket so stale success does not leak across reconnects.
- **Regression risk:** add tests that assert exact message order on the wire and exact token chosen in the handshake.
