# Phase 6 Thorough Review

**Date:** 2026-03-13 | **Scope:** Complete codebase audit against Phase 6 spec (rev 4) + PRINCIPLES.md

---

## A. Critical Issues (Spec Violations)

### A1. Empty Shell Components — 7 components are `return <div />`

`ThreadDrawer`, `ForwardDialog`, `VoiceView`, `RecordingView`, `DashboardView`, `Header` are empty stubs returning `<div />`. These are not "implementations" — they're placeholders. The spec has detailed MUST requirements for each (e.g., §5 ThreadDrawer: "MUST render a slide-out drawer with thread list, search, entity chips, unread badges"; §7 DashboardView: "MUST render system status, module health, active terminals, recent events"). This is the single biggest gap.

**Impact:** The client is incomplete — no thread navigation, no forwarding UI, no voice recording view, no dashboard. These are core interaction surfaces.

### A2. ChatView doesn't actually render messages

`ChatView.tsx` has a comment `{/* Messages rendered here via MessageBubble + WorkSection */}` but no actual rendering loop. It doesn't call `MessageBubble` or `WorkSection`. It doesn't iterate over `props.messages`. The component structurally exists but doesn't do its primary job.

### A3. InputArea doesn't work

`InputArea.tsx` renders a textarea and buttons but:

- The send button never calls `props.onSend`
- There's no `onInput`/`onChange` to track textarea value
- There's no Enter-key handling
- No auto-resize logic (despite exporting `INPUT_MIN_HEIGHT`/`INPUT_MAX_HEIGHT` constants)
- No input history (despite exporting `getHistoryKey` / `HISTORY_LIMIT`)
- No scratchpad persistence (despite exporting `getScratchpadKey`)
- File attach button does nothing
- Voice button does nothing

### A4. MessageBubble renders raw text, not markdown

`MessageBubble` renders `<div>{turn.content}</div>` — plain text. The spec requires markdown rendering via `MarkdownContent`. The component imports nothing from markdown.ts. Code blocks, links, lists, etc. will all render as raw text.

### A5. Missing Orbitron font file

`packages/client/src/fonts/orbitron.woff2` doesn't exist. The `app.css` references it in `@font-face`. Ironman and Jarvis themes will fall back to system fonts silently.

### A6. `server/index.ts` doesn't wire up Phase 6 modules

The main server entry point still only wires Phase 1 modules (status aggregator + health route). None of the Phase 6 modules (chat, threads, voice, agent-backend) are imported, initialized, or mounted. The Express routes and WS handlers for chat, threads, and voice are dead code.

---

## B. Architectural Concerns

### B1. `core/index.ts` still exports template scaffolding

`SHARED_CONSTANT = 'template'` and `add(a, b)` are still exported from core. This is day-1 template code that should have been cleaned up when real code was added.

### B2. Client stores use module-level singletons

`chat/store.ts`, `threads/store.ts`, `voice/store.ts`, `connection/store.ts` all create signals at module scope: `const [turns, setTurns] = createSignal(...)`. This means:

- **Tests bleed state** between test cases (mitigated by `_resetState` but easy to forget)
- **Multiple instances impossible** — can't have two chat panels or two thread contexts
- **SSR-hostile** — module-level signals are shared across requests

This contradicts Principle 2 (Functional & Data-Driven) and Principle 4 (Dynamic Runtime Config). A factory pattern `createChatStore(ws)` returning the store object would be more aligned.

### B3. Chat module defines its own `ThreadManager` interface instead of importing

`chat/chat.ts` defines a local `ThreadManager` interface with `getSessionKey` and `createThread` — methods that don't match the actual `ThreadManager` from `threads/threads.ts`. This is a decoupling violation hiding an API mismatch. The actual thread manager has `get()` + `create()`, not `getSessionKey()`.

### B4. Event router wildcard patterns are brittle

`router.ts` subscribes to `'git.status.*'`, `'issue.*'`, `'review.*'`, `'webhook.*'`. But the event bus uses `string.startsWith(pattern)` matching after stripping `*`. If a new event like `issue_tracker.synced` appears, it would accidentally match `issue.*`. The patterns should be more specific or the bus should use proper glob matching.

