// TTS audio player — receives voice.tts.audio JSON messages from the
// server and plays them through the Web Audio API.
//
// The server sends WAV audio as base64-encoded JSON on the chat WS
// channel. This module decodes and plays it, with support for
// interrupting the current playback when a new frame arrives.

import type { WsStore } from '../../ws/ws-store.js'

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

/** Play a WAV audio buffer through the Web Audio API. */
async function playAudio(wavData: ArrayBuffer): Promise<void> {
  // Interrupt any current playback
  interruptTts()

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

/** Wire up the TTS player to listen for voice.tts.audio messages.
 *  Call once at app startup. Returns a cleanup function. */
export function initTtsPlayer(ws: WsStore): () => void {
  if (cleanup) cleanup() // idempotent re-init

  // Listen for TTS audio messages (base64-encoded WAV in JSON)
  const unsubAudio = ws.on('voice.tts.audio', (msg: any) => {
    if (!msg.audio) return
    const wavData = base64ToArrayBuffer(msg.audio)
    console.log(`[tts-player] ${msg.kind ?? 'audio'}: "${msg.text?.slice(0, 60) ?? ''}"`)
    void playAudio(wavData)
  })

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
    interruptTts()
  }

  return cleanup
}

/** Whether TTS audio is currently playing. */
export function isTtsPlaying(): boolean {
  return isPlaying
}
