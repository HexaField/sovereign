// TTS audio player — receives voice.tts.audio JSON messages from the
// server and plays them through the Web Audio API.
//
// The server sends WAV audio as base64-encoded JSON on the chat WS
// channel. Every clip goes through one speech queue (tts-queue.ts): whole
// replies play one after another, a cue sounds between back-to-back
// replies, and only an explicit stop cuts playback short. "Play aloud"
// uses the same queue.
//
// The server routes TTS by device NAME (a page refresh mints a fresh
// deviceId), and sends the audio to ONE connection under that name: the
// others get the message without `audio`. It prefers the tab the user
// touched last, so each tab reports focus and input as `ws.active`.

import { createSignal } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'
import { startMediaKeepAlive, updateNowPlaying, isKeepAliveActive } from './media-session.js'
import { createSpeechQueue } from './tts-queue.js'

let audioContext: AudioContext | null = null
let currentSource: AudioScheduledSourceNode | null = null
const [playing, setPlaying] = createSignal(false)
let cleanup: (() => void) | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  // Resume if suspended (browser autoplay policy)
  if (audioContext.state === 'suspended') {
    void audioContext.resume()
  }
  return audioContext
}

/** Stop all TTS playback now and drop everything queued. */
export function interruptTts(): void {
  speech.stop()
}

/** Convert a base64 string to an ArrayBuffer. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/** Play one source node; resolve when it ends or is stopped. */
function playSource(source: AudioScheduledSourceNode): Promise<void> {
  return new Promise<void>((resolve) => {
    currentSource = source
    source.onended = () => {
      if (currentSource === source) currentSource = null
      resolve()
    }
    source.start()
  })
}

/** The Web Audio side of the speech queue. */
const speech = createSpeechQueue(
  {
    async play(clip) {
      const ctx = getAudioContext()
      try {
        const source = ctx.createBufferSource()
        source.buffer = await ctx.decodeAudioData(clip.slice(0))
        source.connect(ctx.destination)
        await playSource(source)
      } catch (err) {
        console.error('[tts-player] decode/play failed:', err)
      }
    },
    async cue() {
      // Two soft rising tones: one reply ended, the next begins.
      const ctx = getAudioContext()
      const t = ctx.currentTime
      for (const [freq, at] of [
        [660, 0],
        [880, 0.11]
      ] as const) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, t + at)
        gain.gain.exponentialRampToValueAtTime(0.08, t + at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.1)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t + at)
        osc.stop(t + at + 0.1)
      }
      // The tones, then a short breath before the next reply.
      await new Promise((r) => setTimeout(r, 400))
    },
    stop() {
      try {
        currentSource?.stop()
      } catch {
        // already stopped
      }
      currentSource = null
    }
  },
  { onActiveChange: setPlaying }
)

export interface TtsAudioMessage {
  threadId?: string
  kind?: string
  text?: string
  audio?: string
  chunk?: { index: number; total: number; done: boolean }
  /** The reply this clip belongs to; its chunks share the id. */
  utterance?: string
}

let fallbackUtterance = 0

/** The reply a message belongs to: the server's id, or for an older server
 *  thread + kind, renewed at chunk 0 and for every unchunked clip. */
const openFallback = new Map<string, string>()
function utteranceOf(msg: TtsAudioMessage): string {
  if (msg.utterance) return msg.utterance
  const key = `${msg.threadId ?? ''}:${msg.kind ?? ''}`
  if (!msg.chunk || msg.chunk.index === 0 || !openFallback.has(key))
    openFallback.set(key, `local-${++fallbackUtterance}`)
  return openFallback.get(key)!
}

/** Handle one voice.tts.audio message that carries audio: queue it. */
function handleIncomingAudio(msg: TtsAudioMessage): void {
  // Start the media keep-alive on first TTS playback — the voice
  // interaction serves as the user gesture that satisfies autoplay policy.
  if (!isKeepAliveActive()) startMediaKeepAlive()

  // Show the spoken text on the lock screen / notification shade
  if (msg.text) updateNowPlaying(msg.text)

  speech.enqueue({
    utterance: utteranceOf(msg),
    clip: base64ToArrayBuffer(msg.audio as string),
    last: !msg.chunk || msg.chunk.done,
    priority: msg.kind === 'ack'
  })
}

const ACTIVE_THROTTLE_MS = 5_000

/** Report this tab as active (focused or touched) so the server picks it
 *  to speak. Throttled; sent again on every reconnect while focused. Only
 *  after the user has interacted with the page: before that the browser's
 *  autoplay policy keeps its audio suspended, so it must not win. Never
 *  while disconnected: a queued report would arrive late and stale. */
function reportActivity(ws: WsStore): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  let last = 0
  const report = (force = false): void => {
    if (document.visibilityState !== 'visible' || !document.hasFocus() || !ws.connected()) return
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return
    if (!force && Date.now() - last < ACTIVE_THROTTLE_MS) return
    last = Date.now()
    ws.send({ type: 'ws.active' } as any)
  }
  const onFocus = (): void => report(true)
  const onInput = (): void => report()
  const onVisible = (): void => report(true)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pointerdown', onInput, { passive: true })
  window.addEventListener('keydown', onInput)
  document.addEventListener('visibilitychange', onVisible)
  const unsubReconnect = ws.on('ws.reconnected', () => report(true))
  report(true)
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pointerdown', onInput)
    window.removeEventListener('keydown', onInput)
    document.removeEventListener('visibilitychange', onVisible)
    unsubReconnect()
  }
}

/** Wire up the TTS player to listen for voice.tts.audio messages.
 *  Call once at app startup. Returns a cleanup function. */
export function initTtsPlayer(ws: WsStore): () => void {
  if (cleanup) cleanup() // idempotent re-init

  // Listen for TTS audio messages (base64-encoded WAV in JSON)
  const unsubAudio = ws.on('voice.tts.audio', (msg: any) => {
    if (!msg.audio) return
    console.log(`[tts-player] ${msg.kind ?? 'audio'}: "${msg.text?.slice(0, 60) ?? ''}"`)
    handleIncomingAudio(msg)
  })
  const stopReporting = reportActivity(ws)

  // Log status messages for debugging
  const unsubAckPending = ws.on('voice.ack.pending', (msg: any) => {
    console.log('[tts-player] ack pending:', msg.text)
  })

  const unsubSummaryPending = ws.on('voice.summary.pending', (msg: any) => {
    console.log('[tts-player] summary pending:', msg.text)
  })

  cleanup = () => {
    unsubAudio()
    unsubAckPending()
    unsubSummaryPending()
    stopReporting()
    interruptTts()
  }

  return cleanup
}

/** Queue base64-encoded WAV audio as one reply, ahead of replies still
 *  waiting. Used by the on-demand "Play aloud" context menu. */
export function playBase64Audio(base64: string): void {
  if (!isKeepAliveActive()) startMediaKeepAlive()
  speech.enqueue({
    utterance: `play-aloud-${++fallbackUtterance}`,
    clip: base64ToArrayBuffer(base64),
    last: true,
    priority: true
  })
}

/** Whether TTS audio plays or waits to play (reactive). */
export function isTtsPlaying(): boolean {
  return playing()
}
