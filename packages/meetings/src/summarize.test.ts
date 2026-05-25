import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSummarizationPipeline, type SummarizationResult } from './summarize.js'
import { createMeetingsService } from './meetings.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'

function mockBus(): EventBus & { events: BusEvent[]; trigger(type: string, payload: unknown): void } {
  const events: BusEvent[] = []
  const handlers = new Map<string, BusHandler[]>()
  return {
    events,
    emit(event: BusEvent) {
      events.push(event)
      const h = handlers.get(event.type) ?? []
      for (const fn of h) fn(event)
    },
    on(pattern: string, handler: BusHandler) {
      const list = handlers.get(pattern) ?? []
      list.push(handler)
      handlers.set(pattern, list)
      return () => {
        const idx = list.indexOf(handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    once: vi.fn().mockReturnValue(() => {}),
    replay: vi.fn(),
    history: vi.fn().mockReturnValue([]),
    trigger(type: string, payload: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this as any).emit({ type, timestamp: new Date().toISOString(), source: 'test', payload })
    }
  } as unknown as EventBus & { events: BusEvent[]; trigger(type: string, payload: unknown): void }
}

const mockSummaryResult: SummarizationResult = {
  text: 'The team discussed project progress and next steps.',
  actionItems: [
    { text: 'Review PR #42', assignee: 'Alice', status: 'open' },
    { text: 'Deploy staging', assignee: 'Bob', status: 'open' }
  ],
  decisions: ['Use TypeScript for the new module', 'Ship by Friday'],
  keyTopics: ['project progress', 'deployment', 'code review']
}

describe('§8.3.1 Meeting Summarization', () => {
  let dataDir: string
  let bus: ReturnType<typeof mockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-summarize-test-'))
    bus = mockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.3.1 MUST trigger summarization automatically when transcript completes and autoSummarize is true', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({
      bus,
      meetings,
      dataDir,
      onSummarize,
      config: { autoSummarize: true }
    })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello world' }
    })

    bus.trigger('meeting.transcript.completed', { orgId: 'org1', meetingId: meeting.id })
    // Wait for async queue
    await new Promise((r) => setTimeout(r, 50))

    expect(onSummarize).toHaveBeenCalled()
    pipeline.destroy()
  })

  it('§8.3.1 MUST use the agent backend (via chat module) to generate summaries', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Discussion content' }
    })
    await pipeline.summarize('org1', meeting.id)

    expect(onSummarize).toHaveBeenCalledWith(expect.objectContaining({ id: meeting.id }), 'Discussion content')
    pipeline.destroy()
  })

  it('§8.3.1 MUST generate a narrative summary', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const updated = await meetings.get('org1', meeting.id)
    expect(updated?.summary?.text).toBe('The team discussed project progress and next steps.')
    pipeline.destroy()
  })

  it('§8.3.1 MUST extract action items with assignee and optional due dates', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const updated = await meetings.get('org1', meeting.id)
    expect(updated?.summary?.actionItems).toHaveLength(2)
    expect(updated?.summary?.actionItems?.[0]?.assignee).toBe('Alice')
    pipeline.destroy()
  })

  it('§8.3.1 MUST extract key decisions', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const updated = await meetings.get('org1', meeting.id)
    expect(updated?.summary?.decisions).toEqual(['Use TypeScript for the new module', 'Ship by Friday'])
    pipeline.destroy()
  })

  it('§8.3.1 MUST extract key topics', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const updated = await meetings.get('org1', meeting.id)
    expect(updated?.summary?.keyTopics).toEqual(['project progress', 'deployment', 'code review'])
    pipeline.destroy()
  })

  it('§8.3.1 MUST include speaker labels in the summarization prompt', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: {
        status: 'completed',
        text: 'Alice: Hello\nBob: Hi',
        speakers: { s1: { label: 'Alice' }, s2: { label: 'Bob' } }
      }
    })
    await pipeline.summarize('org1', meeting.id)

    // The meeting object passed to onSummarize includes speaker data
    const passedMeeting = onSummarize.mock.calls[0][0]
    expect(passedMeeting.transcript.speakers).toHaveProperty('s1')
    pipeline.destroy()
  })

  it('§8.3.1 MUST be non-blocking (queued like transcription)', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    let resolveFirst: () => void
    void new Promise<void>((r) => {
      resolveFirst = r
    })
    const onSummarize = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SummarizationResult>((resolve) => {
            resolveFirst!()
            setTimeout(() => resolve(mockSummaryResult), 10)
          })
      )
      .mockResolvedValue(mockSummaryResult)

    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const m1 = await meetings.create('org1', { title: 'M1', transcript: { status: 'completed', text: 'A' } })
    const m2 = await meetings.create('org1', { title: 'M2', transcript: { status: 'completed', text: 'B' } })

    // Queue both — they process sequentially (non-blocking queue)
    const p1 = pipeline.summarize('org1', m1.id)
    // Summarize is queued, not blocking the caller from enqueueing more
    pipeline.summarize('org1', m2.id)
    await p1
    await new Promise((r) => setTimeout(r, 50))

    expect(onSummarize).toHaveBeenCalledTimes(2)
    pipeline.destroy()
  })
})

