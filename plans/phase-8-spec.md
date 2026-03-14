# Phase 8: Recording & Transcription — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-03-14

This document specifies the Recording & Transcription modules of Phase 8. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 8 depends on Phase 1 (event bus, notifications, scheduler), Phase 3 (WebSocket protocol, config), Phase 6 (chat, voice, threads), and Phase 7 (observability). It deepens the existing recording and voice infrastructure into a full session recording, transcription, and searchable archive system.

---

## Design Philosophy

**Recordings are first-class entities.** Every recording has metadata, audio, optional transcript, and entity bindings. They appear in thread timelines, workspace panels, and dashboards — not buried in a file browser.

**Thread-aware recording.** When a user records audio while in a thread context, the recording MUST auto-bind to that thread. The transcript (when available) becomes a chat message in the thread. This makes voice a natural input modality alongside text.

**Transcription is asynchronous.** Transcription MAY take seconds to minutes depending on provider and audio length. The system MUST handle this gracefully: recording is immediately available, transcript appears when ready, UI updates in real time via WS.

**Provider abstraction.** Transcription flows through a `TranscriptionProvider` interface. The initial implementation uses the existing voice module's transcription proxy (OpenClaw/Whisper/external API). Future providers (local Whisper, Ollama, etc.) slot in without changing the pipeline.

**File-driven persistence.** Audio files stored on disk. Metadata in JSON. Transcripts in plain text. Everything recoverable from the filesystem.

---

## What Exists

Phase 8 builds ON TOP of existing infrastructure:

**Server:**

- `voice/voice.ts` — `createVoiceModule()` with `transcribe(audioBuffer, mimeType)` and `synthesize(text, voice)`. Proxies to configured STT/TTS URLs. 176 lines.
- `voice/routes.ts` — `POST /api/voice/transcribe` (multipart upload), `POST /api/voice/tts`. Wired in `index.ts`.
- `recordings/recordings.ts` — `createRecordingsService(dataDir)` with `list`, `get`, `create`, `delete`, `getAudioPath`, `getTranscript`, `transcribe`. 103 lines. File-backed storage (JSON metadata + webm audio per recording).
- `recordings/routes.ts` — Full CRUD: `GET/POST /api/orgs/:orgId/recordings`, `GET/DELETE /api/orgs/:orgId/recordings/:id`, `GET /api/orgs/:orgId/recordings/:id/audio`, `GET /api/orgs/:orgId/recordings/:id/transcript`, `POST /api/orgs/:orgId/recordings/:id/transcribe`.
- `threads/` — Thread registry with entity bindings. Threads can bind to issues, PRs, branches.
- `chat/` — Chat module proxying to agent backend with session mapping.
- Event bus — all cross-module communication.

**Client:**

- `features/voice/VoiceView.tsx` — Full voice recording UI: record button, waveform, timer, transcript display.
- `features/voice/RecordingView.tsx` — Recording list with playback, duration, timestamps. In-memory `Recording[]` state (not server-backed).
- `features/workspace/panels/RecordingsPanel.tsx` — Workspace sidebar tab showing recordings for active workspace.

**Gaps this phase fills:**

1. RecordingView uses in-memory state only — needs server persistence
2. No transcription pipeline wired (recordings.transcribe is a no-op placeholder)
3. No thread binding for recordings
4. No real-time WS updates when recordings are created/transcribed
5. No search across transcripts
6. No auto-transcription on recording completion
7. VoiceView records but doesn't persist to recording service
8. No recording playback from server storage

---

## §8.1 — Recording Service Enhancements

The existing `RecordingsService` MUST be extended to support thread binding, transcription pipeline integration, and event bus emission.

### §8.1.1 — Extended Recording Metadata

```typescript
interface RecordingMeta {
  id: string
  orgId: string
  name: string
  duration: number // MUST be set (milliseconds)
  mimeType: string
  sizeBytes: number // MUST be set on create
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  threadKey?: string // Thread this recording belongs to
  entities?: EntityBinding[] // Inherited from thread or manually set
  transcript?: string // Full transcript text
  transcriptStatus: 'none' | 'pending' | 'completed' | 'failed'
  transcriptError?: string // Error message if failed
  transcriptCompletedAt?: string // ISO 8601
  tags?: string[] // User-defined tags
}
```

