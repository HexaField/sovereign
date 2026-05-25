// SRT transcript parser — §8.6.3

import type { ParsedTranscript } from './index.js'

interface SrtSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

function parseTimestamp(ts: string): number {
  const [h, m, rest] = ts.split(':')
  const [s, ms] = rest.split(',')
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000
}

export function parseSrt(content: string): ParsedTranscript {
  const blocks = content.trim().split(/\n\n+/)
  const segments: SrtSegment[] = []
  const speakerSet = new Map<string, { segments: number[]; totalDurationMs: number }>()

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue

    // Line 0: sequence number, Line 1: timestamps, Line 2+: text
    const timeLine = lines[1]
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/)
    if (!timeMatch) continue

    const start = parseTimestamp(timeMatch[1])
    const end = parseTimestamp(timeMatch[2])
    const rawText = lines.slice(2).join(' ').trim()

    // Extract speaker label: [Speaker Name]: text
    const speakerMatch = rawText.match(/^\[([^\]]+)\]:\s*(.*)$/)
    const speaker = speakerMatch ? speakerMatch[1] : undefined
    const text = speakerMatch ? speakerMatch[2] : rawText

    const idx = segments.length
    segments.push({ start, end, text, speaker })

    if (speaker) {
      if (!speakerSet.has(speaker)) {
        speakerSet.set(speaker, { segments: [], totalDurationMs: 0 })
      }
      const s = speakerSet.get(speaker)!
      s.segments.push(idx)
      s.totalDurationMs += (end - start) * 1000
    }
  }

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
