// Streaming STT — accumulates audio chunks from a WebSocket client and
// periodically transcribes via the batch whisper-stt HTTP endpoint.
//
// Two audio formats:
// - webm (browser MediaRecorder): only the first chunk carries the
//   container header, so every pass transcribes the whole recording and
//   the newest transcript replaces the last.
// - pcm16 (voice node): raw 16-bit mono samples. Passes cover only the
//   audio after the last committed cut. Once that tail runs COMMIT_AFTER_S,
//   the session cuts it at its quietest moment, transcribes up to the cut
//   once and keeps that text. A pass therefore stays a few seconds long
//   however long the user speaks.

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
  /** Chunk format; default 'webm'. */
  format?: 'webm' | 'pcm16'
  /** pcm16 sample rate; default 16000. */
  sampleRate?: number
}

/** How often (ms) to fire a transcription pass on accumulated audio. */
const INTERVAL_MS = 1500

/** Minimum bytes of new audio before bothering to re-transcribe. */
const MIN_NEW_BYTES = 2000

/** pcm16: commit the tail once it runs this long (seconds)... */
const COMMIT_AFTER_S = 20
/** ...cutting at the quietest QUIET_FRAME_S frame at least MIN_COMMIT_S in. */
const MIN_COMMIT_S = 10
const QUIET_FRAME_S = 0.2
/** pcm16: a tail shorter than this holds no words; whisper only invents some. */
const MIN_TAIL_S = 0.3

/** A 44-byte WAV header around 16-bit mono PCM. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Byte offset (sample-aligned) of the middle of the quietest frame in [from, to). */
function quietestPoint(pcm: Buffer, from: number, to: number, frameBytes: number): number {
  let best = from
  let bestEnergy = Infinity
  for (let start = from; start + frameBytes <= to; start += frameBytes) {
    let energy = 0
    for (let i = start; i < start + frameBytes; i += 2) energy += Math.abs(pcm.readInt16LE(i))
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + frameBytes / 2
    }
  }
  return best - (best % 2)
}

const joinText = (...parts: string[]): string => parts.filter(Boolean).join(' ')

export function createStreamingSession(deps: StreamingDeps): StreamingSession {
  const pcm = deps.format === 'pcm16'
  const sampleRate = deps.sampleRate ?? 16000
  const bytesPerSecond = sampleRate * 2
  const chunks: Buffer[] = []
  let totalBytes = 0
  let lastTranscribedBytes = 0
  let lastTranscript = ''
  // pcm16: audio before committedBytes holds committedText for good.
  let committedBytes = 0
  let committedText = ''
  let timer: ReturnType<typeof setInterval> | null = null
  // The pass in flight: ticks skip while one runs, the final pass waits for it.
  let inflight: Promise<string> | null = null
  let stopped = false
  let aborted = false

  function audio(): Buffer {
    if (chunks.length > 1) chunks.splice(0, chunks.length, Buffer.concat(chunks))
    return chunks[0] ?? Buffer.alloc(0)
  }

  async function post(body: Buffer, filename: string, type: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(body)], { type }), filename)
    const res = await fetch(deps.transcribeUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`Transcription HTTP ${res.status}`)
    const data = (await res.json()) as { text?: string }
    return data.text?.trim() ?? ''
  }

  const postPcm = (from: number, to: number): Promise<string> =>
    to - from < MIN_TAIL_S * bytesPerSecond
      ? Promise.resolve('')
      : post(pcmToWav(audio().subarray(from, to), sampleRate), 'audio.wav', 'audio/wav')

  async function transcribe(isFinal: boolean): Promise<string> {
    if (totalBytes === 0) return ''
    // Skip if not enough new audio (unless final)
    if (!isFinal && totalBytes - lastTranscribedBytes < MIN_NEW_BYTES) return lastTranscript

    const end = totalBytes
    try {
      let text: string
      if (!pcm) {
        text = await post(audio(), 'audio.webm', 'audio/webm')
      } else if (!isFinal && end - committedBytes >= COMMIT_AFTER_S * bytesPerSecond) {
        const frameBytes = Math.round(QUIET_FRAME_S * bytesPerSecond) & ~1
        const cut = quietestPoint(audio(), committedBytes + MIN_COMMIT_S * bytesPerSecond, end, frameBytes)
        committedText = joinText(committedText, await postPcm(committedBytes, cut))
        committedBytes = cut
        text = committedText
      } else {
        text = joinText(committedText, await postPcm(committedBytes, end))
      }
      lastTranscript = text
      lastTranscribedBytes = end

      if (!aborted) {
        deps.onTranscript(text, isFinal)
      }

      return text
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)))
      return lastTranscript
    }
  }

  function tick(): void {
    if (stopped || aborted || inflight) return
    inflight = transcribe(false).finally(() => {
      inflight = null
    })
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
      if (inflight) await inflight
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
