import { describe, it } from 'vitest'

describe('§8.6.1 Import Formats', () => {
  it.todo('§8.6.1 MUST support audio file import (.mp3, .wav, .m4a, .ogg, .webm)')
  it.todo('§8.6.1 MUST support transcript file import (.txt, .srt, .vtt)')
  it.todo('§8.6.1 MUST support structured transcript import (.json — Otter.ai, Zoom)')
})

describe('§8.6.2 Import API', () => {
  it.todo('§8.6.2 MUST accept multipart upload at POST /api/orgs/:orgId/meetings/import')
  it.todo('§8.6.2 MUST require title field')
  it.todo('§8.6.2 MUST require at least one of audio or transcript file')
  it.todo('§8.6.2 MUST create meeting with source: import and importMeta')
  it.todo('§8.6.2 MUST store audio as recording and trigger transcription pipeline if audio provided')
  it.todo('§8.6.2 MUST parse format and store as meeting transcript if transcript provided')
  it.todo('§8.6.2 MUST use provided transcript and skip transcription if both audio and transcript provided')
  it.todo('§8.6.2 MUST trigger summarization when transcript is available')
})

describe('§8.6.4 Thread Routing for Imports', () => {
  it.todo('§8.6.4 MUST bind imported meeting to thread when threadKey is provided')
  it.todo('§8.6.4 MUST inject meeting summary into thread as system message')
  it.todo('§8.6.4 SHOULD create workspace-level meeting when no threadKey provided')
})
