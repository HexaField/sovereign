import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStreamingSession, createStreamingManager } from './streaming.js'

// Mock fetch globally for these tests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function okTranscriptResponse(text: string) {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('createStreamingSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accumulates chunks and transcribes periodically', async () => {
    const transcripts: string[] = []
    mockFetch.mockResolvedValue(okTranscriptResponse('hello world'))

    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: (text) => transcripts.push(text)
    })

    // Push enough audio data to exceed MIN_NEW_BYTES (2000)
    const bigChunk = Buffer.alloc(3000).toString('base64')
    session.pushChunk(bigChunk)

    // Advance timer past INTERVAL_MS (1500ms)
    await vi.advanceTimersByTimeAsync(1600)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(transcripts).toContain('hello world')

    session.abort()
  })

  it('skips transcription when not enough new audio arrives', async () => {
    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    // Push small chunk (under MIN_NEW_BYTES)
    session.pushChunk(Buffer.alloc(100).toString('base64'))

    await vi.advanceTimersByTimeAsync(1600)
    expect(mockFetch).not.toHaveBeenCalled()

    session.abort()
  })

  it('stop() performs a final transcription and returns the text', async () => {
    mockFetch.mockResolvedValue(okTranscriptResponse('final result'))

    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    session.pushChunk(Buffer.alloc(100).toString('base64'))

    // stop() forces a final transcription regardless of MIN_NEW_BYTES
    const result = await session.stop()
    expect(result).toBe('final result')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('abort() stops without a final transcription', () => {
    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    session.pushChunk(Buffer.alloc(100).toString('base64'))
    session.abort()

    // No fetch should fire after abort
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('calls onError when fetch fails', async () => {
    const errors: Error[] = []
    mockFetch.mockRejectedValue(new Error('network down'))

    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {},
      onError: (err) => errors.push(err)
    })

    session.pushChunk(Buffer.alloc(3000).toString('base64'))
    await vi.advanceTimersByTimeAsync(1600)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('network down')

    session.abort()
  })

  it('marks the final transcript with isFinal=true', async () => {
    const results: Array<{ text: string; final: boolean }> = []
    mockFetch.mockResolvedValue(okTranscriptResponse('done'))

    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: (text, isFinal) => results.push({ text, final: isFinal })
    })

    session.pushChunk(Buffer.alloc(100).toString('base64'))
    await session.stop()

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ text: 'done', final: true })
  })
})

describe('createStreamingSession — pcm16', () => {
  const RATE = 16000
  /** `seconds` of 16-bit samples: loud, or silent where `quiet(t)` says so. */
  const pcm = (seconds: number, quiet: (t: number) => boolean = () => false) => {
    const buf = Buffer.alloc(Math.round(seconds * RATE) * 2)
    for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(quiet(i / RATE) ? 0 : 8000, i * 2)
    return buf
  }
  /** whisper stand-in: answers with the seconds of audio it got, read from the WAV. */
  const secondsHeard = async (_url: string, init: { body: FormData }) => {
    const wav = Buffer.from(await (init.body.get('file') as Blob).arrayBuffer())
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(RATE)
    return okTranscriptResponse(`s${Math.round(wav.readUInt32LE(40) / 2 / RATE)}`)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    mockFetch.mockImplementation(secondsHeard)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('transcribes only the audio after a committed cut, made at the quietest point', async () => {
    const results: Array<{ text: string; final: boolean }> = []
    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: (text, final) => results.push({ text, final }),
      format: 'pcm16'
    })

    // 25 s of speech with a pause at 14 s: past the 20 s commit threshold.
    session.pushChunk(pcm(25, (t) => t >= 14 && t < 14.2).toString('base64'))
    await vi.advanceTimersByTimeAsync(1600)
    // Committed up to the pause, and the same pass keeps the 11 s after it on screen.
    expect(results[results.length - 1]).toEqual({ text: 's14 s11', final: false })

    session.pushChunk(pcm(1).toString('base64'))
    await vi.advanceTimersByTimeAsync(1600)
    expect(results[results.length - 1]).toEqual({ text: 's14 s12', final: false }) // the 12 s after the cut

    expect(await session.stop()).toBe('s14 s12')
    expect(results[results.length - 1]!.final).toBe(true)
  })

  it('posts nothing for a tail too short to hold words', async () => {
    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {},
      format: 'pcm16'
    })
    session.pushChunk(pcm(0.2).toString('base64'))
    expect(await session.stop()).toBe('')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('falls back to 16 kHz for a sample rate it cannot use (0 made the quiet-point scan endless)', async () => {
    for (const sampleRate of [0, -1, 1e9]) {
      const session = createStreamingSession({
        transcribeUrl: 'http://localhost:9876/transcribe',
        onTranscript: () => {},
        format: 'pcm16',
        sampleRate
      })
      session.pushChunk(pcm(1).toString('base64'))
      expect(await session.stop()).toBe('s1') // the WAV header says 16 kHz
    }
  })

  it('sends whole samples only when a chunk ends mid-sample', async () => {
    const lengths: number[] = []
    mockFetch.mockImplementation(async (_url: string, init: { body: FormData }) => {
      const wav = Buffer.from(await (init.body.get('file') as Blob).arrayBuffer())
      lengths.push(wav.readUInt32LE(40))
      return okTranscriptResponse('x')
    })
    const session = createStreamingSession({
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {},
      format: 'pcm16'
    })
    session.pushChunk(Buffer.concat([pcm(1), Buffer.alloc(1)]).toString('base64'))
    await session.stop()
    expect(lengths).toEqual([RATE * 2])
  })
})

describe('createStreamingManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks sessions by deviceId', () => {
    const manager = createStreamingManager()
    const session = manager.startSession('dev-1', {
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    expect(manager.getSession('dev-1')).toBe(session)
    expect(manager.getSession('dev-2')).toBeUndefined()

    session.abort()
  })

  it('aborts existing session when starting a new one for same device', () => {
    const manager = createStreamingManager()
    const first = manager.startSession('dev-1', {
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    const second = manager.startSession('dev-1', {
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    expect(manager.getSession('dev-1')).toBe(second)
    expect(manager.getSession('dev-1')).not.toBe(first)

    second.abort()
  })

  it('stopSession returns final transcript and removes session', async () => {
    mockFetch.mockResolvedValue(okTranscriptResponse('stopped'))
    const manager = createStreamingManager()

    manager.startSession('dev-1', {
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    manager.getSession('dev-1')!.pushChunk(Buffer.alloc(100).toString('base64'))
    const result = await manager.stopSession('dev-1')

    expect(result).toBe('stopped')
    expect(manager.getSession('dev-1')).toBeUndefined()
  })

  it('abortSession removes session without final transcription', () => {
    const manager = createStreamingManager()
    manager.startSession('dev-1', {
      transcribeUrl: 'http://localhost:9876/transcribe',
      onTranscript: () => {}
    })

    manager.abortSession('dev-1')
    expect(manager.getSession('dev-1')).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
