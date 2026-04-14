# Spec: Thread Context Inspection & Export

## Objective

Give Sovereign users a thread-level inspection view that shows the conversation/context OpenClaw is using for a session, with export to TXT and JSON, so users can debug behaviour, verify what the model saw, and understand prompt/context assembly. The feature must be explicit about provenance: when Sovereign is showing an exact captured provider-bound payload versus a best-effort reconstruction from OpenClaw-accessible state.

## Why this matters

Today Sovereign exposes:

- parsed chat history (`ParsedTurn[]`) via `packages/server/src/chat/routes.ts` and `packages/server/src/agent-backend/parse-turns.ts`
- thread/session metadata via `packages/server/src/threads/routes.ts`
- base context-budget data via `GET /api/system/context-budget` in `packages/server/src/system/routes.ts`

But the user cannot inspect the full raw message/context state behind a thread, and the existing UI is intentionally lossy:

- `parseTurns()` strips timestamps, directive tags, sender envelopes, internal/system noise, and groups messages into rendered turns
- `ChatView` and `WorkSection` show a cleaned human-readable transcript, not the raw message objects
- `ContextBudgetModal` shows fixed base prompt composition, not per-thread provider payloads

For debugging and transparency, users need a first-class way to inspect what OpenClaw is actually carrying forward for a thread and export it for analysis.

---

## Problem statement grounded in current code

### What Sovereign currently has

1. **Thread ⇄ session mapping**
   - `packages/server/src/chat/chat.ts`
   - `deriveSessionKey()` and persisted `chat/session-map.json`

2. **Rendered/parsed history**
   - `AgentBackend.getHistory()` / `getFullHistory()` in `packages/server/src/agent-backend/openclaw.ts`
   - reads raw session JSONL through `packages/server/src/agent-backend/session-reader.ts`
   - parses raw messages into `ParsedTurn[]` through `packages/server/src/agent-backend/parse-turns.ts`

3. **Session metadata**
   - `GET /api/threads/:key/session-info` in `packages/server/src/threads/routes.ts`
   - currently reads `~/.openclaw/agents/main/sessions/sessions.json` for model, token counts, compaction count, thinking level, etc.

4. **Base prompt composition**
   - `GET /api/system/context-budget` in `packages/server/src/system/routes.ts`
   - proxies the gateway HTTP endpoint `/api/context`
   - used by `packages/client/src/features/system/ContextBudgetModal.tsx`

5. **Live work/stream state**
   - `packages/server/src/chat/chat.ts`
   - caches live status, work items, and streaming text for replay
   - helpful for in-progress turns, but not enough to reconstruct a full provider request payload

### What Sovereign does **not** currently have

Sovereign does **not** have a thread-scoped endpoint or persisted record that says:

- “this exact provider request body was sent for thread X at time Y”
- “this is the exact ordered message array after all OpenClaw compaction and provider adapter transformations”
- “these are the exact tool definitions/system prompt blocks attached to this specific request”

That means the current codebase can support **full-fidelity inspection of OpenClaw-visible raw session history** immediately, but it **cannot guarantee an exact final provider HTTP payload** without new OpenClaw support.

---

## Exactness model: what can be captured exactly vs approximately

This distinction is the most important part of the feature.

### Exact today from Sovereign/OpenClaw-accessible state

Sovereign can capture and display exactly:

- the thread key and resolved session key
- the raw message objects available from OpenClaw session storage / `chat.history`
- the full JSON objects written in session JSONL (`role`, `content` blocks, tool calls, tool results, timestamps, stop reasons, error fields, etc.)
- thread/session metadata from `sessions.json` (model, token counts, compaction count, thinking level, etc.)
- the base context-budget report returned by gateway `/api/context`

### Approximate today

Sovereign can only **approximate**:

- the exact next provider request for a thread
- the exact final prompt/messages after OpenClaw compaction/selection at request time
- the exact provider-specific serialization/body format
- any transforms applied after OpenClaw history exists but before the provider request is made
- any hidden provider SDK defaults, adapter normalization, or server-side injection outside exposed gateway APIs

### Exact with additional OpenClaw support

Sovereign can show the exact provider-bound payload **if OpenClaw exposes one of the following**:

