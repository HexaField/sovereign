// VTT transcript parser — §8.6.3

import type { ParsedTranscript } from './index.js'

interface VttSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 3) {
    const [h, m, rest] = parts
    const [s, ms] = rest.split('.')
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms || '0') / 1000
  }
  // mm:ss.ms
  const [m, rest] = parts
  const [s, ms] = rest.split('.')
  return parseInt(m) * 60 + parseInt(s) + parseInt(ms || '0') / 1000
}

export function parseVtt(content: string): ParsedTranscript {
  const lines = content.trim().split('\n')
  const segments: VttSegment[] = []
  const speakerSet = new Map<string, { segments: number[]; totalDurationMs: number }>()

  let i = 0
  // Skip WEBVTT header and any metadata
  while (i < lines.length && !lines[i].includes('-->')) i++

  while (i < lines.length) {
    const line = lines[i].trim()
    const timeMatch = line.match(/([\d:.]+)\s*-->\s*([\d:.]+)/)
    if (!timeMatch) {
      i++
      continue
    }

    const start = parseTimestamp(timeMatch[1])
    const end = parseTimestamp(timeMatch[2])
    i++

    const textLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
      textLines.push(lines[i].trim())
      i++
    }

    const rawText = textLines.join(' ')

    // Extract speaker: <v Speaker Name>text or [Speaker Name]: text
    let speaker: string | undefined
    let text: string
    const vMatch = rawText.match(/^<v\s+([^>]+)>(.*)$/)
    const bracketMatch = rawText.match(/^\[([^\]]+)\]:\s*(.*)$/)

    if (vMatch) {
      speaker = vMatch[1]
      text = vMatch[2].replace(/<\/v>/, '').trim()
    } else if (bracketMatch) {
      speaker = bracketMatch[1]
      text = bracketMatch[2]
    } else {
      text = rawText
    }

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
