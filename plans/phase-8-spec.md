# Phase 8: Recording, Transcription & Voice Intelligence — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-03-14

This document specifies the Recording, Transcription & Voice Intelligence modules of Phase 8. All modules MUST conform to [PRINCIPLES.md](../PRINCIPLES.md). Each section defines requirements using MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

Phase 8 depends on Phase 1 (event bus, notifications, scheduler), Phase 3 (WebSocket protocol, config), Phase 6 (chat, voice, threads), and Phase 7 (observability). It delivers voice as a first-class workspace modality — recording, diarization, transcription, summarization, meeting history, thread-level TTS/STT, and external meeting import.

---

## Design Philosophy

**Voice is a workspace-level knowledge source.** Recordings are not just audio files — they are meetings, conversations, and decisions that feed into workspace context and memory. Every recording produces a transcript, every transcript produces a summary, and summaries become part of the workspace's living knowledge base.

**Diarization matters.** Knowing _who_ said _what_ transforms a wall of text into actionable meeting notes. Speaker identification (diarization) MUST be a core feature, not an afterthought.

**Meetings are first-class entities.** A "meeting" is a recording (or set of recordings) with diarization, transcript, summary, action items, and workspace context bindings. Meetings have their own history, searchable archive, and thread integration.

**External meetings belong here too.** Teams use Zoom, Google Meet, Teams, in-person recorders. Users MUST be able to import external recordings and transcripts into workspace threads, where they're processed through the same diarization → transcription → summarization → context pipeline.

**Thread-level voice I/O.** Users can speak into threads (STT) and hear responses (TTS). Voice is just another modality alongside text — same thread, same context, same agent.

**Workspace context integration.** Meeting summaries, action items, and key decisions automatically feed into workspace-level context. When an agent works in a workspace, it has access to meeting history and decisions as part of its context window.

---

## What Exists

**Server:**

- `voice/voice.ts` — `createVoiceModule()` with `transcribe(audioBuffer, mimeType)` and `synthesize(text, voice)`. Proxies to configured STT/TTS URLs. 176 lines.
- `voice/routes.ts` — `POST /api/voice/transcribe` (multipart upload), `POST /api/voice/tts`.
- `recordings/recordings.ts` — `createRecordingsService(dataDir)` with basic CRUD. File-backed (JSON meta + webm audio). 103 lines.
- `recordings/routes.ts` — Full CRUD routes for recordings.
- `threads/` — Thread registry with entity bindings.
- `chat/` — Chat module proxying to agent backend with session mapping.

**Client:**

- `features/voice/VoiceView.tsx` — Voice recording UI (record button, waveform, timer, transcript display).
- `features/voice/RecordingView.tsx` — Recording list with playback (in-memory state only, not server-backed).
- `features/workspace/panels/RecordingsPanel.tsx` — Workspace sidebar tab (stub).

**Gaps this phase fills:**

1. No diarization (speaker identification)
2. No meeting concept — recordings are isolated audio files
3. No summarization pipeline
4. No workspace-level context integration
5. No TTS/STT in thread chat
6. No external meeting/transcript import
7. RecordingView uses in-memory state only
8. No meeting history or search

---

## §8.1 — Transcription & Diarization Pipeline

### §8.1.1 — TranscriptionProvider Interface

```typescript
interface TranscriptionProvider {
  name: string
  capabilities: {
    diarization: boolean
    timestamps: boolean
    languages: string[] // BCP-47 codes
  }
  transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    options?: {
      language?: string
      diarize?: boolean
      signal?: AbortSignal
    }
  ): Promise<TranscriptionResult>
  available(): boolean
}

interface TranscriptionResult {
  text: string // Full transcript text
  segments: TranscriptSegment[] // Timestamped segments
  speakers?: SpeakerMap // Diarization results
  durationMs: number
  language?: string // Detected language
}

interface TranscriptSegment {
  start: number // milliseconds
  end: number // milliseconds
  text: string
  speaker?: string // Speaker ID (e.g. "SPEAKER_00")
  confidence?: number
}

interface SpeakerMap {
  [speakerId: string]: {
    label?: string // User-assigned name (e.g. "Josh")
    segments: number[] // Indices into segments array
    totalDurationMs: number
  }
}
```

