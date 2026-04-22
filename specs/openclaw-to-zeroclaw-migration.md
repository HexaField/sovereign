# Guide: Migrating Sovereign from OpenClaw to ZeroClaw

## Status of this guide

This guide is grounded in what is verifiably true in the repository on 2026-04-14.

**Important:** Sovereign is **not yet ZeroClaw-ready in this repo state**. The current server runtime, environment variables, session/history readers, and several system/thread endpoints still depend directly on OpenClaw gateway protocols and `~/.openclaw` files. This document is therefore a **repo-specific migration guide and cutover checklist**, not a claim that the migration has already been implemented.

Where facts are missing from the repo, assumptions are called out explicitly.

---

## 1. Objective

Replace Sovereign's current OpenClaw-backed agent runtime with ZeroClaw while preserving the existing Sovereign client/server contract as much as possible. The migration should remove hard dependencies on:

- OpenClaw gateway WebSocket handshake/auth
- OpenClaw-specific environment variables
- OpenClaw session files under `~/.openclaw/agents/main/sessions/`
- OpenClaw model/config file reads from `~/.openclaw/openclaw.json`
- OpenClaw workspace-specific file scanning conventions where they are only present for compatibility

The intended end state matches the direction already described in the repo's roadmap: Sovereign owns its own agent backend and no longer relies on an external OpenClaw bridge.

---

## 2. Problem statement

Today, Sovereign's UI is mostly backend-agnostic, but the server is still materially coupled to OpenClaw internals.

Verified examples from this repo:

- `packages/server/src/index.ts` constructs the backend with `createOpenClawBackend(...)`.
- `packages/server/src/agent-backend/openclaw.ts` implements the gateway handshake, auth token handling, reconnect logic, and event translation.
- `packages/server/src/system/routes.ts` derives `/api/system/context-budget` from the OpenClaw gateway HTTP endpoint and uses `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`.
- `packages/server/src/agent-backend/session-reader.ts`, `packages/server/src/threads/parse-gateway-sessions.ts`, `packages/server/src/threads/routes.ts`, and `packages/server/src/index.ts` read `~/.openclaw/agents/main/sessions/sessions.json` directly.
- `packages/server/src/threads/routes.ts` reads model configuration from `~/.openclaw/openclaw.json`.
- `packages/server/src/files/routes.ts` exposes `/api/files/workspace` using `OPENCLAW_WORKSPACE`.
- `README.md`, `.env.example`, `plans/PHASES.md`, and multiple specs still describe OpenClaw as the active runtime.

That means a production migration is not just a runtime swap. It is a controlled transition of configuration, storage, operational checks, and documentation.

---

## 3. Assumptions about ZeroClaw

The repo does not currently contain a ZeroClaw implementation or protocol spec. This guide therefore assumes the following target shape:

1. **ZeroClaw becomes Sovereign's active agent backend** and is the replacement for today's OpenClaw runtime.
2. **Sovereign keeps the existing `AgentBackend` abstraction** so the client does not need a protocol rewrite.
3. **ZeroClaw owns its own session/config/state layout** rather than reusing `~/.openclaw/...` paths.
4. **ZeroClaw may be embedded or locally networked**, but Sovereign should treat it as a first-class backend, not as an OpenClaw-compatible shim unless intentionally required during transition.
5. **Device pairing / gateway-auth semantics may disappear or change**. If ZeroClaw does not use OpenClaw's challenge-response device flow, the system/device UI must be updated accordingly.

If any of those assumptions are wrong, update this guide before cutover.

---

## 4. Current OpenClaw coupling inventory

This section is the migration baseline. Everything below was identified in the repo and should be reviewed during cutover.

### 4.1 Runtime/backend construction

**Primary coupling**

- `packages/server/src/index.ts`
  - Imports `createOpenClawBackend`
  - Instantiates it with:
    - `OPENCLAW_GATEWAY_URL`
    - `OPENCLAW_GATEWAY_TOKEN`

**Implication for migration**

- Server boot still assumes the backend provider is OpenClaw.
- A ZeroClaw migration needs either:
  - a drop-in backend replacement behind the same `AgentBackend` interface, or
  - provider selection logic (for staged rollout / rollback).