1. a per-thread inspection endpoint that returns the fully assembled request before dispatch, or
2. a capture/log of the last provider request body associated with a sessionKey/requestId, or
3. an event emitted at provider-dispatch time containing the fully assembled provider payload (or a normalized provider-agnostic equivalent).

### Product requirement implied by the above

The UI and exports must label data provenance clearly:

- `Exact captured payload`
- `Exact raw OpenClaw session history`
- `Best-effort reconstructed request`

No screen copy should claim “exactly what the provider received” unless the data source really supports that statement.

---

## User stories

1. **As a user**, from a thread/session I can open a “Context Inspector” modal and inspect the raw context data for that thread.
2. **As a user**, I can see whether the data is exact or reconstructed.
3. **As a user**, I can inspect both a readable text view and the raw JSON.
4. **As a user**, I can export the inspected data as TXT or JSON.
5. **As a user**, I can use this for current threads, subagent threads, and threads with long/compacted history.
6. **As a user**, I can understand what is missing when exact provider payload capture is unavailable.

---

## Scope

### In scope

- New thread-scoped inspection feature in Sovereign.
- Server API(s) to fetch raw context-inspection data for a thread.
- Client modal/view to present that data.
- TXT and JSON export flows.
- Provenance labelling and safety/privacy affordances.
- Tests and manual verification for both exact-capture and reconstructed modes.
- A forward-compatible design that can consume future OpenClaw exact payload capture without redesigning the UI.

### Out of scope

- Implementing the exact-capture support inside OpenClaw itself in this repo.
- Changing OpenClaw compaction behaviour.
- Changing provider payload construction behaviour.
- Redesigning the existing chat transcript UI.
- Solving the broader `sessions.json` dependency removal in this feature.
- Hiding/redacting secrets automatically beyond obvious UI warnings and optional future redaction hooks.

---

## Proposed feature shape

## 1. New concept: `ThreadContextInspection`

Introduce a server response model that supports both exact and reconstructed sources.

```ts
interface ThreadContextInspection {
  threadKey: string
  sessionKey: string | null
  generatedAt: number
  source:
    | 'captured-provider-payload'
    | 'raw-openclaw-session'
    | 'reconstructed-from-session-and-context-budget'
    | 'unavailable'
  exactness: 'exact' | 'best-effort' | 'unavailable'
  capture?: {
    provider?: string | null
    model?: string | null
    capturedAt?: number | null
    requestId?: string | null
    payloadFormat?: 'openai-responses' | 'anthropic-messages' | 'generic' | 'unknown'
    payload?: unknown
  }
  reconstruction?: {
    sessionMeta: {
      model: string | null
      modelProvider: string | null
      contextTokens: number | null
      totalTokens: number
      inputTokens: number
      outputTokens: number
      compactionCount: number
      thinkingLevel: string | null
      agentStatus: string | null
    }
    baseContextBudget?: Record<string, unknown> | null
    rawMessages: unknown[]
    notes: string[]
  }
}
```

Design intent:

- one stable API shape
- consumers do not care whether the server obtained exact capture or reconstruction
- exports can embed provenance cleanly

---

## 2. Server/API changes

### 2.1 Add a new endpoint

Add:

- `GET /api/threads/:key/context-inspection`

Suggested query params:

- `format=full|summary` (default `full`)
- `includeBaseContext=true|false` (default `true`)
- `includeRawMessages=true|false` (default `true`)

### 2.2 Data acquisition order

The server should resolve data in this order:

1. **Resolve thread → session**
   - use `chatModule.getSessionKeyForThread(threadKey)`
   - fallback to `deriveSessionKey(threadKey)`

2. **Attempt exact payload capture**
   - call a small backend capability if it exists, e.g. `backend.getContextInspection?.(sessionKey)` or a generic gateway request such as `request('chat.context.inspect', { sessionKey })`
   - if available and returns a payload, respond with `source: 'captured-provider-payload'`, `exactness: 'exact'`