- The pipeline MUST support pluggable providers via the `TranscriptionProvider` interface.
- The initial provider MUST adapt the existing voice module's STT proxy.
- Diarization MUST be requested when the provider supports it (`capabilities.diarization`).
- If the provider does not support diarization, the transcript MUST still be produced without speaker labels.

### §8.1.2 — Voice Module Provider Adapter

- `createVoiceTranscriptionProvider(voiceModule)` MUST adapt `VoiceModule.transcribe()` into a `TranscriptionProvider`.
- `available()` MUST return `true` only when the voice module has a transcription URL configured.
- Diarization capability depends on the upstream STT service — the adapter MUST report `diarization: false` unless the configured endpoint supports it.
- Future providers (local Whisper with pyannote, Ollama, etc.) slot in without changing the pipeline.

### §8.1.3 — Transcription Queue

- Transcription MUST be non-blocking — requests return immediately, processing runs in background.
- A transcription queue MUST enforce `config.recordings.transcription.maxConcurrent` (default: 2).
- Queue MUST be FIFO with priority override for user-initiated transcriptions over auto-transcriptions.
- Queue status MUST be queryable: pending count, active count, estimated wait.

---

## §8.2 — Meeting Model

### §8.2.1 — Meeting Entity

```typescript
interface Meeting {
  id: string
  orgId: string
  title: string
  description?: string
  createdAt: string // ISO 8601
  updatedAt: string
  startedAt?: string // Actual meeting start time (may differ from createdAt)
  endedAt?: string // Meeting end time
  duration: number // Total duration in milliseconds
  threadKey?: string // Associated thread
  entities?: EntityBinding[]

  // Recording
  recordings: string[] // Recording IDs (a meeting may have multiple segments)

  // Transcription
  transcript?: {
    status: 'none' | 'pending' | 'completed' | 'failed'
    text?: string // Full merged transcript
    segments?: TranscriptSegment[]
    speakers?: SpeakerMap
    completedAt?: string
    error?: string
  }

  // Summarization
  summary?: {
    status: 'none' | 'pending' | 'completed' | 'failed'
    text?: string // Narrative summary
    actionItems?: ActionItem[]
    decisions?: string[]
    keyTopics?: string[]
    completedAt?: string
    error?: string
  }

  // Metadata
  source: 'native' | 'import' // Recorded in Sovereign vs imported
  importMeta?: {
    platform?: string // 'zoom', 'google-meet', 'teams', 'otter', etc.
    originalFileName?: string
    importedAt: string
  }
  tags?: string[]
}

interface ActionItem {
  text: string
  assignee?: string // Speaker label or username
  dueDate?: string
  status: 'open' | 'done'
}
```

- A meeting MUST be the primary container for recordings, transcripts, and summaries.
- A meeting MAY contain multiple recordings (multi-segment meetings, pause/resume).
- Meetings MUST be persisted as JSON files in `{dataDir}/meetings/{orgId}/{id}.json`.
- Audio files MUST remain in `{dataDir}/recordings/{orgId}/` (shared with recording service).

### §8.2.2 — Meeting Lifecycle Events

| Event                          | Payload                        | When                 |
| ------------------------------ | ------------------------------ | -------------------- |
| `meeting.created`              | `{ orgId, id, title, source }` | Meeting created      |
| `meeting.updated`              | `{ orgId, id, changes }`       | Metadata updated     |
| `meeting.deleted`              | `{ orgId, id }`                | Meeting removed      |
| `meeting.transcript.started`   | `{ orgId, id }`                | Transcription begins |
| `meeting.transcript.completed` | `{ orgId, id }`                | Transcript ready     |
| `meeting.transcript.failed`    | `{ orgId, id, error }`         | Transcription failed |
| `meeting.summary.started`      | `{ orgId, id }`                | Summarization begins |
| `meeting.summary.completed`    | `{ orgId, id }`                | Summary ready        |
| `meeting.summary.failed`       | `{ orgId, id, error }`         | Summarization failed |

### §8.2.3 — Speaker Label Management

