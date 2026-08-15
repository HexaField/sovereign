// Streaming STT client — opens a voice-stream WS channel and sends
// audio chunks from MediaRecorder in real time. Partial transcripts
// update a SolidJS signal so the textarea reflects words as spoken.

import { createSignal } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

export type StreamingState = 'idle' | 'streaming' | 'paused' | 'stopping'

const [streamingState, setStreamingState] = createSignal<StreamingState>('idle')
const [partialTranscript, setPartialTranscript] = createSignal('')

export { streamingState, partialTranscript }

let wsRef: WsStore | null = null
let recorder: MediaRecorder | null = null
let audioStream: MediaStream | null = null
let unsubTranscript: (() => void) | null = null
let unsubError: (() => void) | null = null
let timerInterval: ReturnType<typeof setInterval> | null = null
let recordStart = 0

/** Text composed before streaming started — streaming appends after this. */
let prefixText = ''

/** Accumulated transcript from completed streaming segments. When the user
 *  pauses and resumes, previous segments' final text stays here so new
 *  partial transcripts only replace the current segment's portion. */
let confirmedSegments = ''

export function initStreaming(ws: WsStore): void {
  wsRef = ws
}

/** Start streaming STT. The `currentInput` parameter captures any text
 *  already in the textarea so streaming appends after it. */
export async function startStreaming(
  currentInput: string,
  onTranscript: (fullText: string) => void,
  onTimer?: (text: string) => void
): Promise<void> {
  if (!wsRef) throw new Error('WS not initialised for streaming')
  if (streamingState() === 'streaming') return

  const resuming = streamingState() === 'paused'

  if (!resuming) {
    prefixText = currentInput
    confirmedSegments = ''
    setPartialTranscript('')
  }

  // Get microphone access (reuse stream if resuming)
  if (!audioStream || !audioStream.active) {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  }

  // Subscribe to voice-stream channel
  wsRef.subscribe(['voice-stream'])

  // Listen for transcripts
  unsubTranscript = wsRef.on('voice-stream.transcript', (msg: Record<string, unknown>) => {
    const text = (msg.text as string) ?? ''
    const isFinal = msg.final === true
    setPartialTranscript(text)

    if (isFinal) {
      // Merge final transcript into confirmed segments
      confirmedSegments += (confirmedSegments && text ? ' ' : '') + text
    }

    // Build the full composed text: prefix + confirmed segments + current partial
    const segments = confirmedSegments
    const partial = isFinal ? '' : text
    const parts = [prefixText, segments, partial].filter(Boolean)
    const composed = parts.join(prefixText && (segments || partial) ? ' ' : '')
    onTranscript(composed)
  })

  unsubError = wsRef.on('voice-stream.error', (msg: Record<string, unknown>) => {
    console.error('[streaming-stt] server error:', msg.message)
  })

  // Tell the server to start a new session
  wsRef.send({ type: 'voice-stream.start' })

  // Start recording with 100ms timeslice
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  recorder = new MediaRecorder(audioStream, { mimeType })

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0 && wsRef && streamingState() === 'streaming') {
      // Convert blob to base64 and send via WS
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        // Strip the data URL prefix to get raw base64
        const base64 = result.includes(',') ? result.split(',')[1] : result
        wsRef!.send({ type: 'voice-stream.chunk', audio: base64 })
      }
      reader.readAsDataURL(e.data)
    }
  }

  recorder.start(100)
  setStreamingState('streaming')

  // Timer for UI display
  recordStart = Date.now()
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000)
    onTimer?.(`${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`)
  }, 200)
}

/** Pause streaming — stops the microphone but keeps the session alive
 *  so the user can edit text and resume later. */
export function pauseStreaming(): void {
  if (streamingState() !== 'streaming') return

  // Stop recording
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  }
  recorder = null

  // Tell server to stop this segment (gets final transcript)
  wsRef?.send({ type: 'voice-stream.stop' })

  // Release mic
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop())
    audioStream = null
  }

  // Clean up timer
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }

  setStreamingState('paused')
}

/** Stop streaming entirely and clean up. */
export function stopStreaming(): void {
  if (streamingState() === 'idle') return

  // Stop recording
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  }
  recorder = null

  // Tell server to stop
  if (streamingState() === 'streaming') {
    wsRef?.send({ type: 'voice-stream.stop' })
  }

  // Release mic
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop())
    audioStream = null
  }

  // Clean up WS listeners
  unsubTranscript?.()
  unsubTranscript = null
  unsubError?.()
  unsubError = null
  wsRef?.unsubscribe(['voice-stream'])

  // Clean up timer
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }

  prefixText = ''
  confirmedSegments = ''
  setPartialTranscript('')
  setStreamingState('idle')
}

/** Check whether the streaming module has an active or paused session. */
export function hasActiveSession(): boolean {
  const state = streamingState()
  return state === 'streaming' || state === 'paused'
}