3. **Fallback to reconstruction**
   - read raw session messages directly from JSONL or via a new raw-history helper (see below)
   - read session metadata using current `session-info` logic / shared helper
   - optionally fetch base context-budget from gateway `/api/context`
   - return `source: 'raw-openclaw-session'` or `source: 'reconstructed-from-session-and-context-budget'`, `exactness: 'best-effort'`

### 2.3 New server helper: raw history access without `parseTurns()`

Current history helpers return parsed turns, which are intentionally lossy. This feature needs a raw path.

Add a helper in `packages/server/src/agent-backend/session-reader.ts` or a sibling module:

- `getRawSessionMessages(sessionKey: string, opts?: { includeOlderSessions?: boolean }): Promise<any[]>`

Implementation approach:

- use current `getSessionFilePath()` and `getAllSessionFiles()`
- read JSONL lines where `entry.type === 'message'`
- return raw `entry.message` objects in chronological order
- do **not** strip, normalize, or parse content blocks

This helper should be shared by the new inspection endpoint and future debugging tools.

### 2.4 Refactor current session-info read path into reusable helper

`packages/server/src/threads/routes.ts` currently reads `sessions.json` inline in `GET /api/threads/:key/session-info`.

Refactor that into a shared helper, e.g.:

- `packages/server/src/threads/session-meta.ts`

Purpose:

- avoid duplicating session metadata reads in the new inspection endpoint
- keep model/token/compaction metadata consistent between existing thread settings and the new inspector

### 2.5 Optional gateway capability detection

Because exact capture is not available in current Sovereign/OpenClaw integration, the endpoint should treat capture support as optional.

Recommended shape:

- add an optional method to the backend implementation surface, not the base `AgentBackend` contract yet, e.g.

```ts
interface ContextInspectionCapableBackend {
  getContextInspection?(sessionKey: string): Promise<...>
}
```

or request the gateway dynamically if supported.

Why optional:

- current `createOpenClawBackend()` can ship without breaking the existing interface
- future OpenClaw additions can plug in cleanly

### 2.6 Export endpoint vs client-side export

Prefer **client-side export** for v1 once the inspection JSON is loaded.

Reasons:

- existing export helpers in `packages/client/src/features/chat/export.ts` and `packages/client/src/lib/export.ts` already download blobs client-side
- avoids additional server endpoints for TXT/JSON export
- guarantees export matches what the user is viewing

No dedicated export API is required unless later we want streaming export for extremely large payloads.

---

## 3. UI changes

### 3.1 Entry point

Best placement: extend the existing thread settings entry point rather than creating a system-wide-only screen.

Recommended additions:

- add a `Inspect Context` action inside `packages/client/src/features/chat/ChatSettings.tsx`
- optionally mirror it in `ThreadSettingsModal.tsx` if that modal remains in use

Rationale:

- the feature is thread-specific
- users already look there for model/context/session details
- it reduces navigation friction

### 3.2 New modal component

Add something like:

- `packages/client/src/features/chat/ContextInspectionModal.tsx`

Re-use patterns from:

- `packages/client/src/features/system/ContextBudgetModal.tsx`
- `packages/client/src/ui/Modal.tsx`

### 3.3 Modal layout

Recommended structure:

**Header**

- title: `Thread Context Inspector`
- thread label / thread key
- session key
- provenance badge: `Exact payload` / `Best-effort reconstruction`
- export buttons: `Export TXT`, `Export JSON`
- refresh button

**Summary panel**

- model/provider
- compaction count
- token stats from session metadata
- number of raw messages
- whether base context was included
- explanation note of exactness limits

**View tabs**

1. `Readable`
   - human-readable but still lossless-oriented representation
   - show raw messages in order with role and block structure
   - keep content blocks visible (`text`, `toolCall`, `toolResult`, `thinking`, etc.)
   - do not silently collapse or strip fields

2. `JSON`
   - pretty-printed full JSON response from `/api/threads/:key/context-inspection`
   - copy/select friendly

3. `Base Context` (only when available)
   - show context-budget-derived fixed prompt data similar to `ContextBudgetModal`
   - make clear that this is fixed/base context, not necessarily the exact final request body for this thread

### 3.4 Formatting choices

Readable view should preserve fidelity while still being scannable.

For each raw message:

- show index number
- role
- timestamp if present
- stop reason / error fields if present
- each content block rendered explicitly:
  - `text`
  - `thinking`
  - `toolCall` / `tool_use`
  - `toolResult` / `tool_result`
  - unknown block types displayed generically as JSON

Avoid:

- reusing `MessageBubble` / `ChatView` directly, because they reflect rendered conversation UX, not inspection UX
- reusing `parseTurns()`, because it hides exactly the details the user is asking to inspect

### 3.5 Export behaviour

**JSON export**

- export the full `ThreadContextInspection` object as returned by the API
- filename example: `thread-context-${threadKey}-${Date.now()}.json`

**TXT export**

- export a readable text rendering including:
  - title / generated time
  - provenance and exactness
  - threadKey / sessionKey
  - session metadata summary
  - notes / caveats
  - full raw messages rendered in a deterministic readable format

TXT export should remain lossless enough for debugging, but JSON is the canonical artifact.

### 3.6 Safety/privacy UX

Because this view may expose:

- system prompt fragments
- injected workspace file content
- tool inputs/results
- untrusted sender metadata
- potentially sensitive user content

The modal should show a subtle warning such as:

- `May contain sensitive prompt context, workspace content, or tool output. Export/share carefully.`

For v1, no automatic redaction is required, but the UI should not make accidental sharing effortless without context.

---

## 4. Data/state management

Add a small client store or local component state for the modal. A dedicated global store is optional; local state is likely sufficient.

Suggested file:

- `packages/client/src/features/chat/context-inspection.ts`

Suggested shape:

```ts
interface ContextInspectionState {
  loading: boolean
  error: string | null
  data: ThreadContextInspection | null
  activeTab: 'readable' | 'json' | 'base-context'
}
```

Behaviour:

- fetch on modal open
- refresh on demand
- retain last successful payload while refresh is in-flight
- no background polling required
- if thread changes while open, either refetch automatically or close the modal; refetch is preferable

---

## 5. Performance and size considerations

This feature can become large quickly.

### Known pressure points in current architecture

- `getFullHistory()` in `packages/server/src/agent-backend/openclaw.ts` can read large current + older session files
- session JSONL files may be large for long-lived threads
- pretty-printed JSON can be expensive in the browser
- base context report may include file contents

### v1 performance plan

1. **Use on-demand loading only**
   - no preload in thread list/chat screen

2. **Default to full data, but only when the modal is explicitly opened**
   - acceptable because this is a debugging feature, not a hot path

3. **Bound UI rendering cost**
   - use a scrollable container with lazy section expansion if needed
   - JSON view can render in a `<pre>`; if performance degrades, switch to virtualized chunked rendering later

4. **Keep export client-side**
   - only after the response is already loaded

5. **Optional future enhancement**
   - support truncation toggles or streamable export for very large threads
   - not required in v1 unless exploratory testing shows unacceptable stalls

### Recommended response metadata

Include rough counts in the payload:

- `rawMessageCount`
- `estimatedChars`
- `hasOlderSessionsIncluded`

This helps the UI explain load size and supports future safeguards.

---

## 6. Security and privacy considerations

### Risks

- exposing internal prompt/context details to any user who can access Sovereign UI
- exposing workspace file contents and tool outputs in export files
- exposing raw sender metadata or internal system messages that normal chat UI intentionally suppresses

### v1 assumptions

Sovereign is already an operator-facing local tool. This feature is intended for that same operator/debugging audience. Therefore the main requirement is transparency and caution, not broad RBAC.

### v1 requirements

- keep the feature behind the same app/session access as other thread views
- add visible warning copy in the modal and export panel
- do not claim redaction or sanitization
- preserve raw values exactly in JSON export

### Future hardening (not in scope for v1)

- role-based permission gating
- configurable redaction hooks
- “copy redacted” export mode
- audit logging for export actions

---

## 7. Test strategy

## 7.1 Server tests

Add tests near `packages/server/src/chat/routes.ts` / `packages/server/src/threads/routes.ts` or a dedicated new test file, e.g.:

- `packages/server/src/chat/context-inspection.test.ts`

### Required cases

