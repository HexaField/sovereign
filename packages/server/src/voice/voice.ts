// Voice Module — Transcription + TTS proxy

import type { EventBus } from '@template/core'
import type { VoiceConfig } from '../agent-backend/types.js'

export interface VoiceModule {
  status(): { module: string; status: string }
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<{ text: string; durationMs: number }>
  synthesize(text: string, voice?: string): Promise<{ audio: Buffer; durationMs: number }>
  updateConfig(config: Partial<VoiceConfig>): void
}

export function createVoiceModule(bus: EventBus, config: VoiceConfig): VoiceModule {
  let currentConfig = { ...config }

  return {
    status() {
      const hasTranscribe = !!currentConfig.transcribeUrl
      const hasTts = !!currentConfig.ttsUrl
      return {
        module: 'voice',
        status: hasTranscribe && hasTts ? 'ok' : hasTranscribe || hasTts ? 'degraded' : 'error'
      }
    },

    async transcribe(audioBuffer: Buffer, mimeType: string): Promise<{ text: string; durationMs: number }> {
      if (!currentConfig.transcribeUrl) {
        throw new Error('No transcription URL configured')
      }

      const start = Date.now()

      // Proxy to configured transcription service
      const formData = new FormData()
      formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), 'audio.wav')

      const response = await fetch(currentConfig.transcribeUrl, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status}`)
      }

      const result = (await response.json()) as { text: string }
      const durationMs = Date.now() - start

      bus.emit({
        type: 'voice.transcription.completed',
        timestamp: new Date().toISOString(),
        source: 'voice',
        payload: { text: result.text, durationMs }
      })

      return { text: result.text, durationMs }
    },

    async synthesize(text: string, voice?: string): Promise<{ audio: Buffer; durationMs: number }> {
      if (!currentConfig.ttsUrl) {
        throw new Error('No TTS URL configured')
      }

      const start = Date.now()

      const response = await fetch(currentConfig.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice })
      })

      if (!response.ok) {
        throw new Error(`TTS failed: ${response.status}`)
      }

      const arrayBuf = await response.arrayBuffer()
      const audio = Buffer.from(arrayBuf)
      const durationMs = Date.now() - start

      bus.emit({
        type: 'voice.tts.completed',
        timestamp: new Date().toISOString(),
        source: 'voice',
        payload: { text, durationMs }
      })

      return { audio, durationMs }
    },

    updateConfig(newConfig: Partial<VoiceConfig>) {
      currentConfig = { ...currentConfig, ...newConfig }
    }
  }
}
