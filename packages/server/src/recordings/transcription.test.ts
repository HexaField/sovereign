import { describe, it } from 'vitest'

describe('§8.1.1 TranscriptionProvider Interface', () => {
  it.todo('§8.1.1 MUST support pluggable providers via TranscriptionProvider interface')
  it.todo('§8.1.1 MUST adapt the existing voice module STT proxy as initial provider')
  it.todo('§8.1.1 MUST request diarization when the provider supports it')
  it.todo('§8.1.1 MUST produce transcript without speaker labels if provider does not support diarization')
})

describe('§8.1.3 Transcription Queue', () => {
  it.todo('§8.1.3 MUST be non-blocking — requests return immediately, processing in background')
  it.todo('§8.1.3 MUST enforce config.recordings.transcription.maxConcurrent (default: 2)')
  it.todo('§8.1.3 MUST be FIFO with priority override for user-initiated over auto-transcriptions')
  it.todo('§8.1.3 MUST be queryable: pending count, active count, estimated wait')
})

describe('§8.4.1 Extended Recording Metadata', () => {
  it.todo('§8.4.1 MUST link RecordingMeta to parent meetingId when part of a meeting')
  it.todo('§8.4.1 MUST accept bus and provider in createRecordingsService signature')
  it.todo('§8.4.1 MUST emit recording.created bus event')
  it.todo('§8.4.1 MUST emit recording.deleted bus event')
})

describe('§8.4.2 Auto-Transcription & Meeting Creation', () => {
  it.todo('§8.4.2 MUST start transcription automatically after recording creation when autoTranscribe is true')
  it.todo('§8.4.2 MUST auto-create meeting when recording has threadKey but no meetingId')
  it.todo('§8.4.2 MUST react to config.changed bus event for immediate config updates')
})

describe('§8.4.3 Audio Streaming', () => {
  it.todo('§8.4.3 MUST support HTTP Range requests (206 Partial Content) for seeking')
  it.todo('§8.4.3 MUST set Accept-Ranges: bytes header')
  it.todo('§8.4.3 MUST set accurate Content-Length header')
})

describe('§8.4.4 File Size Validation', () => {
  it.todo('§8.4.4 MUST reject audio exceeding config.recordings.maxSizeBytes with 413')
})
