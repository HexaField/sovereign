import { createSignal } from 'solid-js'

export type VoiceState = 'idle' | 'listening' | 'speaking' | 'processing'

export const [voiceState, setVoiceState] = createSignal<VoiceState>('idle')
const STATUS_MAP: Record<VoiceState, string> = {
  idle: 'Tap to speak',
  listening: 'Listening…',
  processing: 'Processing…',
  speaking: 'Speaking…'
}
// voiceStatusText is derived from voiceState by default; setVoiceStatusText is kept for compat but unused
export function voiceStatusText(): string {
  return STATUS_MAP[voiceState()]
}
export function setVoiceStatusText(_text: string): void {
  // no-op — status derived from voiceState
}
export const [voiceTranscriptHtml, setVoiceTranscriptHtml] = createSignal('')
export const [voiceTimerText, setVoiceTimerText] = createSignal('')
export const [isAudioPlaying, setIsAudioPlaying] = createSignal(false)
export function isRecording(): boolean {
  return voiceState() === 'listening'
}

// Keep setIsRecording for compat but it's a no-op (state derived from voiceState)
export function setIsRecording(_v: boolean): void {}

const [recordingSeconds, setRecordingSeconds] = createSignal(0)
export function recordingTimerText(): string {
  const s = recordingSeconds()
  const min = Math.floor(s / 60)
    .toString()
    .padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${min}:${sec}`
}

let mediaRecorder: any = null
let audioChunks: Blob[] = []
let timerInterval: ReturnType<typeof setInterval> | null = null
let fastTimerInterval: ReturnType<typeof setInterval> | null = null
let audioElement: HTMLAudioElement | null = null
let recordStart = 0

function startTimer(): void {
  setRecordingSeconds(0)
  recordStart = Date.now()
  setVoiceTimerText('0:00')
  // 1s timer for recordingSeconds (tests depend on this)
  timerInterval = setInterval(() => setRecordingSeconds((s) => s + 1), 1000)
  // 200ms timer for voiceTimerText (smoother UI, voice-ui style)
  fastTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000)
    setVoiceTimerText(`${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`)
  }, 200)
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  if (fastTimerInterval) {
    clearInterval(fastTimerInterval)
    fastTimerInterval = null
  }
  setRecordingSeconds(0)
  setVoiceTimerText('')
}

export function getMediaRecorder(): any {
  return mediaRecorder
}
export function setMediaRecorder(r: any): void {
  mediaRecorder = r
}
export function getAudioChunks(): Blob[] {
  return audioChunks
}
export function setAudioChunks(c: Blob[]): void {
  audioChunks = c
}
export function pushAudioChunk(chunk: Blob): void {
  audioChunks.push(chunk)
}
export function getRecordTimer(): ReturnType<typeof setInterval> | null {
  return timerInterval
}
export function setRecordTimer(t: ReturnType<typeof setInterval> | null): void {
  timerInterval = t
}
export function getRecordStart(): number {
  return recordStart
}
export function setRecordStart(t: number): void {
  recordStart = t
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
  mediaRecorder.start(100)
  setIsRecording(true)
  setVoiceState('listening')
  setVoiceStatusText('Listening…')
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

  setIsRecording(false)
  stopTimer()
  setVoiceState('processing')
  setVoiceStatusText('Transcribing…')

  const form = new FormData()
  form.append('audio', blob)

  try {
    const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form })
    const data = await res.json()
    setVoiceState('idle')
    setVoiceStatusText('Tap to speak')
    return data.text
  } catch {
    setVoiceState('idle')
    setVoiceStatusText('Tap to speak')
  }
}

export function interruptPlayback(): void {
  if (audioElement) {
    audioElement.pause()
    audioElement.currentTime = 0
    audioElement = null
  }
  setVoiceState('idle')
  setVoiceStatusText('Tap to speak')
  setIsAudioPlaying(false)
}