### B5. Voice module uses `fetch()` directly instead of a configurable HTTP client

Both `transcribe()` and `synthesize()` in `voice.ts` use raw `fetch()`. No timeout, no retry, no request ID tracking, no abort signal support. A 30-second TTS request with no timeout will hang the server.

---

## C. Principle Violations

### C1. Principle 1 (Modular & Composable) — `voice/store.ts` is a grab-bag

`voice/store.ts` is 180+ lines mixing store state, MediaRecorder lifecycle, audio playback, AudioContext unlock, and recording. These are 3-4 distinct concerns crammed into one file. The `audio.ts` file exists but re-implements recording (`createRecorder`) that duplicates `store.ts`'s `startRecording/stopRecording`. The `createRecorder.start()` literally throws: `throw new Error('start() requires browser MediaRecorder')`.

### C2. Principle 6 (File-Driven) — Thread events not persisted to JSONL

Thread events are stored in-memory in a `Map<string, ThreadEvent[]>` and serialized inside the main `registry.json`. For any real usage, this will get large and slow. The spec (§5) says thread events SHOULD use append-only JSONL per thread for event history. Currently it's all in one big JSON blob.

### C3. Principle 7 (Total Transparency) — No error handling visibility

The agent backend `connectWs()` rejects on error, but `scheduleReconnect()` catches and ignores all errors with `catch {}`. There's no bus event emitted for reconnect failures. The client sees "disconnected" but has no way to know _why_ (auth rejected, server down, cert error, etc.). The spec requires `backend.status` events with error detail.

### C4. Principle 9 (Reliability Through Code) — `createSession` has a raw 10s timeout

`createSession()` in the OpenClaw backend uses `setTimeout(() => reject('timeout'), 10000)` but never clears this timer on success. If the session is created successfully at 9s, both the resolve AND the reject will fire. Classic timer leak.

---

## D. Code Quality Nitpicks

### D1. Package names still `@template/*`

Should have been renamed to `@sovereign/*` (or whatever the final name is) before Phase 2. Every file imports from `@template/core`. This will be a painful mass-rename later.

### D2. `thinking.ts` uses `ed.etc.sha512Sync` — but it's unused

The original openclaw.ts set up `ed.etc.sha512Sync` for `@noble/ed25519`, but after the rewrite to Node native crypto, any remaining `@noble/ed25519` references are dead. Check if `@noble/ed25519` is still in `package.json` — if so, remove it.

### D3. Dead legacy export in `voice/routes.ts`

The file exports both `createVoiceRoutes(voice)` (the real factory) AND a standalone `router` with hardcoded 501 responses. The legacy export is unused noise.

### D4. `MarkdownContent.tsx` is a passthrough

```tsx
export function MarkdownContent(props: MarkdownContentProps) {
  return <div innerHTML={props.html} style={{ color: 'var(--c-text)' }} />
}
```

18 lines. No sanitization, no syntax highlighting integration, no code block copy buttons, no link handling. Just raw `innerHTML`. This is an XSS vector and doesn't match the spec (§4 MarkdownContent: "MUST sanitize HTML", "MUST apply syntax highlighting", "MUST support copy button on code blocks").

### D5. `WorkSection.tsx` doesn't render work items properly

The component receives props but renders a simplified skeleton — no collapsible tool call sections, no input/output display, no spinner for in-progress items, no timing information. Just structural placeholder.

### D6. No `app.css` import in any entry point

I don't see `app.css` being imported by `App.tsx` or any entry point. The theme tokens, fonts, and keyframes defined there may not actually load.

### D7. `threads/types.ts` duplicates `ForwardedMessage` from `@template/core`

`packages/core/src/agent-backend.ts` exports `ForwardedMessage`. `threads/types.ts` likely also defines it. One source of truth.

---

## E. Test Quality

### E1. Component tests verify exports, not behavior

Tests like `ChatView.test.ts` verify `typeof ChatView === 'function'` and prop shape — they don't test any rendering behavior because tests run in `node` without `vite-plugin-solid`. This means the UI components are **zero-coverage** for actual rendering bugs. We have 175 "passing" client tests but zero confidence that the components render correctly.