1. **Reconstructed path returns raw messages**
   - given a session JSONL with multiple message shapes
   - when `/api/threads/:key/context-inspection` is requested
   - then raw messages are returned in chronological order without `parseTurns()`-style stripping

2. **Includes session metadata**
   - given `sessions.json` metadata exists
   - then response includes model/provider/token/compaction data

3. **Includes base context budget when available**
   - mock gateway `/api/context` response
   - verify response embeds it

4. **Graceful fallback when context-budget fetch fails**
   - response still succeeds with reconstruction and notes describing missing base context

5. **Graceful fallback when raw session file is missing**
   - response returns `source: 'unavailable'` or reconstruction with empty messages and explanatory notes

6. **Exact payload path preferred when backend capability exists**
   - mock backend optional capture method
   - verify route returns `exactness: 'exact'` and capture payload instead of reconstruction-only response

7. **Thread not found**
   - returns `404`

8. **Subagent thread support**
   - verify non-main thread keys resolve through existing mapping rules

## 7.2 Client tests

Add tests near chat feature tests, e.g.:

- `packages/client/src/features/chat/ContextInspectionModal.test.tsx`
- optionally small helper tests for TXT rendering/export helpers

### Required cases

1. opening the modal fetches inspection data
2. provenance badge reflects `exact` vs `best-effort`
3. readable tab renders raw message blocks without collapsing to `ParsedTurn`
4. JSON tab shows pretty-printed full response
5. export JSON downloads the exact payload returned by API
6. export TXT includes provenance and thread/session metadata
7. errors render a recoverable error state with refresh retry

## 7.3 E2E / smoke coverage

Extend a thread/chat e2e spec with a mocked response:

- user opens thread settings
- clicks `Inspect Context`
- sees modal with thread/session metadata
- can switch to JSON view
- can trigger export buttons (download assertion if Playwright setup supports it)

---

## 8. Manual verification plan

1. Run Sovereign against a real OpenClaw session with existing history.
2. Open a normal thread and a subagent thread.
3. From thread settings, open Context Inspector.
4. Verify the modal shows:
   - correct thread key
   - correct session key
   - raw message count > 0
   - provenance badge says `Best-effort reconstruction` on current OpenClaw
5. Compare the JSON output against the underlying session JSONL file to confirm fidelity.
6. Verify fields that are normally stripped from chat rendering remain visible in inspection JSON.
7. Export JSON and TXT; open both files and verify filenames/content.
8. If OpenClaw exact capture support is available in the test environment, verify the badge switches to `Exact payload` and the JSON includes the captured payload.
9. Verify large-history threads remain usable and the modal scrolls correctly.
10. Confirm warning copy is visible and no console errors occur.

---

## 9. Open questions / risks

### Open questions

1. **Does current OpenClaw expose any hidden/provider payload inspection API already?**
   - Sovereign currently does not use one.
   - If such an endpoint exists, use it instead of inventing reconstruction-first behaviour.

2. **Should “current context” mean last captured request or hypothetical next request?**
   - These are not always the same.
   - Recommendation: v1 should display the latest inspectable thread context with clear wording:
     - `Last captured provider payload` when exact capture exists
     - otherwise `Current raw session context available to Sovereign`

3. **Should base context file contents be embedded in the thread-scoped response?**
   - Good for completeness, but can enlarge payloads.
   - Recommendation: include only when requested via `includeBaseContext=true`.

4. **How should attachments be represented?**
   - current client send path base64-encodes attachments for `/api/chat/send`
   - inspection should display raw message content as stored by OpenClaw; do not attempt custom decoding unless necessary

### Risks

1. **User expectation mismatch**
   - biggest risk is claiming exact provider visibility when only reconstruction exists
   - mitigation: provenance-first design and explicit labels in UI/export

2. **Large payload rendering**
   - very large session histories may be slow in browser
   - mitigation: on-demand fetch, scrollable panes, possible future virtualization

3. **Dependence on OpenClaw internals**
   - raw session access currently depends on `~/.openclaw/.../sessions.json` and JSONL layout
   - mitigation: keep raw-history access behind helper abstractions, matching broader phase-9 goal of reducing direct coupling later

