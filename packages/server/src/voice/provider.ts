// Voice transcription provider adapter — §8.1.2

import type { VoiceModule } from './voice.js'
import type { TranscriptionProvider, TranscriptionResult } from '../recordings/transcription.js'

export function createVoiceTranscriptionProvider(voiceModule: VoiceModule): TranscriptionProvider {
  return {
    name: 'voice-module',
    capabilities: {
      diarization: false,
      timestamps: false,
      languages: ['en']
    },
    available(): boolean {
      const s = voiceModule.status()
      return s.status === 'ok' || s.status === 'degraded'
    },
    async transcribe(
      audioBuffer: Buffer,
      mimeType: string,
      options?: { language?: string; diarize?: boolean; signal?: AbortSignal }
    ): Promise<TranscriptionResult> {
      const result = await voiceModule.transcribe(audioBuffer, mimeType, {
        signal: options?.signal
      })
      return {
        text: result.text,
        segments: [{ start: 0, end: result.durationMs, text: result.text }],
        durationMs: result.durationMs
      }
    }
  }
}
