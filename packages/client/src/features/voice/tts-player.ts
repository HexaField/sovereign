// TTS audio player — receives voice.tts.audio JSON messages from the
// server and plays them through the Web Audio API.
//
// The server sends WAV audio as base64-encoded JSON on the chat WS
// channel. This module decodes and plays it, with support for
// interrupting the current playback when a new frame arrives.
//
// The server routes TTS by device NAME (a page refresh mints a fresh
// deviceId), and sends the audio to ONE connection under that name: the
// others get the message without `audio`. It prefers the tab the user
// touched last, so each tab reports focus and input as `ws.active`.

import type { WsStore } from '../../ws/ws-store.js'
import { startMediaKeepAlive, updateNowPlaying, isKeepAliveActive } from './media-session.js'

let audioContext: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null
let isPlaying = false
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

/** Stop any currently playing TTS audio. */
export function interruptTts(): void {
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // already stopped
    }
    currentSource = null
  }
  isPlaying = false
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

// ── Chunk queue ─────────────────────────────────────────────────────
// When streaming TTS sends multiple voice.tts.audio messages for one
// summary (each with chunk.index / chunk.total), queue them and play
// sequentially instead of interrupting. A non-chunked message (no
// chunk field) interrupts as before.

const chunkQueue: ArrayBuffer[] = []
let draining = false

async function drainChunkQueue(): Promise<void> {
  if (draining) return
  draining = true
  isPlaying = true
  while (chunkQueue.length > 0) {
    const wavData = chunkQueue.shift()!
    await playOnce(wavData)
  }
  draining = false
  isPlaying = false
}

/** Play a single WAV buffer and resolve when it finishes. */
function playOnce(wavData: ArrayBuffer): Promise<void> {
  return new Promise<void>((resolve) => {
    const ctx = getAudioContext()
    ctx
      .decodeAudioData(wavData.slice(0))
      .then((audioBuffer) => {
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(ctx.destination)
        currentSource = source
        source.onended = () => {
          if (currentSource === source) currentSource = null
          resolve()
        }
        source.start()
      })
      .catch((err) => {
        console.error('[tts-player] chunk decode/play failed:', err)
        resolve() // Skip failed chunk, continue queue
      })
  })
}

/** Play a WAV audio buffer through the Web Audio API.
 *  Handles both single-shot messages (interrupt) and streamed chunks
 *  (queue sequentially). Any message carrying a `chunk` field enters
 *  queue mode — chunk.index 0 interrupts prior playback, subsequent
 *  chunks append to the queue. Messages without `chunk` interrupt
 *  immediately (acks, single-shot synthesis). */
async function playAudio(wavData: ArrayBuffer, chunk?: { index: number; total: number; done: boolean }): Promise<void> {
  if (chunk != null) {
    // Streaming mode — queue chunks and play sequentially.
    // First chunk interrupts any prior playback; subsequent ones queue.
    if (chunk.index === 0) {
      interruptTts()
      chunkQueue.length = 0
    }
    chunkQueue.push(wavData)
    void drainChunkQueue()
  } else {
    // Single-shot — interrupt and play immediately
    interruptTts()
    chunkQueue.length = 0

    const ctx = getAudioContext()
    try {
      const audioBuffer = await ctx.decodeAudioData(wavData.slice(0))
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)

      currentSource = source
      isPlaying = true

      source.onended = () => {
        if (currentSource === source) {
          currentSource = null
          isPlaying = false
        }
      }

      source.start()
    } catch (err) {
      console.error('[tts-player] audio decode/play failed:', err)
      isPlaying = false
    }
  }
}

export interface TtsAudioMessage {
  threadId?: string
  kind?: string
  text?: string
  audio?: string
  chunk?: { index: number; total: number; done: boolean }
}

/** Handle one voice.tts.audio message that carries audio: decode and play. */
function handleIncomingAudio(msg: TtsAudioMessage): void {
  // Start the media keep-alive on first TTS playback — the voice
  // interaction serves as the user gesture that satisfies autoplay policy.
  if (!isKeepAliveActive()) startMediaKeepAlive()

  // Show the spoken text on the lock screen / notification shade
  if (msg.text) updateNowPlaying(msg.text)

  const wavData = base64ToArrayBuffer(msg.audio as string)
  void playAudio(wavData, msg.chunk)
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

/** Play base64-encoded WAV audio directly (single-shot, interrupts any
 *  current playback). Used by the on-demand "Play aloud" context menu. */
export async function playBase64Audio(base64: string): Promise<void> {
  interruptTts()
  chunkQueue.length = 0

  if (!isKeepAliveActive()) startMediaKeepAlive()

  const wavData = base64ToArrayBuffer(base64)
  await playAudio(wavData)
}

/** Reports whether TTS audio currently plays. */
export function isTtsPlaying(): boolean {
  return isPlaying
}
