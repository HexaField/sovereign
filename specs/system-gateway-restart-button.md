# System Gateway Restart Button

## Ticket / problem statement

Operators can see Sovereign's system and device status, but they cannot restart the OpenClaw gateway from the System view when the local gateway gets wedged or needs a controlled bounce. Today recovery requires leaving the app and manually running the OpenClaw CLI. That slows down recovery and gives no in-app feedback about whether the device reconnected after the restart.

## Proposed solution

Add a restart control to the System view's Devices tab and back it with a server endpoint that triggers `openclaw gateway restart` via the OpenClaw CLI. The client should disable duplicate requests, surface restart progress, and poll the devices endpoint until the current device reconnects or a timeout is reached.

## Requirements

- System operators can trigger an OpenClaw gateway restart from the System view.
- The server exposes a safe restart endpoint that uses first-class OpenClaw CLI support rather than shell string execution.
- Concurrent restart requests are rejected while a prior restart is still in flight.
- The UI communicates restart progress, reconnect recovery, and failure states.
- The UI refreshes device data after the restart request and after reconnect polling completes.

## Acceptance criteria

1. **Happy path**
   - Given the user is on the System → Devices tab,
   - when they press the restart button,
   - then the client issues `POST /api/system/gateway/restart`, disables the button, shows restart progress, and reports success once the current device returns to `connected`.
2. **Duplicate protection**
   - Given a restart request is already running,
   - when another restart request reaches the server,
   - then the server responds with `409` and does not start a second restart.
3. **Failure handling**
   - Given the OpenClaw CLI restart fails,
   - when the endpoint is called,
   - then the server returns `500` with a useful error and the UI surfaces that message.
4. **Reconnect timeout handling**
   - Given the restart was accepted but the current device does not return to `connected` before the timeout,
   - when the client finishes polling,
   - then the UI keeps the device list usable, re-enables the button, and shows a message instructing the operator to inspect device status.
5. **No device crash on transient fetch failures**
   - Given the gateway is bouncing during restart,
   - when device fetches temporarily fail,
   - then reconnect polling tolerates those failures and continues until success or timeout.

## Scope and constraints

### In scope

- System Devices tab restart button, labels, and progress messaging.
- `POST /api/system/gateway/restart` server endpoint.
- OpenClaw CLI-backed restart service using structured child-process execution.
- Automated tests for the server route and client restart helpers.

### Out of scope

- Restarting any service other than the OpenClaw gateway.
- Adding authentication/authorization layers beyond the existing app boundary.
- Streaming restart logs into the UI.
- Changing tabs or broader System page layout.

## Behaviour spec

### Client: Devices tab

- Render a restart button near the device list controls.
- Button states:
  - `idle`: enabled, label `Restart OpenClaw Gateway`.
  - `restarting`: disabled, label `Restarting Gateway…`.
  - `recovering`: disabled, label `Waiting for Reconnect…`.
- On click:
  1. Ignore the action if state is not `idle`.
  2. Show `Restarting OpenClaw gateway…`.
  3. Call `POST /api/system/gateway/restart`.
  4. Refresh device data once the request resolves.
  5. Enter reconnect polling mode and show either the server-provided message or `Gateway restart requested. Waiting for reconnect…`.
  6. Poll `/api/system/devices` until the current device reports `connected`, tolerating transient fetch failures.
  7. Refresh device data again after polling completes.
  8. Show either a reconnect success message or a reconnect-timeout message.
  9. Re-enable the button after completion or failure.
- If the component unmounts mid-flight, ignore late async updates.

### Server: restart endpoint

- Route: `POST /api/system/gateway/restart`.
- Success response: HTTP `202` with `{ status: 'accepted', message, command }`.
- If a restart is already in progress: HTTP `409` with `{ error: 'Gateway restart already in progress' }`.
- If the restart service throws: HTTP `500` with `{ error }`.
- Default service implementation executes `openclaw gateway restart` via `execFile('openclaw', ['gateway', 'restart'])` with a bounded timeout and buffer.

### Edge cases

- Non-JSON or empty success payloads still map to a usable default `status: 'accepted'`.
- Temporary device fetch failures during restart do not abort reconnect polling.
- If the current device never becomes `connected`, return `timeout` rather than throwing.

## API surface changes

- New endpoint: `POST /api/system/gateway/restart`.
- New server abstraction: `GatewayRestartService` with `restart(): Promise<{ message: string; command: string }>`.
- New client helpers: `requestGatewayRestart()` and `waitForGatewayReconnect()`.

## Component boundaries

- `packages/server/src/system/routes.ts`: restart service + route wiring + in-flight guard.
- `packages/server/src/system/system.test.ts`: endpoint contract coverage.
- `packages/client/src/features/system/DevicesTab.tsx`: restart button UI, fetch helper, reconnect polling.
- `packages/client/src/features/system/DevicesTab.test.ts`: helper behaviour coverage.

## Implementation design

1. Add/update the spec first.
2. Keep the server change isolated to `system/routes.ts` using an injectable restart service for tests.
3. Keep client logic inside `DevicesTab.tsx` with small exported helpers to make restart and reconnect behaviour testable.
4. Extend server tests for `202`, `409`, and `500` cases.
5. Extend client tests for restart request success/failure and reconnect polling success/timeout.
6. Run targeted tests, then project checks, then manual browser verification in the running app.

## Verification plan

- Open the running app, navigate to System → Devices.
- Confirm the restart button is visible and enabled.
- Click the button and verify the label changes through restart/reconnect states.
- Confirm the backend receives the restart request and `openclaw gateway restart` is executed.
- Verify the UI recovers after the gateway reconnects and re-enables the button.
- Exercise at least one non-happy-path case manually or by direct API call (for example, duplicate in-flight protection or reconnect timeout messaging if reproducible).
