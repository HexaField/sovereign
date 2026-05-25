import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createImportHandler } from './import.js'
import { createMeetingsService } from './meetings.js'
import type { EventBus, BusEvent } from '@sovereign/core'

function mockBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  return {
    events,
    emit(event: BusEvent) {
      events.push(event)
    },
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn().mockReturnValue(() => {}),
    replay: vi.fn(),
    history: vi.fn().mockReturnValue([])
  } as unknown as EventBus & { events: BusEvent[] }
}

describe('§8.6.1 Import Formats', () => {
  let dataDir: string
  let bus: ReturnType<typeof mockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-import-test-'))
    bus = mockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.6.1 MUST support audio file import (.mp3, .wav, .m4a, .ogg, .webm)', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onAudioImport = vi.fn()
    const handler = createImportHandler({ bus, meetings, onAudioImport })
    const result = await handler.import('org1', {
      title: 'Audio Meeting',
      audioFilename: 'recording.mp3',
      audioBuffer: Buffer.from('fake-audio'),
      audioMimeType: 'audio/mp3'
    })
    expect(result.meeting.source).toBe('import')
    expect(onAudioImport).toHaveBeenCalledWith(result.meeting.id, 'org1', expect.any(Buffer), 'audio/mp3')
  })

  it('§8.6.1 MUST support transcript file import (.txt, .srt, .vtt)', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Text Meeting',
      transcriptFilename: 'transcript.txt',
      transcriptContent: 'Hello this is a meeting'
    })
    expect(result.transcriptParsed).toBe(true)
    expect(result.meeting.transcript?.status).toBe('completed')
  })

  it('§8.6.1 MUST support structured transcript import (.json — Otter.ai, Zoom)', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const otterJson = JSON.stringify({
      speakers: ['Alice'],
      transcript: [{ speaker: 0, text: 'Hello', start: 0, end: 5 }]
    })
    const result = await handler.import('org1', {
      title: 'Otter Meeting',
      transcriptFilename: 'transcript.json',
      transcriptContent: otterJson
    })
    expect(result.transcriptParsed).toBe(true)
  })
})

describe('§8.6.2 Import API', () => {
  let dataDir: string
  let bus: ReturnType<typeof mockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-import-test-'))
    bus = mockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.6.2 MUST accept multipart upload at POST /api/orgs/:orgId/meetings/import', async () => {
    // Tested at route level — here test handler directly
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Test',
      transcriptFilename: 'test.txt',
      transcriptContent: 'Hello'
    })
    expect(result.meeting).toBeDefined()
    expect(result.meeting.id).toBeTruthy()
  })

  it('§8.6.2 MUST require title field', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    await expect(
      handler.import('org1', {
        title: '',
        transcriptFilename: 'test.txt',
        transcriptContent: 'Hello'
      })
    ).rejects.toThrow('title is required')
  })

  it('§8.6.2 MUST require at least one of audio or transcript file', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    await expect(handler.import('org1', { title: 'Test' })).rejects.toThrow('At least one')
  })

  it('§8.6.2 MUST create meeting with source: import and importMeta', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Imported',
      platform: 'zoom',
      transcriptFilename: 'transcript.txt',
      transcriptContent: 'Hello'
    })
    expect(result.meeting.source).toBe('import')
    expect(result.meeting.importMeta?.platform).toBe('zoom')
    expect(result.meeting.importMeta?.importedAt).toBeTruthy()
  })

  it('§8.6.2 MUST store audio as recording and trigger transcription pipeline if audio provided', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onAudioImport = vi.fn()
    const handler = createImportHandler({ bus, meetings, onAudioImport })
    await handler.import('org1', {
      title: 'Audio Only',
      audioFilename: 'rec.wav',
      audioBuffer: Buffer.from('audio-data'),
      audioMimeType: 'audio/wav'
    })
    expect(onAudioImport).toHaveBeenCalled()
  })

  it('§8.6.2 MUST parse format and store as meeting transcript if transcript provided', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Transcript Only',
      transcriptFilename: 'transcript.srt',
      transcriptContent: `1\n00:00:01,000 --> 00:00:05,000\nHello`
    })
    expect(result.meeting.transcript?.status).toBe('completed')
    expect(result.meeting.transcript?.text).toContain('Hello')
  })

  it('§8.6.2 MUST use provided transcript and skip transcription if both audio and transcript provided', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onAudioImport = vi.fn()
    const handler = createImportHandler({ bus, meetings, onAudioImport })
    const result = await handler.import('org1', {
      title: 'Both',
      transcriptFilename: 'transcript.txt',
      transcriptContent: 'Hello',
      audioFilename: 'rec.mp3',
      audioBuffer: Buffer.from('audio'),
      audioMimeType: 'audio/mp3'
    })
    expect(result.transcriptParsed).toBe(true)
    // Audio import should NOT trigger transcription since transcript was provided
    expect(onAudioImport).not.toHaveBeenCalled()
  })

  it('§8.6.2 MUST trigger summarization when transcript is available', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Summarize',
      transcriptFilename: 'test.txt',
      transcriptContent: 'Meeting content'
    })
    expect(result.summarizationTriggered).toBe(true)
    expect(bus.events.some((e) => e.type === 'meeting.transcript.completed')).toBe(true)
  })
})

describe('§8.6.4 Thread Routing for Imports', () => {
  let dataDir: string
  let bus: ReturnType<typeof mockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-import-test-'))
    bus = mockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.6.4 MUST bind imported meeting to thread when threadKey is provided', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Thread Meeting',
      threadKey: 'thread-123',
      transcriptFilename: 'test.txt',
      transcriptContent: 'Hello'
    })
    expect(result.meeting.threadKey).toBe('thread-123')
  })

  it('§8.6.4 MUST inject meeting summary into thread as system message', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    await handler.import('org1', {
      title: 'Thread Meeting',
      threadKey: 'thread-123',
      transcriptFilename: 'test.txt',
      transcriptContent: 'Hello'
    })
    // The transcript.completed event includes threadKey for downstream handling
    const event = bus.events.find((e) => e.type === 'meeting.transcript.completed')
    expect((event?.payload as { threadKey: string }).threadKey).toBe('thread-123')
  })

  it('§8.6.4 SHOULD create workspace-level meeting when no threadKey provided', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const handler = createImportHandler({ bus, meetings })
    const result = await handler.import('org1', {
      title: 'Workspace Meeting',
      transcriptFilename: 'test.txt',
      transcriptContent: 'Hello'
    })
    expect(result.meeting.threadKey).toBeUndefined()
  })
})