### E2. Integration tests may be testing mocks, not real behavior

Worth auditing `phase6.test.ts` to ensure integration tests are using real module instances wired together, not just mocking everything. Integration tests that mock their dependencies are just unit tests with extra steps.

---

## F. Summary: What's Actually Done vs Spec

| Area                            | Spec Status | Implementation Status                          |
| ------------------------------- | ----------- | ---------------------------------------------- |
| Theme tokens (app.css)          | ✅ Complete | ✅ All 4 themes, tokens, keyframes             |
| UI design system (7 components) | ✅ Complete | ✅ All 7 implemented correctly                 |
| Theme store                     | ✅ Complete | ✅ Persist, restore, apply                     |
| Agent backend interface         | ✅ Complete | ✅ Well-designed abstraction                   |
| OpenClaw backend                | ✅ Complete | ⚠️ Works but timer leaks, error detail missing |
| Thinking block stripping        | ✅ Complete | ✅ Thorough                                    |
| Chat module (server)            | ✅ Complete | ⚠️ API mismatch with thread manager            |
| Thread manager                  | ✅ Complete | ⚠️ Events in JSON blob, not JSONL              |
| Event router                    | ✅ Complete | ✅ Functional                                  |
| Forward handler                 | ✅ Complete | ✅ Functional                                  |
| Voice module (server)           | ✅ Complete | ⚠️ No timeouts, no abort                       |
| Voice routes                    | ✅ Complete | ⚠️ Dead legacy export                          |
| Client stores (5)               | ✅ Complete | ⚠️ Module singletons, not factories            |
| ChatView                        | ✅ Spec'd   | ❌ Doesn't render messages                     |
| MessageBubble                   | ✅ Spec'd   | ❌ No markdown rendering                       |
| MarkdownContent                 | ✅ Spec'd   | ❌ Unsanitized innerHTML, no features          |
| WorkSection                     | ✅ Spec'd   | ❌ Skeleton only                               |
| InputArea                       | ✅ Spec'd   | ❌ Non-functional                              |
| ThreadDrawer                    | ✅ Spec'd   | ❌ Empty stub                                  |
| ForwardDialog                   | ✅ Spec'd   | ❌ Empty stub                                  |
| VoiceView                       | ✅ Spec'd   | ❌ Empty stub                                  |
| RecordingView                   | ✅ Spec'd   | ❌ Empty stub                                  |
| DashboardView                   | ✅ Spec'd   | ❌ Empty stub                                  |
| Header                          | ✅ Spec'd   | ❌ Empty stub                                  |
| SettingsModal                   | ✅ Spec'd   | ❌ Empty shell                                 |
| Server wiring (index.ts)        | Required    | ❌ Not wired                                   |
| Orbitron font file              | Required    | ❌ Missing                                     |
| App.tsx root composition        | Required    | ❌ Not updated                                 |

---

## G. Recommended Fix Waves

**Wave A — Critical (make it actually work):**

1. Implement all 7 empty stub components (ThreadDrawer, ForwardDialog, VoiceView, RecordingView, DashboardView, Header, SettingsModal)
2. Make ChatView render messages via MessageBubble + WorkSection
3. Make InputArea functional (send, enter, resize, history)
4. Wire server index.ts to initialize and mount all Phase 6 modules
5. Add Orbitron font file
6. Fix ChatModule ThreadManager interface mismatch

**Wave B — Quality (make it robust):**

1. Add HTML sanitization to MarkdownContent (DOMPurify or similar)
2. Add markdown rendering pipeline (markdown-it or marked)
3. Fix `createSession` timer leak
4. Add request timeouts + abort signals to voice module
5. Emit detailed error info in backend.status events
6. Move thread events to JSONL per-thread

**Wave C — Housekeeping:**

1. Rename `@template/*` → `@sovereign/*`
2. Remove `SHARED_CONSTANT` and `add()` from core/index.ts
3. Remove `@noble/ed25519` from dependencies
4. Remove dead legacy voice routes export
5. Refactor voice/store.ts into focused modules
6. Refactor client stores from singletons to factories