### 4.2 Backend implementation and protocol handling

- `packages/server/src/agent-backend/openclaw.ts`
- `packages/server/src/agent-backend/types.ts`
- `packages/server/src/agent-backend/openclaw.test.ts`
- `packages/server/src/server-wiring.test.ts`
- `packages/server/src/__integration__/phase6.test.ts`

**Verified OpenClaw-specific behaviour**

- WebSocket connection to a gateway URL
- `connect.challenge` / `connect` handshake
- OpenClaw device identity + signature flow
- gateway token precedence rules
- translation of OpenClaw message/event shapes into Sovereign `chat.*` events
- reconnection semantics tied to gateway behaviour

**Implication for migration**

- These are not neutral wrappers; they encode the OpenClaw wire protocol.
- ZeroClaw needs its own backend implementation and its own tests.

### 4.3 Session/history storage coupling

- `packages/server/src/agent-backend/session-reader.ts`
- `packages/server/src/threads/parse-gateway-sessions.ts`
- `packages/server/src/threads/routes.ts`
- `packages/server/src/index.ts`
- `packages/server/src/chat/ARCHITECTURE.md`
- `plans/phase-9-spec.md`

**Verified file dependency**

- `~/.openclaw/agents/main/sessions/sessions.json`
- session JSONL files under `~/.openclaw/agents/main/sessions/`

**What currently depends on those files**

- thread history loading
- session/activity maps
- subagent parent-child relationships
- session tree building
- model switching and session info
- gateway sessions endpoint used by the UI

**Implication for migration**

- ZeroClaw migration is blocked unless Sovereign either:
  - moves these features to a Sovereign-owned session index/store, or
  - implements a ZeroClaw-native equivalent and updates all readers.

The roadmap already points in this direction: `plans/PHASES.md` and `plans/phase-9-spec.md` explicitly call out removing the `sessions.json` dependency.

### 4.4 Model/config coupling

- `packages/server/src/threads/routes.ts`
  - reads `~/.openclaw/openclaw.json`
  - extracts `agents.defaults.models`
  - extracts `agents.defaults.model.primary`

**Implication for migration**

- Model discovery and default-model logic currently rely on OpenClaw config layout.
- ZeroClaw needs a replacement source of truth for:
  - available models
  - default model
  - persisted per-session model state

### 4.5 System endpoints and device/gateway UI

- `packages/server/src/system/routes.ts`
- `packages/client/src/features/system/DevicesTab.tsx`
- `packages/client/src/features/system/ThreadsTab.tsx`
- `packages/client/src/features/system/ContextBudgetModal.tsx`
- `packages/client/src/features/system/FlowGraph.tsx`
- `packages/client/src/features/connection/store.ts`

**Verified OpenClaw-specific concepts exposed in UI/API**

- gateway URL
- gateway reachability
- connected device identity
- pairing-related states
- gateway sessions
- context-budget endpoint derived from gateway HTTP
- system graph node labeled `gateway`

**Implication for migration**

- Even if chat keeps working, the system screens will be misleading unless terminology and data sources are updated.
- Some screens can remain if ZeroClaw still has equivalent concepts; others should be renamed or redesigned.

### 4.6 Workspace compatibility coupling

- `.env.example` suggests `SOVEREIGN_GLOBAL_PATH=~/.openclaw/workspace`
- `packages/client/src/lib/markdown.ts` references OpenClaw workspace files
- `packages/server/src/files/routes.ts` uses `OPENCLAW_WORKSPACE`
- `plans/phase-9-spec.md` preserves OpenClaw workspace conventions for compatibility

**Implication for migration**

- There are two different concerns here:
  1. **agent runtime migration**
  2. **workspace/context compatibility**
- Do not break the second while addressing the first unless that is an explicit project goal.
- It may be correct to migrate the runtime to ZeroClaw while temporarily continuing to read the legacy workspace path.

---

## 5. Architecture differences: OpenClaw vs ZeroClaw target state

This section translates the repo's current architecture into the target migration shape.

