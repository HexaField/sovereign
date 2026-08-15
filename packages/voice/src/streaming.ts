// Streaming STT — accumulates audio chunks from a WebSocket client and
// periodically transcribes via the batch whisper-stt HTTP endpoint.
//
// Architecture: the client sends base64-encoded audio chunks (~100ms each)
// over the WS channel. This module concatenates them into a growing webm
// buffer and calls the whisper-stt /transcribe endpoint every INTERVAL_MS.
// The full transcript replaces any previous partial — each pass transcribes
// the entire accumulated audio so corrections improve over time.

export interface StreamingSession {
  /** Append a base64-encoded audio chunk. */
  pushChunk(base64: string): void
  /** Stop the session and return the final transcript. */
  stop(): Promise<string>
  /** Abort without waiting for a final transcript. */
  abort(): void
}

export interface StreamingDeps {
  /** URL of the whisper-stt /transcribe endpoint. */
  transcribeUrl: string
  /** Called whenever a new partial transcript arrives. */
  onTranscript: (text: string, isFinal: boolean) => void
  /** Called on error. */
  onError?: (err: Error) => void
}

/** How often (ms) to fire a transcription pass on accumulated audio. */
const INTERVAL_MS = 1500

/** Minimum bytes of new audio before bothering to re-transcribe. */
const MIN_NEW_BYTES = 2000

export function createStreamingSession(deps: StreamingDeps): StreamingSession {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let lastTranscribedBytes = 0
  let lastTranscript = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let inflight = false
  let stopped = false
  let aborted = false

  async function transcribe(isFinal: boolean): Promise<string> {
    if (totalBytes === 0) return ''
    if (inflight && !isFinal) return lastTranscript
    // Skip if not enough new audio (unless final)
    if (!isFinal && totalBytes - lastTranscribedBytes < MIN_NEW_BYTES) return lastTranscript

    inflight = true
    try {
      const audioBuffer = Buffer.concat(chunks)
      const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/webm' })
      const form = new FormData()
      form.append('file', blob, 'audio.webm')

      const res = await fetch(deps.transcribeUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15_000)
      })

      if (!res.ok) {
        throw new Error(`Transcription HTTP ${res.status}`)
      }

      const data = (await res.json()) as { text?: string }
      const text = data.text?.trim() ?? ''
      lastTranscript = text
      lastTranscribedBytes = totalBytes

      if (!aborted) {
        deps.onTranscript(text, isFinal)
      }

      return text
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)))
      return lastTranscript
    } finally {
      inflight = false
    }
  }

  function tick(): void {
    if (stopped || aborted) return
    void transcribe(false)
  }

  // Start the periodic transcription timer
  timer = setInterval(tick, INTERVAL_MS)

  return {
    pushChunk(base64: string) {
      if (stopped || aborted) return
      const buf = Buffer.from(base64, 'base64')
      chunks.push(buf)
      totalBytes += buf.length
    },

    async stop(): Promise<string> {
      if (aborted) return lastTranscript
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }

      // Final transcription pass with all accumulated audio
      return transcribe(true)
    },

    abort() {
      aborted = true
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

/** Manages multiple concurrent streaming sessions keyed by deviceId. */
export interface StreamingManager {
  startSession(deviceId: string, deps: StreamingDeps): StreamingSession
  getSession(deviceId: string): StreamingSession | undefined
  stopSession(deviceId: string): Promise<string>
  abortSession(deviceId: string): void
}

export function createStreamingManager(): StreamingManager {
  const sessions = new Map<string, StreamingSession>()

  return {
    startSession(deviceId, deps) {
      // Abort any existing session for this device
      const existing = sessions.get(deviceId)
      if (existing) existing.abort()

      const session = createStreamingSession(deps)
      sessions.set(deviceId, session)
      return session
    },

    getSession(deviceId) {
      return sessions.get(deviceId)
    },

    async stopSession(deviceId) {
      const session = sessions.get(deviceId)
      if (!session) return ''
      sessions.delete(deviceId)
      return session.stop()
    },

    abortSession(deviceId) {
      const session = sessions.get(deviceId)
      if (!session) return
      sessions.delete(deviceId)
      session.abort()
    }
  }
}
