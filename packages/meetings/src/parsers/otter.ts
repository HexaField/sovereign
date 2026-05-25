// Otter.ai JSON transcript parser — §8.6.3

import type { ParsedTranscript } from './index.js'

interface OtterTranscript {
  speakers?: string[]
  transcript?: Array<{
    speaker?: string | number
    text: string
    start?: number
    end?: number
  }>
}

export function parseOtter(content: string): ParsedTranscript {
  const data: OtterTranscript = JSON.parse(content)
  const speakerNames = data.speakers ?? []
  const entries = data.transcript ?? []
  const speakerSet = new Map<string, { segments: number[]; totalDurationMs: number }>()

  const segments = entries.map((entry, idx) => {
    const speakerIdx = typeof entry.speaker === 'number' ? entry.speaker : undefined
    const speaker =
      speakerIdx !== undefined
        ? (speakerNames[speakerIdx] ?? `Speaker ${speakerIdx}`)
        : typeof entry.speaker === 'string'
          ? entry.speaker
          : undefined
    const start = entry.start ?? 0
    const end = entry.end ?? 0

    if (speaker) {
      if (!speakerSet.has(speaker)) {
        speakerSet.set(speaker, { segments: [], totalDurationMs: 0 })
      }
      const s = speakerSet.get(speaker)!
      s.segments.push(idx)
      s.totalDurationMs += (end - start) * 1000
    }

    return { start, end, text: entry.text, speaker }
  })

  const speakers: Record<string, unknown> = {}
  for (const [label, data] of speakerSet) {
    speakers[label] = { label, ...data }
  }

  return {
    text: segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n'),
    segments,
    speakers
  }
}