| Area | Current OpenClaw state | ZeroClaw target state |
| --- | --- | --- |
| Backend provider | `createOpenClawBackend(...)` in server wiring | `createZeroClawBackend(...)` or provider-selected backend |
| Transport | OpenClaw gateway WebSocket | ZeroClaw-native transport or embedded runtime API |
| Auth | gateway token + device identity handshake | ZeroClaw-native auth or local trust model |
| Session storage | `~/.openclaw/agents/main/sessions/*` | Sovereign-owned or ZeroClaw-owned session store |
| Models source | `~/.openclaw/openclaw.json` | ZeroClaw config/API or Sovereign config |
| Observability naming | “gateway”, pairing, gateway sessions | neutral “agent backend” / “runtime” naming |
| Context budget | fetched from OpenClaw HTTP endpoint | fetched from ZeroClaw or generated by Sovereign |
| Workspace files | optional OpenClaw compatibility path | keep only if still needed for workspace continuity |

### Recommended migration principle

Keep the **client contract stable** and move the change boundary to the server/backend layer first.

That means:

- Preserve `AgentBackend` events and semantics where possible.
- Replace the OpenClaw protocol adapter, not the whole UI stack in one step.
- Remove direct filesystem reads of OpenClaw internals before or alongside runtime cutover.

---

## 6. Config and environment variable changes

### 6.1 Verified current env surface

Documented or used in code today:

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_WORKSPACE`
- `SOVEREIGN_GLOBAL_PATH` (often pointed at OpenClaw workspace)

### 6.2 Recommended target env surface

Assuming ZeroClaw becomes the default backend, move to neutral or ZeroClaw-specific variables.

#### Preferred end state

```bash
SOVEREIGN_AGENT_BACKEND=zeroclaw
ZEROCLAW_URL=...
ZEROCLAW_TOKEN=...
ZEROCLAW_WORKSPACE=...      # only if ZeroClaw owns a separate workspace root
SOVEREIGN_GLOBAL_PATH=...   # optional; keep if Sovereign still points at shared workspace files
```

#### Backwards-compatible transition state

During rollout, support both old and new names with explicit precedence:

1. `ZEROCLAW_*` or neutral `SOVEREIGN_AGENT_BACKEND_*` vars
2. old `OPENCLAW_*` vars only when provider is `openclaw`

### 6.3 Repo-specific config migration checklist

Update the following places when code migration begins:

- `README.md`
- `.env.example`
- `packages/server/src/index.ts`
- `packages/server/src/system/routes.ts`
- any config schema / runtime config module that introduces backend-provider selection
- tests that currently hard-code OpenClaw env names

### 6.4 Config compatibility recommendation

For one release window, support this pattern:

- `SOVEREIGN_AGENT_BACKEND=openclaw|zeroclaw`
- load backend-specific settings from the selected provider only
- emit a startup warning when `OPENCLAW_*` vars are present but provider is `zeroclaw`

That gives an operator a safe rollback path without rewriting every deployment artifact twice.

---

## 7. Operational migration plan

This section is the actual cutover sequence. The order matters.

### Stage 1 — Prepare the codebase before runtime cutover

Do **not** point production Sovereign at ZeroClaw until these repo-level dependencies are addressed:

1. **Add a ZeroClaw backend implementation** behind `AgentBackend`.
2. **Introduce backend selection in server wiring** instead of hard-coding `createOpenClawBackend(...)`.
3. **Replace direct `~/.openclaw/...` session reads** with a provider-neutral session store/index.
4. **Replace model discovery from `openclaw.json`** with provider-neutral or ZeroClaw-native configuration.
5. **Audit system UI labels** (`gateway`, pairing, device states, gateway sessions).
6. **Update docs/env examples** so new deploys no longer default to OpenClaw.

#### Acceptance gate for Stage 1

- Sovereign server starts with `SOVEREIGN_AGENT_BACKEND=zeroclaw`
- chat send/stream/turn flows work without any `~/.openclaw` files present
- thread views no longer require `sessions.json`
- `/api/models` works without `~/.openclaw/openclaw.json`

### Stage 2 — Data and state migration

Because this repo still reads OpenClaw session files directly, treat historical data migration as an explicit exercise.

#### Recommended approach

- Export or map existing OpenClaw sessions into the new Sovereign/ZeroClaw session store.
- Preserve thread keys where possible so existing UI thread associations continue to work.
- Preserve at least:
  - session key
  - label
  - message history
  - timestamps / last activity
  - model metadata if still meaningful
  - subagent/child relationship metadata where supported

#### Minimal safe outcome

If full history migration is not possible for first cutover:

- preserve active thread identity and future chat continuity
- archive old OpenClaw session data read-only
- clearly mark pre-migration history as legacy if the UI cannot merge it

### Stage 3 — Staging deployment

In a staging environment:

1. Configure Sovereign to use ZeroClaw.
2. Leave OpenClaw data present but unused.
3. Run end-to-end verification (see §8).
4. Compare thread/history/model/system screens against a known OpenClaw baseline.
5. Confirm there are no hidden reads from `~/.openclaw` in logs or traces.

### Stage 4 — Production cutover

Recommended sequence:

1. Announce maintenance window.
2. Stop autonomous jobs or agent-triggered workflows temporarily.
3. Back up:
   - Sovereign data dir
   - OpenClaw config dir `~/.openclaw/`
   - any existing session/history artifacts
4. Deploy build with ZeroClaw support.
5. Set provider/env to ZeroClaw.
6. Start Sovereign.
7. Run smoke verification immediately.
8. Keep OpenClaw available but inactive until rollback window closes.

### Stage 5 — Post-cutover cleanup

Only after a stable observation window:

- remove OpenClaw-specific env vars from deployment manifests
- stop writing or depending on `.openclaw` runtime paths
- deprecate OpenClaw-specific docs and operator runbooks
- retain archived OpenClaw data until retention policy allows deletion

---

## 8. Verification checklist

Use this after staging and production cutover.

### 8.1 Backend connectivity

- [ ] Sovereign starts successfully with ZeroClaw selected.
- [ ] `/api/system/health` reports connected backend status.
- [ ] `/api/system/watchdog` reports backend/runtime healthy.
- [ ] No startup errors reference `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, or missing `~/.openclaw` files.

