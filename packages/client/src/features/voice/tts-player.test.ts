import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initTtsPlayer, interruptTts, isTtsPlaying, claimKeyFor } from './tts-player.js'
import type { WsStore } from '../../ws/ws-store.js'

// --- Helpers ---

/** A minimal WsStore stand-in: `on()` records handlers per message type and
 *  `fire()` invokes them, mirroring how the real store dispatches a parsed
 *  server frame to its listeners. */
function createMockWsStore(): WsStore & { fire: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, Set<(msg: any) => void>>()
  return {
    connected: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn((type: string, handler: (msg: any) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => {
        handlers.get(type)?.delete(handler)
      }
    }),
    onBinary: vi.fn(() => () => {}),
    send: vi.fn(),
    close: vi.fn(),
    fire: (type: string, msg: unknown) => {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(msg)
    }
  } as unknown as WsStore & { fire: (type: string, msg: unknown) => void }
}

/** Installs a fake AudioContext once for the whole file. `getAudioContext`
 *  inside the module under test caches its instance on first use and keeps
 *  it for the module's lifetime, so re-installing a fresh mock class per
 *  test would not take effect after the first playback — spies stay
 *  constant instead and each test clears their call history. */
function installFakeAudioContext(): {
  start: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  decodeAudioData: ReturnType<typeof vi.fn>
} {
  const start = vi.fn()
  const connect = vi.fn()
  const decodeAudioData = vi.fn().mockResolvedValue({})
  const MockAudioContext = vi.fn().mockImplementation(function (this: any) {
    this.state = 'running'
    this.destination = {}
    this.decodeAudioData = decodeAudioData
    this.createBufferSource = vi.fn().mockReturnValue({
      buffer: null,
      connect,
      start,
      stop: vi.fn(),
      onended: null
    })
    this.resume = vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(globalThis, 'AudioContext', { value: MockAudioContext, writable: true, configurable: true })
  return { start, connect, decodeAudioData }
}

const AUDIO_B64 = Buffer.from('fake-wav-bytes').toString('base64')

// Outlasts the module's claim window (50ms base + up to 20ms jitter).
const PAST_CLAIM_WINDOW_MS = 130

const { start, connect, decodeAudioData } = installFakeAudioContext()

describe('tts-player — cross-tab playback dedup', () => {
  beforeEach(() => {
    start.mockClear()
    connect.mockClear()
    decodeAudioData.mockClear()
    interruptTts()
  })

  afterEach(() => {
    interruptTts()
  })

  it('plays audio when no rival tab claims the same clip', async () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)

    ws.fire('voice.tts.audio', {
      threadId: 't1',
      kind: 'ack',
      text: 'Looking into the build logs, sir.',
      audio: AUDIO_B64
    })
    await new Promise((resolve) => setTimeout(resolve, PAST_CLAIM_WINDOW_MS))

    expect(start).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('skips playback when a rival tab claims the identical clip first', async () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)
    const msg = { threadId: 't2', kind: 'ack', text: 'Running that analysis now.', audio: AUDIO_B64 }

    // A second BroadcastChannel instance stands in for a sibling tab —
    // real BroadcastChannel, since Node ships a working implementation.
    const rival = new BroadcastChannel('sovereign-tts-lock')
    try {
      ws.fire('voice.tts.audio', msg)
      // Let the module's own listener finish registering (it does so
      // synchronously on first use, but a tick keeps this deterministic),
      // then claim the exact key this tab computed for the same clip.
      await new Promise((resolve) => setTimeout(resolve, 0))
      rival.postMessage({ type: 'claim', key: claimKeyFor(msg) })

      await new Promise((resolve) => setTimeout(resolve, PAST_CLAIM_WINDOW_MS))

      expect(start).not.toHaveBeenCalled()
    } finally {
      rival.close()
      cleanup()
    }
  })

  it('never suppresses a genuinely distinct clip sharing the same thread and kind', async () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)

    const rival = new BroadcastChannel('sovereign-tts-lock')
    try {
      // Rival claims a DIFFERENT clip (different text) on the same thread —
      // must not suppress this tab's distinct clip.
      rival.postMessage({
        type: 'claim',
        key: claimKeyFor({ threadId: 't3', kind: 'summary', text: 'A completely different summary.' })
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      ws.fire('voice.tts.audio', {
        threadId: 't3',
        kind: 'summary',
        text: 'Deployed the change, sir.',
        audio: AUDIO_B64
      })
      await new Promise((resolve) => setTimeout(resolve, PAST_CLAIM_WINDOW_MS))

      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      rival.close()
      cleanup()
    }
  })

  it('reports isTtsPlaying false once decode/play never happens (message carries no audio)', () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)

    ws.fire('voice.tts.audio', { threadId: 't4', kind: 'ack', text: 'No audio here' })

    expect(isTtsPlaying()).toBe(false)
    expect(start).not.toHaveBeenCalled()
    cleanup()
  })

  it('claimKeyFor produces the same key for identical payloads and different keys for different text', () => {
    const a = claimKeyFor({ threadId: 't5', kind: 'ack', text: 'Same text' })
    const b = claimKeyFor({ threadId: 't5', kind: 'ack', text: 'Same text' })
    const c = claimKeyFor({ threadId: 't5', kind: 'ack', text: 'Different text' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
