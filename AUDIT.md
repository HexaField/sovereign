# Sovereign Audit — Phase 1–8 Completeness Review

**Date:** 2026-03-22
**Codebase:** 196 commits, ~41k LOC, 2375 passing tests

---

## Phase 1: Foundation ✅ (Mostly Complete)

### Working
- [x] Event bus — full pub/sub, pattern matching, typed events
- [x] Scheduler — cron expressions via `croner`, atomic file store, `tick()` for tests, `deleteAfterRun`
- [x] Webhook receiver — classify, store, route to bus
- [x] Auth — device identity, Ed25519 signing, middleware
- [x] Notifications — rules engine, priority levels, WS delivery, store
- [x] Status aggregator — debounced, subscribes to patterns

### Issues
- [ ] **P1-1: Push notifications are a stub** — `sendPush()` just pushes to an array in memory, no web-push library
- [ ] **P1-2: Scheduler has no REST API** — only WS channel, `/api/jobs` returns 404. System UI's JobsTab probably can't function
- [ ] **P1-3: Disk usage is hardcoded to 0** — health history reports `disk: 0` with comment "placeholder — real disk check is expensive"

---

## Phase 2: Orgs, Projects & Code ✅ (Mostly Complete)

### Working
- [x] Org manager — CRUD, auto-detect projects from git remotes
- [x] File service — read, write, mkdir, delete, list directory
- [x] Git module — status, stage, commit, branches, remotes, log
- [x] Terminal manager — PTY sessions via node-pty, resize
- [x] Worktree manager — create, list, delete

### Issues
- [ ] **P2-1: File watcher is a stub** — `watcher.ts` is `export {}`, no filesystem change detection
- [ ] **P2-2: autoDetectProjects is too aggressive** — registers every `.git/` dir in org path with no filtering. User has flagged this as a problem
- [ ] **P2-3: Worktree lifecycle not verified end-to-end** — create/delete works in tests but unclear if UI wires to it

---

## Phase 3: Config & Protocol ✅ (Complete)

### Working
- [x] Config store — schema-validated (Ajv), hot-reload via bus events, env overrides
- [x] Config history — change tracking with diffs
- [x] REST API — full CRUD, export/import, `/api/config`
- [x] WS handler — multiplexed channels, subscriptions, scope filtering, auth

### Issues
- [ ] **P3-1: No config change notifications in UI** — hot-reload emits bus events but no toast/alert surfaces to user

---

## Phase 4: Diff, Issues, Review & Radicle ✅ (Mostly Complete)

### Working
- [x] Diff engine — text diff, file diff, semantic diff for JSON/YAML/TOML
- [x] Change set manager — track grouped changes
- [x] Issue tracker — GitHub provider (`gh` CLI), Radicle provider (`rad` CLI), unified interface
- [x] Issue caching — stale-while-revalidate pattern
- [x] Review system — GitHub provider (`gh pr`), Radicle provider (`rad patch`), merge handler
- [x] Radicle manager — repo init, clone, push, identity, peer discovery

### Issues
- [ ] **P4-1: Review system largely untested end-to-end** — implementation exists but unclear if `gh pr review`, `gh pr merge` paths actually work against real repos
- [ ] **P4-2: Radicle CLI integration unverified** — all `rad` commands are `execSync` wrappers, no integration tests against a real Radicle node
- [ ] **P4-3: Issue label-based dependency parsing** — `parseDependencies()` extracts `depends on #X` from issue bodies, but GitHub labels are not being written back

---

## Phase 5: Planning ✅ (Mostly Complete)

### Working
- [x] Graph engine — DAG, cycle detection, topological sort, critical path, completion rate
- [x] Dependency parser — `depends on #X`, `blocked by #X`, `blocks #X`, cross-project refs
- [x] Planning service — sync from providers, build graph, persist deps
- [x] Draft tasks — local-only tasks, publish to providers, bidirectional dependencies
- [x] Client DAG view — SVG rendering, Manhattan edge routing, zoom/pan, filter/search
- [x] Client kanban/list/tree views
- [x] Cross-org global planning view