### 8.2 Core chat behaviour

- [ ] Send a message in an existing thread.
- [ ] Streaming tokens appear live.
- [ ] Final turn is persisted and rendered correctly.
- [ ] Tool calls / work items still appear correctly.
- [ ] Abort works during an in-progress generation.

### 8.3 Thread/session behaviour

- [ ] Thread list loads without parsing `sessions.json`.
- [ ] Active subagents/child sessions still display correctly, or are intentionally hidden pending redesign.
- [ ] Session switching works.
- [ ] History loads for both new and migrated threads.

### 8.4 Models/config

- [ ] `/api/models` returns the expected provider/model list.
- [ ] Default model matches the ZeroClaw configuration source.
- [ ] Changing thread model works, or is explicitly disabled with a clear UI message if not yet supported.

### 8.5 System/observability UI

- [ ] Devices/system screens no longer show misleading OpenClaw-only terminology.
- [ ] Context budget endpoint works or clearly reports unsupported status.
- [ ] Flow graph labels match the new backend architecture.
- [ ] No user-facing screen still says OpenClaw unless it refers to legacy compatibility/history.

### 8.6 Workspace/context behaviour

- [ ] Global workspace path still resolves correctly.
- [ ] File chips / workspace file reads still work.
- [ ] If legacy OpenClaw workspace conventions are retained, they continue to load without runtime coupling.

---

## 9. Rollback plan

Rollback must be designed before the first production cutover.

### Preconditions for safe rollback

- Keep the OpenClaw-capable build artifact or previous commit available.
- Do not delete `~/.openclaw/` data during the cutover window.
- Preserve the previous env/config values.
- Avoid irreversible in-place rewrites of session history unless backed up.

### Rollback procedure

1. Stop the ZeroClaw-backed Sovereign deployment.
2. Restore the prior Sovereign build/config.
3. Restore env vars:
   - `OPENCLAW_GATEWAY_URL`
   - `OPENCLAW_GATEWAY_TOKEN`
   - any workspace paths previously used
