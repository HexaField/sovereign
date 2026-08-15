// Media Session keep-alive — prevents Android from killing the PWA process
// when backgrounded by maintaining an active audio session.
//
// How it works:
//   1. A short silent WAV loops via an <audio> element
//   2. The MediaSession API registers metadata ("Hex — Listening")
//   3. Android treats the PWA as a media app → longer background life
//   4. The WS connection stays alive → TTS audio arrives even when backgrounded
//
// Starts automatically on the first TTS playback (which requires a user
// gesture, satisfying the autoplay policy). The user can stop it via the
// media controls on the lock screen or notification shade.

import { createSignal } from 'solid-js'

// ── Silent WAV generator ──────────────────────────────────────────────

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/** Build a minimal 1-second silent WAV in memory — no network fetch needed. */
function createSilentWav(durationMs = 1000, sampleRate = 8000): Blob {
  const numSamples = Math.ceil((sampleRate * durationMs) / 1000)
  const dataSize = numSamples * 2 // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk — PCM, mono, 16-bit
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk — zeros = silence (ArrayBuffer initialises to 0)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  return new Blob([buffer], { type: 'audio/wav' })
}

// ── State ──────────────────────────────────────────────────────────────

let silentAudio: HTMLAudioElement | null = null
let objectUrl: string | null = null
let revertTimer: ReturnType<typeof setTimeout> | null = null

const [keepAliveActive, setKeepAliveActive] = createSignal(false)

export { keepAliveActive as isKeepAliveActive }

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Start the silent audio loop and register a MediaSession. Call after
 * a user gesture (required by autoplay policy). Safe to call multiple
 * times — subsequent calls do nothing while already active.
 */
export function startMediaKeepAlive(): void {
  if (silentAudio) return
  if (typeof Audio === 'undefined') return

  const blob = createSilentWav(1000)
  objectUrl = URL.createObjectURL(blob)

  silentAudio = new Audio(objectUrl)
  silentAudio.loop = true
  // Near-zero volume — some browsers skip playback at exactly 0
  silentAudio.volume = 0.01

  silentAudio
    .play()
    .then(() => {
      setKeepAliveActive(true)
      registerMediaSession()
    })
    .catch((err) => {
      console.warn('[media-session] silent audio play failed:', err)
      cleanup()
    })
}

/** Stop the keep-alive loop and clear the MediaSession. */
export function stopMediaKeepAlive(): void {
  cleanup()
}

/**
 * Update the MediaSession metadata to show what Hex just said.
 * Displays on the lock screen and notification shade. Reverts to
 * the idle "Listening" state after 30 seconds.
 */
export function updateNowPlaying(text: string): void {
  if (!('mediaSession' in navigator)) return
  if (!silentAudio) return

  if (revertTimer) {
    clearTimeout(revertTimer)
    revertTimer = null
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: text.length > 60 ? text.slice(0, 57) + '…' : text,
    artist: 'Hex',
    album: 'Sovereign'
  })

  // Revert to idle after the user has had time to read the text
  revertTimer = setTimeout(() => {
    revertTimer = null
    if (silentAudio) setIdleMetadata()
  }, 30_000)
}

// ── Internal ──────────────────────────────────────────────────────────

function registerMediaSession(): void {
  if (!('mediaSession' in navigator)) return

  setIdleMetadata()

  navigator.mediaSession.setActionHandler('pause', () => {
    stopMediaKeepAlive()
  })
  navigator.mediaSession.setActionHandler('play', () => {
    if (!silentAudio) startMediaKeepAlive()
  })
}

function setIdleMetadata(): void {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Listening',
    artist: 'Hex',
    album: 'Sovereign'
  })
}

function cleanup(): void {
  if (revertTimer) {
    clearTimeout(revertTimer)
    revertTimer = null
  }
  if (silentAudio) {
    silentAudio.pause()
    silentAudio.src = ''
    silentAudio = null
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  setKeepAliveActive(false)
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('play', null)
    } catch {
      // Some browsers throw on null handlers
    }
  }
}