### Issues
- [ ] **P5-1: Planning summary stats ignore project filter** — user reported: "Planning panel summary stats still show unfiltered counts when project filter active"
- [ ] **P5-2: Draft → edit panel flow unverified** — clicking a draft node should open DraftEditPanel, not confirmed working
- [ ] **P5-3: autoDetectProjects floods planning with irrelevant issues** — inherited from P2-2

---

## Phase 6: Chat & Voice ✅ (Core Working, Gaps Remain)

### Working
- [x] Chat module — send, abort, thread switching, history
- [x] OpenClaw backend — WS connection, auth, streaming, reconnection
- [x] Parse turns — converts gateway messages to structured ParsedTurn[]
- [x] Streaming — accumulated delta handling, markdown rendering
- [x] Thread management — create, switch, scoped to workspaces, move between workspaces
- [x] Subagent preview cards — inline cards with status, drill-down navigation, breadcrumbs
- [x] Gateway session management — reads sessions.json, System → Threads tab

### Issues
- [ ] **P6-1: Entity-bound threads not implemented** — spec says "every thread is associated with a branch, issue, or PR" with automatic event routing. Currently threads are just named containers with no entity binding
- [ ] **P6-2: Message forwarding unverified** — `POST /api/threads/:key/forward` exists but phase 6 integration test for it fails (now skipped)
- [ ] **P6-3: Event routing into threads not implemented** — spec says "Events from that entity (CI, review comments, status changes) route into the thread automatically". Not implemented
- [ ] **P6-4: AGENT/NOTIFY event classification not implemented** — spec says "AGENT events trigger autonomous work, NOTIFY events surface for user response". Not implemented
- [ ] **P6-5: Voice input (STT) integration incomplete** — `processChatRec` calls `/api/voice/transcribe` but unclear if the full pipeline works end-to-end
- [ ] **P6-6: TTS output routing not device-scoped** — spec says TTS only plays on the originating device. Current implementation unclear
- [ ] **P6-7: Thinking block handling is basic** — `stripThinkingBlocks()` exists but todo test items reference incomplete streaming-mid-thought handling
- [ ] **P6-8: Chat abort doesn't suppress lifecycle flicker** — todo: `suppressLifecycleUntil` timestamp
- [ ] **P6-9: No retry UI** — server passes through `retryAfterMs` but client countdown display has todo items
- [ ] **P6-10: Pending turn persistence removed** — was localStorage-based, removed in favor of "backend is source of truth", but reconnection may lose in-flight messages

---

## Phase 7: Observability ✅ (Mostly Complete)

### Working
- [x] Architecture view — module graph, subscribes/publishes relationships, live
- [x] System tabs — Overview, Architecture, Health, Config, Events, Jobs, Threads
- [x] Health history — time-series snapshots, configurable windows
- [x] Event stream — live WS events, rate tracking
- [x] Notifications list with priority badge in header

### Issues
- [ ] **P7-1: Health timeline canvas rendering** — test todo: "MUST port HealthTimeline component with canvas rendering". Current implementation exists but unclear if canvas graphs work
- [ ] **P7-2: SystemFlowGraph not ported** — todo: "SHOULD port SystemFlowGraph component" and "SHOULD wire to WS system.flow events"
- [ ] **P7-3: Context budget modal not ported** — voice-ui has `ContextBudgetModal.tsx` (511 lines), no equivalent in Sovereign
- [ ] **P7-4: Events view incomplete** — voice-ui `EventsView.tsx` is 1297 lines, Sovereign's `EventStreamTab` is much simpler
- [ ] **P7-5: Jobs tab may not work** — scheduler has no REST API (`/api/jobs` returns 404), only WS channel

---

## Phase 8: Recording, Transcription & Voice Intelligence ✅ (Structure Exists, Core Unverified)

### Working
- [x] Meeting model — CRUD, org-scoped, storage
- [x] Meeting import — parsers directory exists
- [x] Recording service — upload, store, list, delete, audio retrieval
- [x] Transcription queue — provider interface, async processing
- [x] Voice module — transcribe proxy (forwards to external service), TTS proxy
- [x] Voice acknowledgment — rule-based keyword extraction
- [x] Voice post-processor — strips markdown/code from TTS output
- [x] Speaker identification — speaker map management
- [x] Retention policy — configurable