4. Restart Sovereign against OpenClaw.
5. Run smoke tests:
   - main thread loads
   - history loads
   - send message works
   - watchdog returns healthy
6. Leave ZeroClaw data intact for later forensic comparison, but do not continue writing to it if rollback is complete.

### Rollback warning

If ZeroClaw introduces a new session store and users chat after cutover, rollback may split history between systems unless dual-write or export/import tooling exists. Plan for that explicitly.

---

## 10. Caveats and open questions

These are the biggest migration unknowns visible from the repo.

### 10.1 ZeroClaw protocol shape is not yet documented here

OpenClaw wire behaviour is heavily tested in this repo; ZeroClaw behaviour is not. A real migration should add:

- backend protocol spec
- event mapping spec to `AgentBackend`
- failure/reconnect/auth semantics
- test matrix equivalent to `openclaw.test.ts` + integration coverage

### 10.2 Session/history migration is the riskiest part

The current repo still depends directly on OpenClaw session files. That is the main operational risk.

If this is not removed first, the migration will be partial and brittle.

### 10.3 Device/pairing UX may become obsolete

If ZeroClaw is embedded or trusted-local, the current device identity + pairing mental model may be unnecessary. In that case the system UI should be simplified rather than mechanically renamed.

### 10.4 `OPENCLAW_WORKSPACE` and `SOVEREIGN_GLOBAL_PATH` are separate concerns

The runtime migration does **not necessarily** require changing the workspace path. The repo intentionally preserves OpenClaw workspace conventions for compatibility. Do not remove that compatibility unless the workspace migration is separately planned.

### 10.5 Some existing docs still intentionally describe the current OpenClaw state

Files like `plans/phase-6-spec.md` and `plans/PHASES.md` are historically accurate for the current implementation. They should not be silently rewritten as if ZeroClaw were already complete. Prefer adding migration/cutover docs and then updating roadmap/status docs when implementation actually lands.

---

## 11. Recommended implementation order inside this repo

When the actual code migration begins, this is the lowest-risk order:

1. Add provider selection to server boot.
2. Introduce `createZeroClawBackend(...)` with parity tests against `AgentBackend` behaviour.
3. Remove direct `sessions.json` dependence by introducing a Sovereign-owned session index.
4. Replace model/config reads from `openclaw.json`.
5. Switch system endpoints from gateway-specific naming/data sources to backend-neutral naming.
6. Update UI copy from `gateway` to `agent backend` or `runtime` where appropriate.
7. Update `.env.example`, `README.md`, and operator docs.
8. Cut staging.
9. Migrate/verify history.
10. Cut production.

---

## 12. Definition of done for the migration

The OpenClaw → ZeroClaw migration should be considered complete in Sovereign only when all of the following are true:

- Sovereign runs with ZeroClaw as the active backend in normal operation.
- No production path depends on `~/.openclaw/agents/main/sessions/`.
- No production path depends on `~/.openclaw/openclaw.json`.
- The server does not require `OPENCLAW_GATEWAY_*` vars when using ZeroClaw.
- User-facing system screens no longer describe the backend as a gateway unless that remains architecturally true.
- Historical data handling is documented: migrated, archived, or intentionally unsupported with a clear operator runbook.
- README and env docs describe ZeroClaw as the default runtime.

---

## 13. Quick operator checklist

For convenience, here is the condensed version.

### Before cutover

- [ ] ZeroClaw backend implementation exists
- [ ] backend provider selection exists
- [ ] no required reads from `.openclaw/sessions.json`
- [ ] no required reads from `.openclaw/openclaw.json`
- [ ] docs/env updated
- [ ] backups taken

### During cutover

- [ ] deploy ZeroClaw-capable build
- [ ] set provider/env to ZeroClaw
- [ ] start Sovereign
- [ ] run smoke tests
- [ ] monitor logs and watchdog

### After cutover

- [ ] verify chat/history/models/system UI
- [ ] keep OpenClaw rollback path intact for the observation window
- [ ] archive legacy OpenClaw data
- [ ] remove deprecated OpenClaw runtime config only after stability is proven
