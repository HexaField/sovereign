import { createSignal } from 'solid-js'

export type VoiceState = 'idle' | 'listening' | 'speaking' | 'processing'

export const [voiceState, setVoiceState] = createSignal<VoiceState>('idle')
export function isRecording(): boolean {
  return voiceState() === 'listening'
}

const [recordingSeconds, setRecordingSeconds] = createSignal(0)
export function recordingTimerText(): string {
  const s = recordingSeconds()
  const min = Math.floor(s / 60)
    .toString()
    .padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${min}:${sec}`
}

const STATUS_MAP: Record<VoiceState, string> = {
  idle: 'Tap to speak',
  listening: 'Listening…',
  processing: 'Processing…',
  speaking: 'Speaking…'
}
export function voiceStatusText(): string {
  return STATUS_MAP[voiceState()]
}

let mediaRecorder: any = null
let audioChunks: Blob[] = []
let timerInterval: ReturnType<typeof setInterval> | null = null
let audioElement: HTMLAudioElement | null = null

function startTimer(): void {
  setRecordingSeconds(0)
  timerInterval = setInterval(() => setRecordingSeconds((s) => s + 1), 1000)
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  setRecordingSeconds(0)
}

export async function startRecording(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const MR = (globalThis as any).MediaRecorder
  const mimeType = MR.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  mediaRecorder = new MR(stream, { mimeType })
  audioChunks = []
  mediaRecorder.ondataavailable = (e: any) => {
    if (e.data?.size > 0) audioChunks.push(e.data)
  }
  mediaRecorder.start()
  setVoiceState('listening')
  startTimer()
}

export async function stopRecording(): Promise<any> {
  if (!mediaRecorder) return

  const blob = await new Promise<Blob>((resolve) => {
    mediaRecorder.onstop = () => {
      resolve(new Blob(audioChunks, { type: 'audio/webm' }))
    }
    mediaRecorder.stop()
  })

  stopTimer()
  setVoiceState('processing')

  const form = new FormData()
  form.append('audio', blob)

  try {
    const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form })
    const data = await res.json()
    setVoiceState('idle')
    return data.text
  } catch {
    setVoiceState('idle')
  }
}

export function interruptPlayback(): void {
  if (audioElement) {
    audioElement.pause()
    audioElement.currentTime = 0
    audioElement = null
  }
  setVoiceState('idle')
}