- Users MUST be able to assign human-readable labels to speaker IDs (e.g. `SPEAKER_00` → `Josh`).
- Speaker labels MUST persist across meetings — if `SPEAKER_00` is labeled `Josh` in one meeting, future meetings SHOULD suggest the same mapping.
- Speaker label mappings MUST be stored per-org in `{dataDir}/meetings/{orgId}/speakers.json`.
- `PATCH /api/orgs/:orgId/meetings/:id/speakers` MUST update speaker labels for a specific meeting.
- `GET /api/orgs/:orgId/speakers` MUST return the org-wide speaker label history.

---

## §8.3 — Summarization Pipeline

### §8.3.1 — Meeting Summarization

- When a transcript completes, summarization MUST be triggered automatically if `config.recordings.autoSummarize` is `true` (default: `true`).
- Summarization MUST use the agent backend (via chat module) to generate:
  1. **Narrative summary** — concise overview of the meeting.
  2. **Action items** — extracted tasks with assignee (from speaker labels) and optional due dates.
  3. **Key decisions** — explicit decisions made during the meeting.
  4. **Key topics** — main subjects discussed.
- The summarization prompt MUST include speaker labels for attribution.
- Summarization MUST be non-blocking (queued like transcription).

### §8.3.2 — Workspace Context Integration

- Meeting summaries MUST be written to `{dataDir}/meetings/{orgId}/context/` as Markdown files.
- The context file format:

```markdown
# Meeting: {title}

**Date:** {startedAt} **Duration:** {duration} **Participants:** {speakers}

## Summary

{narrative summary}

## Action Items

- [ ] {action item 1} — @{assignee}
- [ ] {action item 2} — @{assignee}

## Decisions

- {decision 1}
- {decision 2}

## Key Topics

{topic 1}, {topic 2}, {topic 3}
```

