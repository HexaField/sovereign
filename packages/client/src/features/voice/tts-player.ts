// TTS audio player — receives voice.tts.audio JSON messages from the
// server and plays them through the Web Audio API.
//
// The server sends WAV audio as base64-encoded JSON on the chat WS
// channel. This module decodes and plays it, with support for
// interrupting the current playback when a new frame arrives.
//
// The server now routes TTS by device NAME, not deviceId (a page refresh
// mints a fresh deviceId, so name-based routing survives the refresh).
// One side effect: every open tab that announces the same device name
// receives the same audio message. The lock below picks exactly one tab
// to play it, using a BroadcastChannel race so the tabs need no shared
// server state to agree on a winner.

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
 *  (queue sequentially). */
async function playAudio(wavData: ArrayBuffer, chunk?: { index: number; total: number; done: boolean }): Promise<void> {
  if (chunk && chunk.total > 1) {
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

// ── Cross-tab playback lock ─────────────────────────────────────────────
//
// Every tab sharing a device name receives the same voice.tts.audio
// message. Each tab computes a claim key for the clip, then races its
// peers on a BroadcastChannel: wait a short window for a rival's claim
// broadcast; if none lands, declare a win and broadcast the claim so
// later peers back off. A crude heuristic, not a strict distributed
// lock — a rare exact-tie remains possible — but it turns "every tab
// speaks at once" into "one tab speaks" for the overwhelming majority
// of cases.

const TTS_LOCK_CHANNEL = 'sovereign-tts-lock'
const CLAIM_WINDOW_MS = 50
// Bounds how long a claim key lingers if this tab never consumes it
// (e.g. this tab never received that particular broadcast) — keeps the
// set from growing across a long-lived tab.
const CLAIM_TTL_MS = 2000

let lockChannel: BroadcastChannel | null = null
const claimedKeys = new Set<string>()

function getLockChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!lockChannel) {
    lockChannel = new BroadcastChannel(TTS_LOCK_CHANNEL)
    lockChannel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; key?: string } | null
      if (!data || data.type !== 'claim' || !data.key) return
      const key = data.key
      claimedKeys.add(key)
      setTimeout(() => claimedKeys.delete(key), CLAIM_TTL_MS)
    }
  }
  return lockChannel
}

/** Build a short, stable digest from a string — good enough to dedupe
 *  identical TTS payloads across tabs without shipping the full text
 *  through the lock channel. */
function hashText(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

export interface TtsAudioMessage {
  threadId?: string
  kind?: string
  text?: string
  audio?: string
  chunk?: { index: number; total: number; done: boolean }
}

/** Derive the claim key for a TTS payload. threadId + kind + a hash of
 *  the spoken text together identify one clip: every tab that receives
 *  the literal same broadcast computes the identical key, while two
 *  genuinely distinct clips (different text) never collide. Exported so
 *  tests can compute a matching key to simulate a rival tab's claim. */
export function claimKeyFor(msg: TtsAudioMessage): string {
  const threadId = typeof msg.threadId === 'string' ? msg.threadId : ''
  const kind = typeof msg.kind === 'string' ? msg.kind : ''
  const text = typeof msg.text === 'string' ? msg.text : ''
  return `${threadId}:${kind}:${hashText(text)}`
}

/** Race every tab on this device for the right to play one TTS clip.
 *  Resolves true for the winner (proceed with playback), false for
 *  every tab that hears a rival's claim first (skip). Environments
 *  without BroadcastChannel support always win — dedup never applies
 *  there, so falling back to "play locally" beats staying silent. */
async function claimPlayback(key: string): Promise<boolean> {
  const channel = getLockChannel()
  if (!channel) return true

  if (claimedKeys.has(key)) {
    claimedKeys.delete(key)
    return false
  }

  // Small random jitter spreads out same-tick claims across tabs so two
  // rivals rarely broadcast at the exact same instant.
  const jitterMs = Math.random() * 20
  await new Promise((resolve) => setTimeout(resolve, CLAIM_WINDOW_MS + jitterMs))

  if (claimedKeys.has(key)) {
    claimedKeys.delete(key)
    return false
  }

  channel.postMessage({ type: 'claim', key })
  return true
}

/** Handle one voice.tts.audio message: claim playback rights against
 *  sibling tabs, then decode and play only on a win. */
async function handleIncomingAudio(msg: TtsAudioMessage): Promise<void> {
  const key = claimKeyFor(msg)
  const wins = await claimPlayback(key)
  if (!wins) {
    console.log(`[tts-player] a sibling tab already claims playback for ${key} — skipping`)
    return
  }

  // Start the media keep-alive on first TTS playback — the voice
  // interaction serves as the user gesture that satisfies autoplay policy.
  if (!isKeepAliveActive()) startMediaKeepAlive()

  // Show the spoken text on the lock screen / notification shade
  if (msg.text) updateNowPlaying(msg.text)

  const wavData = base64ToArrayBuffer(msg.audio as string)
  void playAudio(wavData, msg.chunk)
}

/** Wire up the TTS player to listen for voice.tts.audio messages.
 *  Call once at app startup. Returns a cleanup function. */
export function initTtsPlayer(ws: WsStore): () => void {
  if (cleanup) cleanup() // idempotent re-init

  // Listen for TTS audio messages (base64-encoded WAV in JSON)
  const unsubAudio = ws.on('voice.tts.audio', (msg: any) => {
    if (!msg.audio) return
    console.log(`[tts-player] ${msg.kind ?? 'audio'}: "${msg.text?.slice(0, 60) ?? ''}"`)
    void handleIncomingAudio(msg)
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

/** Reports whether TTS audio currently plays. */
export function isTtsPlaying(): boolean {
  return isPlaying
}
