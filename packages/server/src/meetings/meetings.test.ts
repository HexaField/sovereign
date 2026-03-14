import { describe, it } from 'vitest'

describe('§8.2.1 Meeting Entity', () => {
  it.todo('§8.2.1 MUST be the primary container for recordings, transcripts, and summaries')
  it.todo('§8.2.1 MAY contain multiple recordings (multi-segment meetings, pause/resume)')
  it.todo('§8.2.1 MUST persist as JSON files in {dataDir}/meetings/{orgId}/{id}.json')
  it.todo('§8.2.1 MUST keep audio files in {dataDir}/recordings/{orgId}/')
})

describe('§8.2.2 Meeting Lifecycle Events', () => {
  it.todo('§8.2.2 MUST emit meeting.created on meeting creation')
  it.todo('§8.2.2 MUST emit meeting.updated on metadata change')
  it.todo('§8.2.2 MUST emit meeting.deleted on meeting removal')
  it.todo('§8.2.2 MUST emit meeting.transcript.started when transcription begins')
  it.todo('§8.2.2 MUST emit meeting.transcript.completed when transcript is ready')
  it.todo('§8.2.2 MUST emit meeting.transcript.failed on transcription failure')
  it.todo('§8.2.2 MUST emit meeting.summary.started when summarization begins')
  it.todo('§8.2.2 MUST emit meeting.summary.completed when summary is ready')
  it.todo('§8.2.2 MUST emit meeting.summary.failed on summarization failure')
})

describe('§8.3.3 Meeting History', () => {
  it.todo('§8.3.3 MUST return paginated meeting history sorted by date (newest first)')
  it.todo('§8.3.3 MUST support filter ?threadKey=')
  it.todo('§8.3.3 MUST support filter ?since=')
  it.todo('§8.3.3 MUST support filter ?until=')
  it.todo('§8.3.3 MUST support filter ?source=native|import')
  it.todo('§8.3.3 MUST support filter ?search=<query>')
  it.todo('§8.3.3 MUST search meeting titles, summaries, and transcript text')
  it.todo(
    '§8.3.3 MUST include id, title, date, duration, speakers count, transcript status, summary status, thread key in each meeting'
  )
})
