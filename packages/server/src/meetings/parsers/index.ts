// Transcript format parsers — §8.6.3

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

export function getParser(_format: string): TranscriptParser | null {
  throw new Error('Not implemented')
}

export function listParsers(): TranscriptParser[] {
  throw new Error('Not implemented')
}