4. **Future migration to ZeroClaw / reduced `sessions.json` usage**
   - this feature should not entrench the dependency further than necessary
   - mitigation: isolate raw access and session-meta reads behind small server helpers

---

## 10. Recommended implementation sequence

### Phase A — Sovereign-only, best-effort inspector

1. Add reusable server helpers:
   - raw session message reader
   - shared session metadata reader
2. Add `GET /api/threads/:key/context-inspection`
   - reconstruction-only initially
   - include exactness/provenance fields from day one
3. Add client modal + fetch + tabs
4. Add TXT/JSON export helpers
5. Add tests
6. Manual verification against real OpenClaw session data

### Phase B — Exact payload integration when OpenClaw supports it

1. Add optional backend capability for `getContextInspection()` / `chat.context.inspect`
2. Wire server endpoint to prefer exact payloads
3. Update UI copy/badges to show exact capture timestamps and payload format
4. Add tests for exact mode

### Phase C — Nice-to-haves

1. copy-to-clipboard actions
2. filter/search within JSON/readable views
3. optional redacted export
4. compare `rendered chat` vs `raw context` side-by-side

---

## 11. File-level implementation design

### Server

**New / changed files**

- `packages/server/src/agent-backend/session-reader.ts`
  - add raw message reader helpers that return exact stored message objects

- `packages/server/src/threads/session-meta.ts` _(new)_
  - extract shared `sessions.json` metadata read logic from `threads/routes.ts`

- `packages/server/src/chat/routes.ts` **or** `packages/server/src/threads/routes.ts`
  - add `GET /api/threads/:key/context-inspection`
  - I recommend `threads/routes.ts` because the feature is thread-scoped and sits conceptually closer to `session-info`

- `packages/server/src/agent-backend/openclaw.ts`
  - optionally add a future-compatible hook for exact capture requests if/when OpenClaw provides them
  - no mandatory change required for phase A

### Client

- `packages/client/src/features/chat/ChatSettings.tsx`
  - add `Inspect Context` action

- `packages/client/src/features/chat/ContextInspectionModal.tsx` _(new)_
  - modal UI, tabs, provenance badges, export buttons

- `packages/client/src/features/chat/context-inspection.ts` _(new, optional)_
  - fetch helpers / rendering helpers / state helpers

- `packages/client/src/features/chat/export.ts`
  - add helpers for context-inspection TXT/JSON export

- `packages/client/src/features/chat/ContextInspectionModal.test.tsx` _(new)_
  - component tests

### Why `threads/routes.ts` is the best server home

Existing nearby responsibilities already include:

- thread-level session-info
- thread-level model updates
- thread-scoped OpenClaw session metadata

That makes it a better fit than `system/routes.ts` or `chat/routes.ts`.

---

## 12. Acceptance criteria

1. **Given** a thread with a resolvable session, **when** the user opens Context Inspector, **then** Sovereign shows a thread-scoped inspection payload containing thread/session metadata and raw context data.
2. **Given** current OpenClaw integration without exact payload capture, **when** the inspector opens, **then** the UI labels the result as best-effort reconstruction rather than exact provider payload.
3. **Given** a future backend that supports exact request capture, **when** the inspector opens, **then** the UI labels the payload as exact and exports the captured payload unchanged in JSON.
4. **Given** the user exports JSON, **when** they open the file, **then** it contains the full inspection object including provenance/exactness metadata.
5. **Given** the user exports TXT, **when** they open the file, **then** it contains a readable representation of the same inspected data and a clear caveat when the payload is reconstructed.
6. **Given** the underlying session/context-budget source is partially unavailable, **when** the inspector opens, **then** it fails gracefully with partial data and explicit notes rather than crashing.

---

## 13. Recommendation summary

Build this as a **provenance-aware thread inspector** rather than a UI that overclaims exactness.

- **What Sovereign can ship now:** exact raw OpenClaw session history inspection + session metadata + optional base context budget, clearly marked as best-effort for provider payload equivalence.
- **What requires OpenClaw enhancement:** exact final provider-bound request/payload inspection.
- **Best implementation strategy:** define the UI/API contract now so exact capture can drop in later without redesign.

This gives users immediate debugging value while preserving truthfulness about what Sovereign can and cannot know from the current codebase.
