// Transcript search — §8.3.3, §8.8

import type { RecordingsService, RecordingMeta } from './recordings.js'

export interface TranscriptSearchResult {
  recording: RecordingMeta
  matches: Array<{
    /** Character offset of match start in transcript */
    offset: number
    /** Surrounding context snippet */
    snippet: string
  }>
}

export interface TranscriptSearch {
  search(orgId: string, query: string, opts?: { limit?: number }): Promise<TranscriptSearchResult[]>
}

const SNIPPET_RADIUS = 80

function extractSnippets(transcript: string, query: string, limit: number): Array<{ offset: number; snippet: string }> {
  const lower = transcript.toLowerCase()
  const queryLower = query.toLowerCase()
  const results: Array<{ offset: number; snippet: string }> = []
  let pos = 0

  while (results.length < limit) {
    const idx = lower.indexOf(queryLower, pos)
    if (idx === -1) break
    const start = Math.max(0, idx - SNIPPET_RADIUS)
    const end = Math.min(transcript.length, idx + query.length + SNIPPET_RADIUS)
    const snippet =
      (start > 0 ? '...' : '') + transcript.slice(start, end).trim() + (end < transcript.length ? '...' : '')
    results.push({ offset: idx, snippet })
    pos = idx + query.length
  }

  return results
}

export function createTranscriptSearch(recordings: RecordingsService): TranscriptSearch {
  return {
    async search(orgId: string, query: string, opts?: { limit?: number }): Promise<TranscriptSearchResult[]> {
      if (!query.trim()) return []
      const limit = opts?.limit ?? 20
      const allRecordings = await recordings.list(orgId)
      const results: TranscriptSearchResult[] = []

      for (const rec of allRecordings) {
        if (rec.transcriptStatus !== 'completed') continue
        const transcript = await recordings.getTranscript(orgId, rec.id)
        if (!transcript) continue

        const matches = extractSnippets(transcript, query, 3)
        if (matches.length > 0) {
          results.push({ recording: rec, matches })
        }
        if (results.length >= limit) break
      }

      return results
    }
  }
}
