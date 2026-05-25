// Transcript format parsers — §8.6.3

import { parsePlainText } from './plain-text.js'
import { parseSrt } from './srt.js'
import { parseVtt } from './vtt.js'
import { parseOtter } from './otter.js'
import { parseZoom } from './zoom.js'

export interface ParsedTranscript {
  text: string
  segments: unknown[]
  speakers?: Record<string, unknown>
}

export interface TranscriptParser {
  name: string
  extensions: string[]
  parse(content: string | Buffer): ParsedTranscript
}

const parsers: TranscriptParser[] = [
  {
    name: 'plain-text',
    extensions: ['.txt'],
    parse: (content) => parsePlainText(typeof content === 'string' ? content : content.toString('utf-8'))
  },
  {
    name: 'srt',
    extensions: ['.srt'],
    parse: (content) => parseSrt(typeof content === 'string' ? content : content.toString('utf-8'))
  },
  {
    name: 'vtt',
    extensions: ['.vtt'],
    parse: (content) => parseVtt(typeof content === 'string' ? content : content.toString('utf-8'))
  },
  {
    name: 'otter',
    extensions: ['.json'],
    parse: (content) => {
      const str = typeof content === 'string' ? content : content.toString('utf-8')
      // Detect Otter.ai format
      try {
        const data = JSON.parse(str)
        if (data.transcript && Array.isArray(data.transcript)) {
          return parseOtter(str)
        }
      } catch {
        /* not JSON */
      }
      throw new Error('Not a valid Otter.ai JSON transcript')
    }
  },
  {
    name: 'zoom',
    extensions: ['.vtt'],
    parse: (content) => parseZoom(typeof content === 'string' ? content : content.toString('utf-8'))
  }
]

export function getParser(format: string): TranscriptParser | null {
  // Try by name first
  const byName = parsers.find((p) => p.name === format)
  if (byName) return byName

  // Try by extension
  const ext = format.startsWith('.') ? format : `.${format}`
  return parsers.find((p) => p.extensions.includes(ext)) ?? null
}

export function getParserForFile(filename: string): TranscriptParser | null {
  const ext = '.' + filename.split('.').pop()?.toLowerCase()

  // For JSON, check if it's a known structured format
  if (ext === '.json') return parsers.find((p) => p.name === 'otter') ?? null

  return parsers.find((p) => p.extensions.includes(ext)) ?? null
}

export function listParsers(): TranscriptParser[] {
  return [...parsers]
}

export function supportedFormats(): string[] {
  return [...new Set(parsers.flatMap((p) => p.extensions))]
}

export { parsePlainText } from './plain-text.js'
export { parseSrt } from './srt.js'
export { parseVtt } from './vtt.js'
export { parseOtter } from './otter.js'
export { parseZoom } from './zoom.js'
