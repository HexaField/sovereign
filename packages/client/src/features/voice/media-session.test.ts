import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Provide AudioContext stub before importing the module under test —
// the module checks `typeof Audio` on import.
const mockPlay = vi.fn().mockResolvedValue(undefined)
const mockPause = vi.fn()
let createdAudioSrc = ''
let createdAudioLoop = false
let createdAudioVolume = 1

class MockAudio {
  src = ''
  loop = false
  volume = 1
  play = mockPlay
  pause = mockPause
  constructor(src?: string) {
    if (src) this.src = src
    createdAudioSrc = this.src
    // Expose set values so tests can read them after construction
    const self = this
    Object.defineProperty(this, 'loop', {
      get: () => createdAudioLoop,
      set: (v: boolean) => {
        createdAudioLoop = v
      }
    })
    Object.defineProperty(this, 'volume', {
      get: () => createdAudioVolume,
      set: (v: number) => {
        createdAudioVolume = v
      }
    })
  }
}

Object.defineProperty(globalThis, 'Audio', { value: MockAudio, writable: true, configurable: true })

// MediaSession stubs
const mockSetActionHandler = vi.fn()
let mediaSessionMetadata: any = null
const mockMediaSession = {
  get metadata() {
    return mediaSessionMetadata
  },
  set metadata(v: any) {
    mediaSessionMetadata = v
  },
  setActionHandler: mockSetActionHandler
}
Object.defineProperty(navigator, 'mediaSession', { value: mockMediaSession, writable: true, configurable: true })

// MediaMetadata stub
class MockMediaMetadata {
  title: string
  artist: string
  album: string
  constructor(init: { title?: string; artist?: string; album?: string }) {
    this.title = init.title ?? ''
    this.artist = init.artist ?? ''
    this.album = init.album ?? ''
  }
}
Object.defineProperty(globalThis, 'MediaMetadata', { value: MockMediaMetadata, writable: true, configurable: true })

// URL.createObjectURL / revokeObjectURL stubs
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:silent-wav')
const mockRevokeObjectURL = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { value: mockCreateObjectURL, writable: true, configurable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: mockRevokeObjectURL, writable: true, configurable: true })

// Import AFTER stubs are in place
import { startMediaKeepAlive, stopMediaKeepAlive, updateNowPlaying, isKeepAliveActive } from './media-session.js'

describe('media-session keep-alive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mediaSessionMetadata = null
    createdAudioLoop = false
    createdAudioVolume = 1
    // Reset module state by stopping any active session
    stopMediaKeepAlive()
  })

  afterEach(() => {
    stopMediaKeepAlive()
    vi.useRealTimers()
  })

  it('starts a looping silent audio element on startMediaKeepAlive', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
    // The blob passed to createObjectURL should carry audio/wav type
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('audio/wav')
    expect(createdAudioLoop).toBe(true)
    expect(createdAudioVolume).toBeLessThan(0.1)
    expect(mockPlay).toHaveBeenCalledTimes(1)
  })

  it('reports active state after successful start', async () => {
    expect(isKeepAliveActive()).toBe(false)
    startMediaKeepAlive()
    await vi.runAllTimersAsync()
    expect(isKeepAliveActive()).toBe(true)
  })

  it('sets idle MediaSession metadata on start', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()
    expect(mediaSessionMetadata).not.toBeNull()
    expect(mediaSessionMetadata.title).toBe('Listening')
    expect(mediaSessionMetadata.artist).toBe('Hex')
  })

  it('does nothing on repeated start calls', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()
    startMediaKeepAlive()
    startMediaKeepAlive()
    expect(mockPlay).toHaveBeenCalledTimes(1)
  })

  it('stops the audio and clears state on stopMediaKeepAlive', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()
    expect(isKeepAliveActive()).toBe(true)

    stopMediaKeepAlive()
    expect(isKeepAliveActive()).toBe(false)
    expect(mockPause).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:silent-wav')
  })

  it('registers pause and play action handlers', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    const handlers = Object.fromEntries(mockSetActionHandler.mock.calls.map((c: any[]) => [c[0], c[1]]))
    expect(handlers).toHaveProperty('pause')
    expect(handlers).toHaveProperty('play')
  })

  it('updates now-playing metadata with spoken text', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    updateNowPlaying('Checking the deploy status, sir.')
    expect(mediaSessionMetadata.title).toBe('Checking the deploy status, sir.')
    expect(mediaSessionMetadata.artist).toBe('Hex')
  })

  it('truncates long text in metadata', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    const longText = 'A'.repeat(80)
    updateNowPlaying(longText)
    expect(mediaSessionMetadata.title.length).toBeLessThanOrEqual(60)
    expect(mediaSessionMetadata.title).toContain('…')
  })

  it('reverts to idle metadata after 30 seconds', async () => {
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    updateNowPlaying('Build succeeded, sir.')
    expect(mediaSessionMetadata.title).toBe('Build succeeded, sir.')

    vi.advanceTimersByTime(30_000)
    expect(mediaSessionMetadata.title).toBe('Listening')
  })

  it('handles play failure gracefully', async () => {
    mockPlay.mockRejectedValueOnce(new Error('autoplay blocked'))
    startMediaKeepAlive()
    await vi.runAllTimersAsync()

    expect(isKeepAliveActive()).toBe(false)
  })
})