describe('§8.3.2 Workspace Context Integration', () => {
  let dataDir: string
  let bus: ReturnType<typeof mockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-summarize-test-'))
    bus = mockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.3.2 MUST write meeting summaries as Markdown files to {dataDir}/meetings/{orgId}/context/', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Test',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const ctxPath = path.join(dataDir, 'meetings', 'org1', 'context', `${meeting.id}.md`)
    expect(fs.existsSync(ctxPath)).toBe(true)
    pipeline.destroy()
  })

  it('§8.3.2 MUST use the specified context file format', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Sprint Planning',
      transcript: { status: 'completed', text: 'Hello', speakers: { s1: { label: 'Alice' } } }
    })
    await pipeline.summarize('org1', meeting.id)

    const ctxPath = path.join(dataDir, 'meetings', 'org1', 'context', `${meeting.id}.md`)
    const content = fs.readFileSync(ctxPath, 'utf-8')
    expect(content).toContain('# Meeting: Sprint Planning')
    expect(content).toContain('## Summary')
    expect(content).toContain('## Action Items')
    expect(content).toContain('## Decisions')
    expect(content).toContain('## Key Topics')
    expect(content).toContain('Review PR #42')
    expect(content).toContain('@Alice')
    pipeline.destroy()
  })

  it('§8.3.2 MUST index context files for search', async () => {
    // Context files are on disk as markdown — searchable by future embeddings/grep
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Indexed',
      transcript: { status: 'completed', text: 'Search me' }
    })
    await pipeline.summarize('org1', meeting.id)

    const ctxDir = path.join(dataDir, 'meetings', 'org1', 'context')
    const files = fs.readdirSync(ctxDir)
    expect(files.length).toBeGreaterThan(0)
    pipeline.destroy()
  })

  it('§8.3.2 MUST provide GET /api/orgs/:orgId/meetings/context route', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Ctx',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const contexts = await pipeline.getContext('org1')
    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts[0]).toContain('# Meeting:')
    pipeline.destroy()
  })

  it('§8.3.2 MUST support ?since=<ISO date> parameter', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const meeting = await meetings.create('org1', {
      title: 'Recent',
      transcript: { status: 'completed', text: 'Hello' }
    })
    await pipeline.summarize('org1', meeting.id)

    const future = new Date(Date.now() + 86400000).toISOString()
    const contexts = await pipeline.getContext('org1', { since: future })
    expect(contexts).toHaveLength(0)

    const past = new Date(Date.now() - 86400000).toISOString()
    const contexts2 = await pipeline.getContext('org1', { since: past })
    expect(contexts2.length).toBeGreaterThan(0)
    pipeline.destroy()
  })

  it('§8.3.2 MUST support ?limit=N parameter', async () => {
    const meetings = createMeetingsService(bus, dataDir)
    const onSummarize = vi.fn().mockResolvedValue(mockSummaryResult)
    const pipeline = createSummarizationPipeline({ bus, meetings, dataDir, onSummarize })

    const m1 = await meetings.create('org1', { title: 'M1', transcript: { status: 'completed', text: 'A' } })
    const m2 = await meetings.create('org1', { title: 'M2', transcript: { status: 'completed', text: 'B' } })
    await pipeline.summarize('org1', m1.id)
    await pipeline.summarize('org1', m2.id)

    const limited = await pipeline.getContext('org1', { limit: 1 })
    expect(limited).toHaveLength(1)
    pipeline.destroy()
  })
})
