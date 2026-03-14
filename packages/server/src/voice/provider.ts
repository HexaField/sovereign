// Voice transcription provider adapter — §8.1.2

import type { TranscriptionProvider } from '../recordings/transcription.js'

export function createVoiceTranscriptionProvider(_voiceModule: unknown): TranscriptionProvider {
  throw new Error('Not implemented')
}