### Issues
- [ ] **P8-1: Meeting summarization is a placeholder** — `onSummarize` callback returns `'Auto-generated summary placeholder'` with empty arrays. No actual LLM integration
- [ ] **P8-2: Transcription provider not configured** — `createTranscriptionQueue` takes a provider, but the voice module requires `transcribeUrl` in config. If not configured, transcription throws
- [ ] **P8-3: Meeting import parsers unverified** — `parsers/` directory exists but unclear which formats (Zoom, Otter.ai, Google Meet) are actually implemented
- [ ] **P8-4: Speaker timeline visualization** — todo: "SHOULD implement speaker timeline visualization in recording view"
- [ ] **P8-5: Transcription progress polling** — todo: "SHOULD implement transcription progress polling"
- [ ] **P8-6: Meeting UI may not be reachable** — meetings are under `/api/orgs/:orgId/meetings` but the MeetingsPanel in workspace may not wire correctly
- [ ] **P8-7: Recording search implementation** — `search.ts` exists but unclear if FTS is wired
- [ ] **P8-8: No actual Whisper/Ollama provider** — transcription relies on external `transcribeUrl`, no bundled local provider

---

## Cross-Cutting Issues

### Server
- [ ] **X-1: Daemon stability** — process gets SIGKILL when exec session ends. Needs launchd plist or proper daemonization
- [ ] **X-2: WebSocket broken through Tailscale Serve** — `wss://` through Tailscale doesn't work, only direct `ws://127.0.0.1:5801` works
- [ ] **X-3: Console.log pollution** — debug `console.log` statements throughout production code (e.g. `[chat] backend event:` on every event)
- [ ] **X-4: dist/ gets stale** — tests run against both `src/` and `dist/`, `dist/` failures are confusing duplicates
- [ ] **X-5: No graceful shutdown** — no SIGTERM handler to clean up PTY sessions, WS connections, timers

### Client
- [ ] **X-6: Dashboard `toFixed` crash** — `Cannot read properties of undefined (reading 'toFixed')` when disconnected
- [ ] **X-7: Some voice-ui components not fully ported** — InputArea, MessageBubble, ThreadDrawer are simplified vs voice-ui originals
- [ ] **X-8: Thread quick-switch (Cmd+K)** — todo item, not implemented
- [ ] **X-9: Activity feed** — todo item, not implemented
- [ ] **X-10: Markdown preview toggle** — todo item
- [ ] **X-11: Mobile UX gaps** — several todo items for mobile-specific interactions (long-press context menu, swipe gestures)

### Testing
- [ ] **X-12: 67 todo test stubs** — requirements written but not implemented
- [ ] **X-13: E2E tests are Playwright stubs** — 21 files, all just structure, no actual browser automation
- [ ] **X-14: No integration tests against real services** — all tests use mocks/stubs

---

## Priority Tiers

### Tier 1: Broken / Blocking Active Use
1. P1-2: Scheduler REST API (Jobs tab broken)
2. P6-8: Chat abort lifecycle flicker
3. P6-9: Retry countdown UI
4. X-1: Daemon stability
5. X-6: Dashboard crash when disconnected
6. X-3: Console.log pollution

### Tier 2: Incomplete Core Features
7. P1-3: Real disk usage reporting
8. P2-1: File watcher (stub)
9. P2-2: Project filtering for autoDetect
10. P5-1: Planning stats ignore project filter
11. P6-1: Entity-bound threads
12. P6-3: Event routing into threads
13. P7-5: Jobs tab ↔ scheduler API
14. P8-1: Meeting summarization (placeholder)

### Tier 3: Missing Nice-to-Have Features
15. P1-1: Push notifications (stub)
16. P6-5: Voice STT end-to-end verification
17. P6-6: Device-scoped TTS
18. P7-2: SystemFlowGraph
19. P7-3: Context budget modal
20. P8-4: Speaker timeline
21. X-8: Thread quick-switch (Cmd+K)

### Tier 4: Polish & Future
22. P4-1: Review system e2e verification
23. P4-2: Radicle integration verification
24. P8-3: Meeting import parsers
25. X-7: Voice-ui component parity
26. X-11: Mobile UX gaps
27. X-12: 67 todo test stubs
28. X-13: E2E Playwright tests
