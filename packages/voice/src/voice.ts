// Voice Module — Transcription + TTS proxy

import type { EventBus } from '@sovereign/core'

export interface VoiceModuleConfig {
  transcribeUrl?: string
  ttsUrl?: string
  timeoutMs?: number
}

/** A single audio chunk from the streaming TTS endpoint. */
export interface TtsChunk {
  index: number
  total: number
  sentence: string
  audio: Buffer
  durationMs: number
  rtf: number
  done: boolean
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
  /** Stream TTS as sentence-level audio chunks. Each chunk carries WAV
   *  audio for one sentence. The caller receives first audio after a
   *  single sentence synthesizes, not after the full text completes. */
  synthesizeStream(text: string, onChunk: (chunk: TtsChunk) => void, options?: { signal?: AbortSignal }): Promise<void>
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

    async synthesizeStream(
      text: string,
      onChunk: (chunk: TtsChunk) => void,
      options?: { signal?: AbortSignal }
    ): Promise<void> {
      if (!currentConfig.ttsUrl) {
        throw new Error('No TTS URL configured')
      }

      // Derive the stream URL from the configured ttsUrl by appending /stream.
      // e.g. http://127.0.0.1:5810/synthesize → http://127.0.0.1:5810/synthesize/stream
      const streamUrl = currentConfig.ttsUrl.replace(/\/?$/, '/stream')

      // Streaming can take much longer than a single synthesis — the total
      // timeout covers ALL sentences, not just one. Multiply the per-sentence
      // timeout by a generous factor.
      const streamTimeoutMs = getTimeoutMs() * 5
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(new Error('Stream timeout')), streamTimeoutMs)

      function onExternalAbort() {
        controller.abort(options?.signal?.reason ?? new Error('Aborted'))
      }
      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId)
          controller.abort(options.signal.reason ?? new Error('Aborted'))
        } else {
          options.signal.addEventListener('abort', onExternalAbort, { once: true })
        }
      }

      try {
        const response = await fetch(streamUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal
        })

        if (!response.ok) {
          throw new Error(`TTS stream failed: ${response.status} ${response.statusText}`)
        }

        if (!response.body) {
          throw new Error('TTS stream returned no body')
        }

        // Read NDJSON lines from the response body
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Process complete lines
          let newlineIdx: number
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim()
            buffer = buffer.slice(newlineIdx + 1)

            if (!line) continue

            try {
              const parsed = JSON.parse(line) as {
                index: number
                total: number
                sentence: string
                audio?: string
                durationMs?: number
                rtf?: number
                done: boolean
                error?: string
              }

              if (parsed.error) {
                throw new Error(`TTS stream error on sentence ${parsed.index + 1}: ${parsed.error}`)
              }

              if (parsed.audio) {
                onChunk({
                  index: parsed.index,
                  total: parsed.total,
                  sentence: parsed.sentence,
                  audio: Buffer.from(parsed.audio, 'base64'),
                  durationMs: parsed.durationMs ?? 0,
                  rtf: parsed.rtf ?? 0,
                  done: parsed.done
                })
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message.startsWith('TTS stream error')) {
                throw parseErr
              }
              // Skip malformed lines
              console.warn('[voice] skipped malformed TTS stream line')
            }
          }
        }

        bus.emit({
          type: 'voice.tts.stream.completed',
          timestamp: new Date().toISOString(),
          source: 'voice',
          payload: { text }
        })
      } catch (err) {
        throw wrapFetchError('TTS stream', err)
      } finally {
        clearTimeout(timeoutId)
        if (options?.signal) {
          options.signal.removeEventListener('abort', onExternalAbort)
        }
      }
    },

    updateConfig(newConfig: Partial<VoiceModuleConfig>) {
      currentConfig = { ...currentConfig, ...newConfig }
    }
  }
}
