import { describe, it, expect, vi } from 'vitest'
import { createVoiceTranscriptionProvider } from './provider.js'
import type { VoiceModule } from './voice.js'

function mockVoiceModule(overrides: Partial<VoiceModule> = {}): VoiceModule {
  return {
    status: vi.fn().mockReturnValue({ module: 'voice', status: 'ok' }),
    transcribe: vi.fn().mockResolvedValue({ text: 'hello world', durationMs: 1500 }),
    synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from('audio'), durationMs: 500 }),
    updateConfig: vi.fn(),
    ...overrides
  }
}

describe('§8.1.2 Voice Module Provider Adapter', () => {
  it('§8.1.2 MUST adapt VoiceModule.transcribe() into a TranscriptionProvider via createVoiceTranscriptionProvider', async () => {
    const vm = mockVoiceModule()
    const provider = createVoiceTranscriptionProvider(vm)
    const buf = Buffer.from('audio-data')
    const result = await provider.transcribe(buf, 'audio/webm')
    expect(result.text).toBe('hello world')
    expect(result.durationMs).toBe(1500)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].start).toBe(0)
    expect(result.segments[0].end).toBe(1500)
    expect(vm.transcribe).toHaveBeenCalledWith(buf, 'audio/webm', { signal: undefined })
  })

  it('§8.1.2 available() MUST return true only when voice module has transcription URL configured', () => {
    const vmOk = mockVoiceModule({ status: vi.fn().mockReturnValue({ module: 'voice', status: 'ok' }) })
    expect(createVoiceTranscriptionProvider(vmOk).available()).toBe(true)

    const vmDegraded = mockVoiceModule({ status: vi.fn().mockReturnValue({ module: 'voice', status: 'degraded' }) })
    expect(createVoiceTranscriptionProvider(vmDegraded).available()).toBe(true)

    const vmError = mockVoiceModule({ status: vi.fn().mockReturnValue({ module: 'voice', status: 'error' }) })
    expect(createVoiceTranscriptionProvider(vmError).available()).toBe(false)
  })

  it('§8.1.2 MUST report diarization: false unless configured endpoint supports it', () => {
    const provider = createVoiceTranscriptionProvider(mockVoiceModule())
    expect(provider.capabilities.diarization).toBe(false)
  })

  it('§8.1.2 SHOULD allow future providers to slot in without changing the pipeline', () => {
    // The TranscriptionProvider interface is generic — any provider implementing it works
    const provider = createVoiceTranscriptionProvider(mockVoiceModule())
    expect(provider.name).toBe('voice-module')
    expect(provider.capabilities).toBeDefined()
    expect(typeof provider.transcribe).toBe('function')
    expect(typeof provider.available).toBe('function')
  })
})
