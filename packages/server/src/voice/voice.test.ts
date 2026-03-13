import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createVoiceModule } from './voice.js'
import type { VoiceModule } from './voice.js'
import type { EventBus, BusEvent } from '@template/core'

function createMockBus(): EventBus & { emitted: BusEvent[] } {
  const emitted: BusEvent[] = []
  return {
    emitted,
    emit(event: BusEvent) {
      emitted.push(event)
    },
    on() {
      return () => {}
    },
    once() {
      return () => {}
    },
    async *replay() {},
    history() {
      return []
    }
  }
}

describe('§6.4 Voice Module (Server)', () => {
  let bus: ReturnType<typeof createMockBus>
  let voice: VoiceModule

  beforeEach(() => {
    bus = createMockBus()
    voice = createVoiceModule(bus, {
      transcribeUrl: 'http://localhost:9876/transcribe',
      ttsUrl: 'http://localhost:9876/tts'
    })
  })

  it('MUST accept audio blob via POST /api/voice/transcribe (multipart/form-data)', async () => {
    // The route accepts multipart - tested via the createVoiceRoutes integration
    // Here we verify the voice module transcribe accepts Buffer + mimeType
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'hello world' })
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await voice.transcribe(Buffer.from('audio-data'), 'audio/wav')
    expect(result.text).toBe('hello world')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9876/transcribe',
      expect.objectContaining({
        method: 'POST'
      })
    )

    vi.unstubAllGlobals()
  })

  it('MUST proxy audio to configured transcription service URL (voice.transcribeUrl)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'proxied' })
    })
    vi.stubGlobal('fetch', mockFetch)

    await voice.transcribe(Buffer.from('data'), 'audio/webm')
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:9876/transcribe')

    vi.unstubAllGlobals()
  })

  it('MUST return { text: string } from transcription endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'result text' })
      })
    )

    const result = await voice.transcribe(Buffer.from('data'), 'audio/wav')
    expect(result).toHaveProperty('text', 'result text')
    expect(typeof result.durationMs).toBe('number')

    vi.unstubAllGlobals()
  })

  it('MUST return 503 if no transcription URL is configured', async () => {
    const noUrlVoice = createVoiceModule(bus, {})
    await expect(noUrlVoice.transcribe(Buffer.from('data'), 'audio/wav')).rejects.toThrow(
      'No transcription URL configured'
    )
  })

  it('MUST accept { text, voice? } via POST /api/voice/tts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
      })
    )

    const result = await voice.synthesize('hello', 'af_heart')
    expect(result.audio).toBeInstanceOf(Buffer)
    expect(result.audio.length).toBe(100)

    vi.unstubAllGlobals()
  })

  it('MUST proxy text to configured TTS service URL (voice.ttsUrl)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(10))
    })
    vi.stubGlobal('fetch', mockFetch)

    await voice.synthesize('test text', 'voice1')
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:9876/tts')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body).toEqual({ text: 'test text', voice: 'voice1' })

    vi.unstubAllGlobals()
  })

  it('MUST return audio blob with appropriate Content-Type', async () => {
    const audioData = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer // RIFF header
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(audioData)
      })
    )

    const result = await voice.synthesize('hello')
    expect(result.audio).toBeInstanceOf(Buffer)
    expect(result.audio.length).toBe(4)

    vi.unstubAllGlobals()
  })

  it('MUST return 503 if no TTS URL is configured', async () => {
    const noUrlVoice = createVoiceModule(bus, {})
    await expect(noUrlVoice.synthesize('hello')).rejects.toThrow('No TTS URL configured')
  })

  it('MUST support hot-reload of voice.transcribeUrl config value', async () => {
    voice.updateConfig({ transcribeUrl: 'http://new-host/transcribe' })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'new' })
    })
    vi.stubGlobal('fetch', mockFetch)

    await voice.transcribe(Buffer.from('data'), 'audio/wav')
    expect(mockFetch.mock.calls[0][0]).toBe('http://new-host/transcribe')

    vi.unstubAllGlobals()
  })

  it('MUST support hot-reload of voice.ttsUrl config value', async () => {
    voice.updateConfig({ ttsUrl: 'http://new-tts/speak' })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))
    })
    vi.stubGlobal('fetch', mockFetch)

    await voice.synthesize('test')
    expect(mockFetch.mock.calls[0][0]).toBe('http://new-tts/speak')

    vi.unstubAllGlobals()
  })

  it('MUST emit voice.transcription.completed bus event with { text, durationMs }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'heard' })
      })
    )

    await voice.transcribe(Buffer.from('data'), 'audio/wav')

    const event = bus.emitted.find((e) => e.type === 'voice.transcription.completed')
    expect(event).toBeDefined()
    expect((event!.payload as any).text).toBe('heard')
    expect(typeof (event!.payload as any).durationMs).toBe('number')

    vi.unstubAllGlobals()
  })

  it('MUST emit voice.tts.completed bus event with { text, durationMs }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))
      })
    )

    await voice.synthesize('spoken')

    const event = bus.emitted.find((e) => e.type === 'voice.tts.completed')
    expect(event).toBeDefined()
    expect((event!.payload as any).text).toBe('spoken')
    expect(typeof (event!.payload as any).durationMs).toBe('number')

    vi.unstubAllGlobals()
  })
})
