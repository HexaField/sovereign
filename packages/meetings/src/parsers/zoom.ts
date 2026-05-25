// Zoom transcript parser — §8.6.3
// Zoom exports transcript.vtt — a WebVTT file with speaker labels in the text

import type { ParsedTranscript } from './index.js'
import { parseVtt } from './vtt.js'

export function parseZoom(content: string): ParsedTranscript {
  // Zoom VTT format uses "Speaker Name: text" pattern on each cue line
  // Pre-process to convert to <v Speaker> format for the VTT parser
  const lines = content.split('\n')
  const processed = lines.map((line) => {
    const trimmed = line.trim()
    // Skip timestamp lines, empty lines, WEBVTT header
    if (!trimmed || trimmed === 'WEBVTT' || trimmed.includes('-->') || /^\d+$/.test(trimmed)) {
      return line
    }
    // Zoom format: "Speaker Name: text"
    const match = trimmed.match(/^([^:]+):\s+(.+)$/)
    if (match && !trimmed.startsWith('<v') && !trimmed.startsWith('[')) {
      return `<v ${match[1]}>${match[2]}`
    }
    return line
  })

  return parseVtt(processed.join('\n'))
}
