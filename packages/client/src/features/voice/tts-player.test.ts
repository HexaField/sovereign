// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initTtsPlayer, interruptTts, isTtsPlaying } from './tts-player.js'
import type { WsStore } from '../../ws/ws-store.js'

// jsdom implements no media playback; the lock-screen keep-alive stays out of these tests.
vi.mock('./media-session.js', () => ({
  startMediaKeepAlive: vi.fn(),
  updateNowPlaying: vi.fn(),
  isKeepAliveActive: () => true
}))

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

const { start, connect, decodeAudioData } = installFakeAudioContext()

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('tts-player', () => {
  beforeEach(() => {
    start.mockClear()
    connect.mockClear()
    decodeAudioData.mockClear()
    interruptTts()
  })

  afterEach(() => {
    interruptTts()
  })

  // The server picks one connection per device name to carry the audio;
  // every tab plays whatever audio reaches it, at once.
  it('plays a message that carries audio', async () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)

    ws.fire('voice.tts.audio', { threadId: 't1', kind: 'ack', text: 'Looking into it.', audio: AUDIO_B64 })
    await tick()

    expect(start).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('stays silent for the text-only copy sent to the other tabs', () => {
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)

    ws.fire('voice.tts.audio', { threadId: 't4', kind: 'ack', text: 'No audio here' })

    expect(isTtsPlaying()).toBe(false)
    expect(start).not.toHaveBeenCalled()
    cleanup()
  })
})

describe('tts-player — activity reports', () => {
  const sentActive = (ws: WsStore) =>
    (ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => m.type === 'ws.active').length

  it('reports a focused tab as active on start, on focus and on reconnect, but not while unfocused', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)
    expect(sentActive(ws)).toBe(1)

    window.dispatchEvent(new Event('focus'))
    ws.fire('ws.reconnected', {})
    expect(sentActive(ws)).toBe(3)

    focused.mockReturnValue(false)
    window.dispatchEvent(new Event('focus'))
    expect(sentActive(ws)).toBe(3)

    cleanup()
    focused.mockRestore()
  })

  it('throttles reports from repeated input', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const ws = createMockWsStore()
    const cleanup = initTtsPlayer(ws)
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('keydown'))
    expect(sentActive(ws)).toBe(1) // the start report covers the burst

    cleanup()
    focused.mockRestore()
  })

  it('sends no report before the user has interacted with the page, or while disconnected', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const activation = { hasBeenActive: false }
    Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })
    const ws = createMockWsStore()
    const connected = vi.spyOn(ws, 'connected').mockReturnValue(true)
    const cleanup = initTtsPlayer(ws)
    window.dispatchEvent(new Event('focus'))
    expect(sentActive(ws)).toBe(0) // a fresh reload: autoplay keeps its audio suspended

    activation.hasBeenActive = true
    connected.mockReturnValue(false)
    window.dispatchEvent(new Event('focus'))
    expect(sentActive(ws)).toBe(0) // a queued report would arrive stale

    connected.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    expect(sentActive(ws)).toBe(1)

    cleanup()
    focused.mockRestore()
    Reflect.deleteProperty(navigator, 'userActivation')
  })
})
