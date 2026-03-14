import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTranscriptSearch } from './search.js'
import type { RecordingsService, RecordingMeta } from './recordings.js'

function mockRecording(overrides: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id: 'rec-1',
    orgId: 'org-1',
    name: 'Test Recording',
    duration: 120,
    sizeBytes: 1024,
    mimeType: 'audio/webm',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    transcriptStatus: 'completed',
    ...overrides
  }
}

describe('§8.8 Transcript Search', () => {
  let recordings: RecordingsService

  beforeEach(() => {
    recordings = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      getAudioPath: vi.fn(),
      getTranscript: vi.fn(),
      transcribe: vi.fn()
    } as unknown as RecordingsService
  })

  it('§8.8 GET /api/orgs/:orgId/recordings/search MUST search transcripts', async () => {
    const rec = mockRecording()
    vi.mocked(recordings.list).mockResolvedValue([rec])
    vi.mocked(recordings.getTranscript).mockResolvedValue(
      'We discussed the deployment pipeline and how to fix the build errors in production.'
    )

    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', 'deployment pipeline')

    expect(results).toHaveLength(1)
    expect(results[0].recording.id).toBe('rec-1')
    expect(results[0].matches.length).toBeGreaterThan(0)
    expect(results[0].matches[0].snippet).toContain('deployment pipeline')
  })

  it('§8.8 Transcript search MUST NOT require an external search engine', async () => {
    // createTranscriptSearch only needs RecordingsService — no external engine
    const search = createTranscriptSearch(recordings)
    expect(search).toBeDefined()
    expect(typeof search.search).toBe('function')
  })

  it('skips recordings without completed transcripts', async () => {
    const pending = mockRecording({ id: 'rec-pending', transcriptStatus: 'pending' })
    const completed = mockRecording({ id: 'rec-done', transcriptStatus: 'completed' })
    vi.mocked(recordings.list).mockResolvedValue([pending, completed])
    vi.mocked(recordings.getTranscript).mockResolvedValue('meeting notes about search')

    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', 'search')

    expect(results).toHaveLength(1)
    expect(results[0].recording.id).toBe('rec-done')
  })

  it('returns empty results for empty query', async () => {
    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', '')
    expect(results).toEqual([])
    expect(recordings.list).not.toHaveBeenCalled()
  })

  it('returns empty results when no transcripts match', async () => {
    vi.mocked(recordings.list).mockResolvedValue([mockRecording()])
    vi.mocked(recordings.getTranscript).mockResolvedValue('nothing relevant here')

    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', 'xyznonexistent')
    expect(results).toEqual([])
  })

  it('respects limit option', async () => {
    const recs = Array.from({ length: 5 }, (_, i) => mockRecording({ id: `rec-${i}`, transcriptStatus: 'completed' }))
    vi.mocked(recordings.list).mockResolvedValue(recs)
    vi.mocked(recordings.getTranscript).mockResolvedValue('matching text here')

    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', 'matching', { limit: 2 })
    expect(results).toHaveLength(2)
  })

  it('provides context snippets around matches', async () => {
    const longText = 'A'.repeat(100) + ' deployment pipeline ' + 'B'.repeat(100)
    vi.mocked(recordings.list).mockResolvedValue([mockRecording()])
    vi.mocked(recordings.getTranscript).mockResolvedValue(longText)

    const search = createTranscriptSearch(recordings)
    const results = await search.search('org-1', 'deployment pipeline')

    expect(results[0].matches[0].snippet).toContain('deployment pipeline')
    expect(results[0].matches[0].snippet).toContain('...')
  })
})