- `RecordingMeta` MUST include all fields above.
- `transcriptStatus` MUST default to `'none'` on create.
- `duration` MUST be provided by the client on upload (extracted from MediaRecorder).
- `sizeBytes` MUST be set from the uploaded buffer length.
- `updatedAt` MUST be updated on any metadata change.

### §8.1.2 — Recording Lifecycle Events

The recording service MUST emit bus events:

| Event                               | Payload                           | When                  |
| ----------------------------------- | --------------------------------- | --------------------- |
| `recording.created`                 | `{ orgId, id, name, threadKey? }` | New recording stored  |
| `recording.deleted`                 | `{ orgId, id }`                   | Recording removed     |
| `recording.transcription.started`   | `{ orgId, id }`                   | Transcription begins  |
| `recording.transcription.completed` | `{ orgId, id, durationMs }`       | Transcript ready      |
| `recording.transcription.failed`    | `{ orgId, id, error }`            | Transcription errored |

- All events MUST be emitted on the shared bus.
- The notification module's default rules SHOULD include a rule for `recording.transcription.completed` and `recording.transcription.failed`.

### §8.1.3 — Transcription Pipeline

```typescript
interface TranscriptionProvider {
  name: string
  transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    options?: {
      language?: string
      signal?: AbortSignal
    }
  ): Promise<{ text: string; segments?: TranscriptSegment[]; durationMs: number }>
  available(): boolean
}

interface TranscriptSegment {
  start: number // milliseconds
  end: number // milliseconds
  text: string
  confidence?: number
}
```

- The recording service MUST accept a `TranscriptionProvider` at construction.
- `createRecordingsService(bus, dataDir, transcriptionProvider)` — signature MUST change to accept bus and provider.
- The `transcribe(orgId, id)` method MUST:
  1. Set `transcriptStatus` to `'pending'` and emit `recording.transcription.started`.
  2. Read audio from disk.
  3. Call `provider.transcribe(buffer, mimeType)`.
  4. On success: store transcript text to `{id}.transcript.txt`, update metadata with `transcriptStatus: 'completed'`, emit `recording.transcription.completed`.
  5. On failure: update metadata with `transcriptStatus: 'failed'` and `transcriptError`, emit `recording.transcription.failed`.
- Transcription MUST be non-blocking — the route returns immediately, transcription runs in background.
- If `provider.available()` returns `false`, `transcribe()` MUST reject with a descriptive error.

### §8.1.4 — Voice Module Transcription Provider

- A `createVoiceTranscriptionProvider(voiceModule)` factory MUST adapt the existing `VoiceModule.transcribe()` into a `TranscriptionProvider`.
- This adapter MUST return `available(): boolean` based on whether the voice module has a transcription URL configured.
- Segment-level timestamps are NOT available from the basic voice proxy — `segments` SHOULD be `undefined` in the initial implementation.

### §8.1.5 — Auto-Transcription

- When `config.recordings.autoTranscribe` is `true` (default: `true`), the recording service MUST automatically start transcription after a recording is created.
- Auto-transcription MUST be triggered asynchronously after the create response is sent.
- Config changes to `recordings.autoTranscribe` MUST take effect immediately via `config.changed` bus event.

### §8.1.6 — Transcript Search

- The recording service MUST provide a `search(orgId, query, options?)` method.
- Search MUST scan transcript files for case-insensitive substring matches.
- Search MUST return `{ id, orgId, name, matches: { line: number, text: string, offset: number }[] }[]`.
- `options` MAY include `{ threadKey?, limit?, offset? }` for filtering.
- A `GET /api/orgs/:orgId/recordings/search?q=<query>` route MUST be added.

---

## §8.2 — Recording REST API

### §8.2.1 — Updated Routes

