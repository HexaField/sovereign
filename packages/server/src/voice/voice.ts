// Voice Module — Transcription + TTS proxy

import type { EventBus } from '@sovereign/core'
import type { VoiceConfig } from '../agent-backend/types.js'

export interface VoiceModuleConfig extends VoiceConfig {
  timeoutMs?: number
}

export interface VoiceModule {
  status(): { module: string; status: string }
  transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ text: string; durationMs: number }>
  synthesize(
    text: string,
    voice?: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ audio: Buffer; durationMs: number }>
  updateConfig(config: Partial<VoiceModuleConfig>): void
}

const DEFAULT_TIMEOUT_MS = 30000

export function createVoiceModule(bus: EventBus, config: VoiceModuleConfig): VoiceModule {
  let currentConfig = { ...config }

  function getTimeoutMs(): number {
    return currentConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  function createFetchSignal(externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error('Request timeout')), getTimeoutMs())

    function onExternalAbort() {
      controller.abort(externalSignal!.reason ?? new Error('Aborted'))
    }

    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId)
        controller.abort(externalSignal.reason ?? new Error('Aborted'))
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }
    }

    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timeoutId)
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort)
        }
      }
    }
  }

  function wrapFetchError(operation: string, err: unknown): Error {
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.message === 'Request timeout') {
        return new Error(`${operation} timed out after ${getTimeoutMs()}ms`)
      }
      if (err.message === 'Aborted' || err.message?.includes('aborted')) {
        return new Error(`${operation} was aborted`)
      }
      return new Error(`${operation} failed: ${err.message}`)
    }
    return new Error(`${operation} failed: ${String(err)}`)
  }

  return {
    status() {
      const hasTranscribe = !!currentConfig.transcribeUrl
      const hasTts = !!currentConfig.ttsUrl
      return {
        module: 'voice',
        status: hasTranscribe && hasTts ? 'ok' : hasTranscribe || hasTts ? 'degraded' : 'error'
      }
    },

    async transcribe(
      audioBuffer: Buffer,
      mimeType: string,
      options?: { signal?: AbortSignal }
    ): Promise<{ text: string; durationMs: number }> {
      if (!currentConfig.transcribeUrl) {
        throw new Error('No transcription URL configured')
      }

      const start = Date.now()
      const { signal, cleanup } = createFetchSignal(options?.signal)

      try {
        const formData = new FormData()
        formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), 'audio.wav')

        const response = await fetch(currentConfig.transcribeUrl, {
          method: 'POST',
          body: formData,
          signal
        })

        if (!response.ok) {
          throw new Error(`Transcription failed: ${response.status} ${response.statusText}`)
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
      } catch (err) {
        throw wrapFetchError('Transcription', err)
      } finally {
        cleanup()
      }
    },

    async synthesize(
      text: string,
      voice?: string,
      options?: { signal?: AbortSignal }
    ): Promise<{ audio: Buffer; durationMs: number }> {
      if (!currentConfig.ttsUrl) {
        throw new Error('No TTS URL configured')
      }

      const start = Date.now()
      const { signal, cleanup } = createFetchSignal(options?.signal)

      try {
        const response = await fetch(currentConfig.ttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal
        })

        if (!response.ok) {
          throw new Error(`TTS failed: ${response.status} ${response.statusText}`)
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
      } catch (err) {
        throw wrapFetchError('TTS', err)
      } finally {
        cleanup()
      }
    },

    updateConfig(newConfig: Partial<VoiceModuleConfig>) {
      currentConfig = { ...currentConfig, ...newConfig }
    }
  }
}