- Context files MUST be indexed for search (Phase 9 memory/embeddings will consume these).
- A `GET /api/orgs/:orgId/meetings/context` route MUST return aggregated meeting context (most recent N meetings' summaries, action items, decisions).
- The meeting context endpoint MUST support `?since=<ISO date>` and `?limit=N` parameters.

### §8.3.3 — Meeting History

- `GET /api/orgs/:orgId/meetings` MUST return paginated meeting history sorted by date (newest first).
- MUST support filters: `?threadKey=`, `?since=`, `?until=`, `?source=native|import`, `?search=<query>`.
- Search MUST scan meeting titles, summaries, and transcript text.
- Each meeting in the list MUST include: id, title, date, duration, speakers count, transcript status, summary status, thread key.

---

## §8.4 — Recording Service Enhancements

### §8.4.1 — Extended Recording Metadata

```typescript
interface RecordingMeta {
  id: string
  orgId: string
  meetingId?: string // Parent meeting
  name: string
  duration: number // milliseconds
  sizeBytes: number
  mimeType: string
  createdAt: string
  updatedAt: string
  threadKey?: string
  entities?: EntityBinding[]
  transcriptStatus: 'none' | 'pending' | 'completed' | 'failed'
  tags?: string[]
}
```

- `RecordingMeta` MUST link to a parent `meetingId` when part of a meeting.
- `createRecordingsService(bus, dataDir, transcriptionProvider)` — signature MUST accept bus and provider.
- The recording service MUST emit `recording.created`, `recording.deleted` bus events.

### §8.4.2 — Auto-Transcription & Meeting Creation

- When `config.recordings.autoTranscribe` is `true` (default), transcription MUST start automatically after recording creation.
- When a recording is created with a `threadKey` and no `meetingId`, a meeting MUST be auto-created and the recording linked to it.
- Config changes MUST take effect immediately via `config.changed` bus event.

### §8.4.3 — Audio Streaming

- `GET /api/orgs/:orgId/recordings/:id/audio` MUST support HTTP Range requests (206 Partial Content) for seeking.
- MUST set `Accept-Ranges: bytes` and accurate `Content-Length`.

### §8.4.4 — File Size Validation

- Uploads MUST reject audio exceeding `config.recordings.maxSizeBytes` (default: 100 MB) with 413.

---

## §8.5 — Thread Voice I/O

### §8.5.1 — Speech-to-Text in Threads

- Users MUST be able to record voice messages directly in thread chat input.
- The recorded audio MUST be:
  1. Uploaded as a recording (linked to the thread).
  2. Transcribed via the transcription pipeline.
  3. The transcript text MUST be sent as the user's chat message in the thread.
- While transcription is pending, a placeholder message MUST show: `"🎙 Transcribing..."`.
- On completion, the placeholder MUST be replaced with the transcript text.
- The original audio MUST remain accessible (play button on the message).

### §8.5.2 — Text-to-Speech in Threads

- Agent responses in threads MAY be read aloud via TTS.
- A "play" button MUST appear on assistant messages to trigger TTS.
- TTS MUST use the existing voice module's `synthesize()` method.
- Audio playback MUST be interruptible (stop button replaces play while active).
- Auto-TTS mode: when enabled (`config.voice.autoTTS`), agent responses MUST auto-play. Default: `false`.

#### §8.5.2.0 — Device-Scoped Audio

Users may be connected from multiple devices simultaneously (laptop, phone, etc.). Text messages, thread state, meeting updates, and all other data MUST sync in real time across all connected devices. TTS audio output MUST NOT.

- TTS audio (both agent response TTS and voice acknowledgments) MUST only play on the device that originated the STT request.
- The device that records and sends a voice message MUST be tagged as the **voice-originating device** for that interaction.
- The server MUST track which device (by connection/session ID) initiated a voice-mode message.
- When the agent response is ready for TTS, the `chat` WS channel MUST include a `ttsTargetDevice` field identifying the originating device. Only that device synthesizes and plays audio.
- Other connected devices MUST receive the text response and all metadata in real time — they simply skip TTS playback.
- Manual TTS (user clicks play button on a message) is always local to the device that clicked — no device-scoping needed since it's user-initiated.
- Voice mode state itself is per-device — one device can be in voice mode while another is in text mode on the same thread.

#### §8.5.2.1 — TTS Post-Processing (Conversational Voice)

Agent text responses often contain content unsuitable for spoken output — file paths, URLs, Markdown formatting, code blocks, tables, raw JSON. Reading these aloud produces a poor experience.

- When voice mode is ON and auto-TTS is active, agent responses MUST be post-processed before TTS synthesis.
- Phase 8 MUST define a `VoicePostProcessor` interface:

```typescript
interface VoicePostProcessor {
  /** Transform agent text into natural spoken language */
  process(
    agentResponse: string,
    context?: {
      threadKey?: string
      lastUserMessage?: string
    }
  ): Promise<string>
}
```

- Phase 8 MUST implement a **rule-based fallback** post-processor:
  - Strip Markdown formatting (bold, italic, headers, links).
  - Replace URLs with "a link" or "a link to [domain]".
  - Replace file paths with "a file called [basename]".
  - Omit code blocks entirely, replace with "some code" or "a code snippet".
  - Omit tables, replace with a brief description ("a table with N rows").
  - Collapse excessive whitespace and list markers.
- This fallback MUST work without any LLM dependency.

- Phase 9 (Agent Core, §9.6 LLM Router) MUST implement an **LLM-powered post-processor** that replaces the rule-based fallback:
  - Send the agent response to a local LLM (Ollama) with a system prompt instructing it to rewrite the content as natural spoken language.
  - The prompt MUST instruct the LLM to: preserve meaning, use conversational tone, describe rather than read technical artifacts, be concise.
  - The LLM post-processor MUST fall back to the rule-based processor if Ollama is unavailable.
  - Config: `voice.postProcessor: 'rules' | 'llm'` (default: `'llm'` when Phase 9 is available, `'rules'` otherwise).

### §8.5.2.2 — Immediate Voice Acknowledgment

When a user speaks to a thread via voice input, there is a delay between sending the message and receiving the agent's response. In text mode this is fine (typing indicators). In voice mode, silence feels broken.

- When voice mode is ON and a user message is sent via STT, the system MUST generate and speak a single acknowledgment sentence **in parallel** with the agent beginning work.
- Phase 8 MUST implement a **rule-based acknowledgment generator**:
  - Takes the user's transcribed message as input.
  - Generates a single contextual sentence that acknowledges the request (e.g., user says "Can you check the build logs?" → "Checking the build logs now").
  - Uses the same `VoicePostProcessor` pipeline — input is the user's message, output is a brief spoken acknowledgment.
  - The generator MUST be a lightweight text transformation (template + keyword extraction), NOT an LLM call. It runs synchronously so TTS can begin immediately.
  - Pattern: extract the verb/intent from the user's message, reframe as "I'll [verb] [object]" or "[Verb]ing [object] now".
  - Fallback for unparseable input: "Let me work on that".
- The acknowledgment MUST be synthesized via TTS and played immediately — it MUST NOT wait for the agent to respond.
- The acknowledgment MUST NOT play if the agent response arrives within `config.voice.ackDelayMs` (default: 1500ms). Implementation: start TTS synthesis immediately but delay audio playback by `ackDelayMs`. If the agent response arrives before playback starts, cancel it.
- The acknowledgment audio MUST be interrupted if the agent's full TTS response begins playing.

- Phase 9 (Agent Core, §9.7 Agent Loop) MUST enhance this with **agent-aware acknowledgments**:
  - The agent loop MUST emit a `agent.turn.started` bus event when processing begins, with optional `intent` metadata (e.g., "looking at code", "checking the build", "reading the file").
  - The voice system subscribes to this event and, if voice mode is ON, generates a contextual acknowledgment via local LLM — richer and more accurate than the rule-based version since it has agent intent context.
  - Falls back to rule-based acknowledgment if LLM is unavailable or too slow.
  - Config: `voice.contextualAck: boolean` (default: `true` when Phase 9 available).

### §8.5.3 — Voice Mode Toggle

- Thread chat MUST have a voice mode toggle (microphone icon in input area).
- When voice mode is ON:
  - Input area shows a push-to-talk button instead of text input.
  - Recording → transcription → send flow is seamless.
  - Agent responses auto-play via TTS (overrides `autoTTS` config).
- When voice mode is OFF:
  - Standard text input.
  - TTS available via per-message play button.

---

## §8.6 — External Meeting Import

### §8.6.1 — Import Formats

Users MUST be able to import meetings from external sources:

| Format | Input | Processing |
| --- | --- | --- |
| Audio file | `.mp3`, `.wav`, `.m4a`, `.ogg`, `.webm` | Full pipeline: transcribe → diarize → summarize |
| Transcript file | `.txt`, `.srt`, `.vtt` | Parse → diarize (if SRT/VTT has speaker labels) → summarize |
| Structured transcript | `.json` (Otter.ai, Zoom, etc.) | Parse speakers + timestamps → summarize |

### §8.6.2 — Import API

- `POST /api/orgs/:orgId/meetings/import` — multipart upload.
  - Fields: `title` (required), `threadKey?`, `platform?`, `startedAt?`, `tags?`.
  - File: `audio` OR `transcript` (at least one required, both allowed).
- On import:
  1. Create a meeting with `source: 'import'` and `importMeta`.
  2. If audio provided: store as recording, trigger transcription pipeline.
  3. If transcript provided: parse format, store as meeting transcript.
  4. If both: store audio, use provided transcript (skip transcription), proceed to summarization.
  5. Trigger summarization when transcript is available.

### §8.6.3 — Transcript Parsers

- The import module MUST include parsers for:
  - **Plain text** — treat entire content as a single speaker transcript.
  - **SRT/VTT** — parse timestamps and text; extract speaker labels if present in format `[Speaker Name]: text` or `<v Speaker Name>text`.
  - **Otter.ai JSON** — parse `{ speakers, transcript }` format.
  - **Zoom transcript** — parse the `transcript.vtt` format from Zoom cloud recordings.
- Parsers MUST be pluggable — new formats can be added without modifying the import handler.
- Unrecognized formats MUST be rejected with 400 and a descriptive error listing supported formats.

### §8.6.4 — Thread Routing for Imports

- When `threadKey` is provided, the imported meeting MUST be bound to that thread.
- The meeting summary MUST be injected into the thread as a system message.
- If no `threadKey` is provided, the meeting is workspace-level (accessible from meetings panel, not thread-bound).

---

## §8.7 — WebSocket Channels

### §8.7.1 — Meetings Channel

A `meetings` WS channel MUST be registered:

| Type              | Payload          | When                                                 |
| ----------------- | ---------------- | ---------------------------------------------------- |
| `meeting.created` | `Meeting` (full) | New meeting                                          |
| `meeting.updated` | `Meeting` (full) | Any change (transcript, summary, speakers, metadata) |
| `meeting.deleted` | `{ id, orgId }`  | Meeting removed                                      |

- Scoped by `orgId`.

### §8.7.2 — Recordings Channel

A `recordings` WS channel MUST be registered:

| Type                | Payload         | When          |
| ------------------- | --------------- | ------------- |
| `recording.created` | `RecordingMeta` | New recording |
| `recording.updated` | `RecordingMeta` | Status change |
| `recording.deleted` | `{ id, orgId }` | Removed       |

- Scoped by `orgId`.

---

## §8.8 — REST API Summary

| Method   | Path                                       | Description                                                |
| -------- | ------------------------------------------ | ---------------------------------------------------------- |
| `GET`    | `/api/orgs/:orgId/meetings`                | List meetings (paginated, filterable)                      |
| `POST`   | `/api/orgs/:orgId/meetings`                | Create meeting manually                                    |
| `POST`   | `/api/orgs/:orgId/meetings/import`         | Import external meeting                                    |
| `GET`    | `/api/orgs/:orgId/meetings/context`        | Aggregated meeting context (summaries, actions, decisions) |
| `GET`    | `/api/orgs/:orgId/meetings/:id`            | Get meeting detail                                         |
| `PATCH`  | `/api/orgs/:orgId/meetings/:id`            | Update meeting metadata                                    |
| `DELETE` | `/api/orgs/:orgId/meetings/:id`            | Delete meeting + recordings + transcript                   |
| `POST`   | `/api/orgs/:orgId/meetings/:id/transcribe` | Re-trigger transcription                                   |
| `POST`   | `/api/orgs/:orgId/meetings/:id/summarize`  | Re-trigger summarization                                   |
| `PATCH`  | `/api/orgs/:orgId/meetings/:id/speakers`   | Update speaker labels                                      |
| `GET`    | `/api/orgs/:orgId/meetings/:id/transcript` | Get full transcript                                        |
| `GET`    | `/api/orgs/:orgId/meetings/:id/audio`      | Stream merged audio                                        |
| `GET`    | `/api/orgs/:orgId/speakers`                | Org-wide speaker label history                             |
| `GET`    | `/api/orgs/:orgId/recordings`              | List recordings (with meeting/thread filters)              |
| `POST`   | `/api/orgs/:orgId/recordings`              | Upload recording                                           |
| `GET`    | `/api/orgs/:orgId/recordings/:id`          | Recording metadata                                         |
| `GET`    | `/api/orgs/:orgId/recordings/:id/audio`    | Stream audio (Range support)                               |
| `DELETE` | `/api/orgs/:orgId/recordings/:id`          | Delete recording                                           |
| `GET`    | `/api/orgs/:orgId/recordings/search`       | Search transcripts                                         |
| `GET`    | `/api/threads/:key/meetings`               | Meetings bound to a thread                                 |
| `GET`    | `/api/system/transcription/queue`          | Transcription queue status                                 |

---

## §8.9 — Client UI

### §8.9.1 — Meetings Panel (Workspace Sidebar)

A new "Meetings" sidebar tab MUST replace the existing "Recordings" tab:

- Meeting list sorted by date (newest first).
- Each card: title, date, duration, participant count, transcript/summary status badges.
- Expand to see: summary preview, action items, speaker list.
- Click to open full meeting detail in main content area.
- Search bar: search across titles, summaries, transcripts.
- "Import" button for external meeting upload.
- "Record" button to start a new meeting recording.

### §8.9.2 — Meeting Detail View (Main Content Tab)

A new content tab type for full meeting exploration:

- **Header:** title (editable), date, duration, participants.
- **Tabs within meeting:** Summary | Transcript | Action Items | Audio
- **Summary tab:** narrative summary, key decisions, key topics.
- **Transcript tab:** timestamped transcript with speaker labels (color-coded). Click speaker label to rename. Click timestamp to seek audio.
- **Action items tab:** checklist with assignee, due date. Toggle done/open.
- **Audio tab:** waveform player with playback speed control. Speaker timeline visualization (colored bars showing who spoke when).

### §8.9.3 — Thread Voice Controls

- **Microphone button** in thread input area — tap to record, tap again to stop.
- **Voice mode toggle** — switches input between text and push-to-talk.
- **TTS play button** on assistant messages.
- **Transcribing indicator** — pulsing microphone icon while STT processes.
- **Audio attachment** — small audio player embedded in messages that were voice-originated.

### §8.9.4 — Dashboard Meeting Widget

- Recent meetings (last 5) with quick-view summaries.
- Pending transcriptions/summarizations count.
- Total meeting hours this week/month.
- Action items needing attention (open, past due).

### §8.9.5 — VoiceView Integration

- VoiceView MUST persist recordings to server on completion.
- MUST auto-create a meeting when recording finishes.
- MUST show upload progress and transcription status.

---

## §8.10 — Configuration

```typescript
interface RecordingsConfig {
  autoTranscribe: boolean // Default: true
  autoSummarize: boolean // Default: true
  maxSizeBytes: number // Default: 104857600 (100MB)
  transcription: {
    provider: 'voice-proxy' // Initial: use voice module's STT URL
    language?: string // BCP-47, e.g. 'en'
    maxConcurrent: number // Default: 2
    diarization: boolean // Default: true (if provider supports)
  }
  voice: {
    autoTTS: boolean // Default: false
    ttsVoice?: string // Preferred TTS voice
    postProcessor: 'rules' | 'llm' // Default: 'rules' (Phase 9 enables 'llm')
    ackDelayMs: number // Default: 1500 — suppress ack if agent responds within this
    contextualAck: boolean // Default: false (Phase 9 enables true)
  }
  storage: {
    retentionDays?: number // Null = keep forever
  }
}
```

- Config MUST be registered under `recordings.*` and `voice.*`.
- Retention policy: if `retentionDays` set, scheduler runs daily cleanup.
- All config changes MUST take effect immediately via `config.changed`.

---

## §8.11 — Observability Integration

- Logger: `createLogger(logsChannel, 'meetings')` and `createLogger(logsChannel, 'recordings')`.
- System module registration with subscribes/publishes.
- Health metrics: `meetings.totalCount`, `recordings.pendingTranscriptions`, `recordings.storageBytes`.
- Notification rules: transcription completed/failed, summarization completed/failed.

---

## Implementation Waves

### Wave 1: Server — Transcription Pipeline & Meeting Model

- §8.1 TranscriptionProvider interface, voice module adapter, transcription queue
- §8.2 Meeting model, CRUD, lifecycle events, speaker management
- §8.4 Recording service enhancements (bus events, meetingId, auto-transcribe)
- §8.7 WS channels (meetings, recordings)
- §8.10 Config schema
- §8.11 Observability

### Wave 2: Server — Summarization & External Import

- §8.3 Summarization pipeline (agent backend integration, context files)
- §8.6 External meeting import (parsers for txt, SRT/VTT, Otter.ai, Zoom)
- §8.8 Full REST API wiring

### Wave 3: Server — Thread Integration & Voice I/O

- §8.5 Thread voice I/O (STT in threads, TTS on responses, voice mode)
- Thread-bound meeting injection (summary as system message)
- `GET /api/threads/:key/meetings` route

### Wave 4: Client — Meeting UI

- §8.9.1 Meetings panel (workspace sidebar)
- §8.9.2 Meeting detail view (content tab)
- §8.9.3 Thread voice controls
- §8.9.4 Dashboard meeting widget
- §8.9.5 VoiceView server persistence

### Wave 5: Integration + Polish

- Wire all modules in `index.ts`
- End-to-end: record → transcribe → diarize → summarize → context file → thread injection
- Import end-to-end: upload Zoom transcript → parse → summarize → thread
- curl + browser verification
- Retention job verification

---

## File Structure

### Server

```
packages/server/src/
├── meetings/
│   ├── meetings.ts           # Meeting service
│   ├── meetings.test.ts
│   ├── routes.ts             # REST routes
│   ├── routes.test.ts
│   ├── ws.ts                 # WS channel
│   ├── ws.test.ts
│   ├── summarize.ts          # Summarization pipeline
│   ├── summarize.test.ts
│   ├── import.ts             # External meeting import
│   ├── import.test.ts
│   ├── parsers/              # Transcript format parsers
│   │   ├── index.ts
│   │   ├── plain-text.ts
│   │   ├── srt.ts
│   │   ├── vtt.ts
│   │   ├── otter.ts
│   │   ├── zoom.ts
│   │   └── parsers.test.ts
│   ├── speakers.ts           # Speaker label management
│   ├── speakers.test.ts
│   ├── retention.ts          # Retention policy job
│   └── retention.test.ts
├── recordings/
│   ├── recordings.ts         # Enhanced recording service
│   ├── recordings.test.ts
│   ├── routes.ts             # Enhanced routes
│   ├── routes.test.ts
│   ├── ws.ts                 # WS channel
│   ├── ws.test.ts
│   ├── transcription.ts      # TranscriptionProvider + queue
│   ├── transcription.test.ts
│   ├── search.ts             # Transcript search
│   └── search.test.ts
├── voice/
│   ├── voice.ts              # (unchanged)
│   ├── routes.ts             # (unchanged)
│   ├── provider.ts           # VoiceTranscriptionProvider adapter
│   ├── provider.test.ts
│   ├── post-processor.ts     # VoicePostProcessor interface + rule-based impl
│   ├── post-processor.test.ts
│   ├── acknowledgment.ts     # Rule-based ack generator (keyword extraction + reframing)
│   └── acknowledgment.test.ts
```

### Client

```
packages/client/src/features/
├── meetings/                  # New feature module
│   ├── MeetingsPanel.tsx      # Workspace sidebar tab
│   ├── MeetingsPanel.test.ts
│   ├── MeetingDetail.tsx      # Main content tab
│   ├── MeetingDetail.test.ts
│   ├── MeetingCard.tsx        # List item component
│   ├── MeetingCard.test.ts
│   ├── TranscriptView.tsx     # Timestamped, diarized transcript
│   ├── TranscriptView.test.ts
│   ├── ActionItems.tsx        # Checklist component
│   ├── ActionItems.test.ts
│   ├── SpeakerTimeline.tsx    # Audio waveform with speaker colors
│   ├── SpeakerTimeline.test.ts
│   ├── ImportDialog.tsx       # External meeting import
│   ├── ImportDialog.test.ts
│   ├── store.ts
│   └── store.test.ts
├── voice/
│   ├── VoiceView.tsx          # Updated: server persistence
│   ├── RecordingView.tsx      # Rewritten: server-backed
│   └── ThreadVoice.tsx        # New: thread voice controls (mic, TTS, voice mode)
│   └── ThreadVoice.test.ts
├── dashboard/
│   └── MeetingWidget.tsx      # New: meeting summary widget
│   └── MeetingWidget.test.ts
├── chat/
│   └── VoiceMessage.tsx       # New: voice-originated message with audio player
│   └── VoiceMessage.test.ts
```

---

## Dependencies

- Phase 1: Event bus, scheduler (retention job), notifications
- Phase 3: WebSocket protocol, config module
- Phase 6: Voice module (STT/TTS proxy), chat module (thread injection, agent backend for summarization), threads
- Phase 7: Logger factory, system module registration

No new npm dependencies required.

---

## Negative Constraints

- Audio files MUST NOT be stored in a database — disk only.
- Transcription and summarization MUST NOT block request handlers.
- The client MUST NOT perform audio format conversion.
- Transcript search MUST NOT require an external search engine.
- Meeting/recording modules MUST NOT import from chat, threads, or voice directly — bus only.
- Audio MUST NOT be transported via WebSocket — WS carries metadata, HTTP serves audio.
- Summarization MUST use the existing agent backend — MUST NOT call LLM APIs directly.
- Speaker label assignment MUST NOT re-trigger transcription — it's a metadata-only update.
- External meeting import MUST NOT assume any specific external platform — parsers are format-based, not platform-based.