All existing routes MUST continue to work. New and updated routes:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/orgs/:orgId/recordings` | List recordings. MUST support `?threadKey=<key>` filter, `?limit=N&offset=N` pagination, `?sort=newest\|oldest` (default `newest`). |
| `POST` | `/api/orgs/:orgId/recordings` | Create recording. Multipart: `audio` file + JSON fields `name`, `duration`, `threadKey?`, `tags?`. MUST return 201 with full `RecordingMeta`. |
| `GET` | `/api/orgs/:orgId/recordings/search` | Search transcripts. Query: `q` (required), `threadKey?`, `limit?`, `offset?`. |
| `GET` | `/api/orgs/:orgId/recordings/:id` | Get recording metadata. |
| `PATCH` | `/api/orgs/:orgId/recordings/:id` | Update metadata (name, tags, threadKey). MUST return updated `RecordingMeta`. |
| `DELETE` | `/api/orgs/:orgId/recordings/:id` | Delete recording + audio + transcript. |
| `GET` | `/api/orgs/:orgId/recordings/:id/audio` | Stream audio file. MUST set `Content-Type` from metadata `mimeType`. MUST support `Range` header for seek. |
| `GET` | `/api/orgs/:orgId/recordings/:id/transcript` | Get transcript. MUST return `{ text, segments?, completedAt }`. |
| `POST` | `/api/orgs/:orgId/recordings/:id/transcribe` | Start transcription. Returns 202 `{ status: 'pending' }`. If already pending, returns 409. |

### §8.2.2 — Audio Streaming

- The `GET .../audio` route MUST support HTTP Range requests for audio seeking.
- MUST set `Accept-Ranges: bytes` header.
- MUST handle `Range: bytes=start-end` and respond with 206 Partial Content.
- MUST set `Content-Length` accurately.
- Full request (no Range header) MUST return 200 with complete file.

### §8.2.3 — Validation

- `POST` recording MUST reject if no audio file (400).
- `POST` recording MUST reject if audio exceeds `config.recordings.maxSizeBytes` (default: 100 MB) with 413.
- `PATCH` MUST reject unknown fields (400).
- `POST .../transcribe` MUST return 503 if transcription provider is unavailable.
- All error responses MUST use `{ error: string }` format.

---

## §8.3 — Recording WebSocket Channel

### §8.3.1 — Channel Registration

A `recordings` WS channel MUST be registered with the WS handler.

### §8.3.2 — Server → Client Messages

| Type | Payload | When |
| --- | --- | --- |
| `recording.created` | `RecordingMeta` | New recording stored |
| `recording.updated` | `RecordingMeta` | Metadata changed (including transcript status) |
| `recording.deleted` | `{ id, orgId }` | Recording removed |
| `recording.transcription.progress` | `{ id, orgId, status, progress? }` | Transcription status change |

- Messages MUST be scoped by `orgId` so clients subscribed to a specific org only receive that org's updates.

### §8.3.3 — Client Subscription

- Client subscribes: `{ type: 'subscribe', channels: ['recordings'], scope: { orgId: '<id>' } }`.
- Unscoped subscription MUST receive all recording events.
- On subscribe, the server SHOULD send a `recording.list` message with current recordings for the scoped org.

---

## §8.4 — Thread Integration

### §8.4.1 — Thread-Bound Recordings

- When a recording is created with a `threadKey`, it MUST appear in that thread's timeline.
- The chat module MUST listen for `recording.created` events where `threadKey` is set and inject a system message into the thread: `"🎙 Recording: {name} ({duration})"`.
- When transcription completes for a thread-bound recording, the chat module MUST inject the transcript as a user message: `"[Transcript from {name}]\n\n{text}"`.

### §8.4.2 — Thread Recording List

- `GET /api/threads/:key/recordings` MUST return all recordings bound to that thread, sorted by creation time.
- This route MUST delegate to the recording service's `list(orgId, { threadKey })` — the orgId is derived from the thread's primary entity or defaults to `_global`.

### §8.4.3 — Recording Entity Bindings

- When a recording is bound to a thread, it MUST inherit the thread's entity bindings.
- If the thread has no entities (e.g., main thread), the recording has no entity bindings.
- Entity bindings are stored on `RecordingMeta.entities` and are immutable after creation.

---

## §8.5 — Client Recording Integration

### §8.5.1 — VoiceView Server Persistence

The existing `VoiceView` component MUST be updated to persist recordings to the server:

- After `MediaRecorder.stop()` fires `ondataavailable`, the component MUST:
  1. Assemble the Blob from chunks.
  2. `POST /api/orgs/{orgId}/recordings` with the audio blob, name (auto-generated from timestamp), duration (from record timer), and current `threadKey` if in a thread context.
  3. On success, the recording appears in the recordings panel via WS update.
- The component MUST show upload progress/status.
- On upload failure, the component MUST retain the local blob and show a retry button.
- The VoiceView MUST NOT maintain its own in-memory recording list — it delegates to the recording service.

### §8.5.2 — RecordingView Server-Backed

The `RecordingView` component MUST be rewritten to use server data:

- MUST fetch recordings from `GET /api/orgs/:orgId/recordings`.
- MUST subscribe to the `recordings` WS channel for real-time updates.
- Each recording card MUST show:
  - Name (editable inline)
  - Duration (formatted `m:ss`)
  - Creation date (relative time)
  - Transcript status badge: none (gray), pending (yellow pulse), completed (green), failed (red)
  - Play/pause button with audio progress bar
  - Transcript expand/collapse (when available)
  - Delete button (with confirmation)
- Audio playback MUST use `<audio>` element with `src` pointing to `/api/orgs/:orgId/recordings/:id/audio`.
- Seeking MUST work (requires Range header support from server).

### §8.5.3 — RecordingsPanel Workspace Integration

The workspace sidebar `RecordingsPanel` MUST:

- Show recordings for the active workspace's org.
- Filter by thread when a thread is active in the workspace.
- Show a "Record" button that opens VoiceView in the chat panel.
- Show transcript search with inline results.
- Support drag-drop of audio files to upload.

### §8.5.4 — Transcript in Chat Timeline

When a recording is thread-bound and has a transcript:

- The chat timeline MUST render transcript messages with a distinct style (recording icon, audio player embed, expandable transcript text).
- Clicking the recording name in the transcript message MUST scroll to / open the recording in RecordingsPanel.

### §8.5.5 — Dashboard Recording Widget

The Dashboard MUST show a recording summary widget:

- Total recordings count.
- Total duration.
- Recent recordings (last 5) with quick play.
- Pending transcriptions count.

---

## §8.6 — Transcription Configuration

### §8.6.1 — Config Schema

```typescript
interface RecordingsConfig {
  autoTranscribe: boolean // Default: true
  maxSizeBytes: number // Default: 104857600 (100MB)
  transcription: {
    provider: 'voice-proxy' // Initial: use voice module's STT URL
    language?: string // BCP-47 language code, e.g. 'en'
    maxConcurrent: number // Default: 2
  }
  storage: {
    retentionDays?: number // Optional: auto-delete after N days. Null = keep forever
  }
}
```

- Config MUST be registered with the config module under `recordings.*`.
- Config changes MUST take effect immediately via `config.changed` bus event.
- `maxConcurrent` MUST limit parallel transcription jobs using a semaphore/queue.

### §8.6.2 — Retention Policy

- If `storage.retentionDays` is set, the scheduler MUST run a daily cleanup job.
- The job MUST delete recordings (metadata + audio + transcript) older than the retention period.
- Deletions MUST emit `recording.deleted` events.
- The job MUST be registered as a system scheduler job on startup.

---

## §8.7 — Notification Rules

The notification module's default rules MUST include recording-related rules:

| Event Pattern                       | Severity  | Title                  | Body                                     |
| ----------------------------------- | --------- | ---------------------- | ---------------------------------------- |
| `recording.transcription.completed` | `info`    | `Transcript ready`     | `Transcription completed for "{name}"`   |
| `recording.transcription.failed`    | `warning` | `Transcription failed` | `Failed to transcribe "{name}": {error}` |

- These rules MUST be seeded by the recording module (not notification module) on startup.
- Rules MUST include `entityType: 'recording'` and `entityId` set to the recording ID.

---

## §8.8 — Observability Integration

### §8.8.1 — Logger

- The recording module MUST use `createLogger(logsChannel, 'recordings')`.
- MUST log: `info` on create, `info` on transcription complete, `warn` on transcription failure, `error` on storage errors.
- Logs MUST include `entityId` (recording ID) for correlation.

### §8.8.2 — System Module Registration

- The recording module MUST register with `systemModule.registerModule()`:
  - `name: 'recordings'`
  - `subscribes: ['config.changed', 'recording.*']`
  - `publishes: ['recording.created', 'recording.deleted', 'recording.transcription.started', 'recording.transcription.completed', 'recording.transcription.failed']`

### §8.8.3 — Health Metrics

- The recording module MUST contribute to system health:
  - `recordings.totalCount` — total recordings across all orgs
  - `recordings.pendingTranscriptions` — count of pending transcriptions
  - `recordings.storageBytes` — total audio storage size

---

## Implementation Waves

### Wave 1: Server — Recording Service + Transcription Pipeline

- §8.1 Recording service enhancements (metadata, events, transcription pipeline, auto-transcribe, search)
- §8.2 REST API updates (Range requests, validation, search route, PATCH)
- §8.3 WS channel registration
- §8.6 Config schema registration
- §8.7 Notification rules
- §8.8 Observability integration

### Wave 2: Server — Thread Integration

- §8.4 Thread-bound recordings, thread recording list, entity bindings
- §8.6.2 Retention policy scheduler job

### Wave 3: Client — Recording UI

- §8.5.1 VoiceView server persistence
- §8.5.2 RecordingView server-backed rewrite
- §8.5.3 RecordingsPanel workspace integration
- §8.5.4 Transcript in chat timeline
- §8.5.5 Dashboard recording widget

### Wave 4: Integration + Polish

- Wire all modules in `index.ts`
- End-to-end test: record → upload → auto-transcribe → transcript appears in thread
- curl verification of all endpoints
- Browser verification of all UI components

---

## File Structure

### Server

```
packages/server/src/
├── recordings/
│   ├── recordings.ts          # Recording service (enhanced)
│   ├── recordings.test.ts     # Service tests (enhanced)
│   ├── routes.ts              # REST routes (enhanced)
│   ├── routes.test.ts         # Route tests (new)
│   ├── ws.ts                  # WS channel (new)
│   ├── ws.test.ts             # WS tests (new)
│   ├── transcription.ts       # TranscriptionProvider + pipeline (new)
│   ├── transcription.test.ts  # Transcription tests (new)
│   ├── retention.ts           # Retention policy job (new)
│   ├── retention.test.ts      # Retention tests (new)
│   └── search.ts              # Transcript search (new)
│   └── search.test.ts         # Search tests (new)
├── voice/
│   ├── voice.ts               # (unchanged)
│   ├── voice.test.ts          # (unchanged)
│   ├── routes.ts              # (unchanged)
│   ├── provider.ts            # VoiceTranscriptionProvider adapter (new)
│   └── provider.test.ts       # Provider adapter tests (new)
```

### Client

```
packages/client/src/features/
├── voice/
│   ├── VoiceView.tsx          # Updated: server persistence
│   ├── VoiceView.test.ts      # Updated
│   ├── RecordingView.tsx      # Rewritten: server-backed
│   └── RecordingView.test.ts  # Rewritten
├── workspace/panels/
│   └── RecordingsPanel.tsx    # Updated: server data, search, drag-drop
│   └── RecordingsPanel.test.ts # Updated
├── dashboard/
│   └── RecordingWidget.tsx    # New: recording summary widget
│   └── RecordingWidget.test.ts # New
├── chat/
│   └── TranscriptMessage.tsx  # New: recording transcript in chat timeline
│   └── TranscriptMessage.test.ts # New
```

---

## Dependencies

- Phase 1: Event bus, scheduler (retention job)
- Phase 3: WebSocket protocol (recordings channel), config module
- Phase 6: Voice module (transcription proxy), chat module (thread injection), threads (entity bindings)
- Phase 7: Logger factory, system module registration, notification rules

No new npm dependencies required. Audio handling uses Node.js `fs` streams and `Buffer`. Range request handling uses standard HTTP headers.

---

## Negative Constraints

- The recording service MUST NOT store audio in a database — files on disk only.
- The recording service MUST NOT perform transcription synchronously in the request handler.
- The client MUST NOT implement its own audio format conversion — the server accepts whatever the browser's MediaRecorder produces.
- The transcript search MUST NOT require an external search engine — simple file scanning is sufficient for this phase.
- The recording module MUST NOT import from chat, threads, or voice modules directly — all cross-module communication via event bus.
- Audio files MUST NOT be base64-encoded for WS transport — WS messages contain metadata only; audio is served via HTTP.
- The retention job MUST NOT delete recordings without emitting `recording.deleted` events.
