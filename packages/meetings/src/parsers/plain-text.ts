// Plain text transcript parser — §8.6.3

import type { ParsedTranscript } from './index.js'

export function parsePlainText(content: string): ParsedTranscript {
  const text = content.trim()
  return {
    text,
    segments: [{ start: 0, end: 0, text, speaker: undefined }],
    speakers: {}
  }
}
