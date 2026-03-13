import { Show } from 'solid-js'
import {
  voiceState,
  setVoiceState,
  voiceStatusText,
  setVoiceStatusText,
  voiceTranscriptHtml,
  setVoiceTranscriptHtml,
  voiceTimerText,
  setVoiceTimerText,
  setIsRecording,
  setMediaRecorder,
  getMediaRecorder,
  setAudioChunks,
  getAudioChunks,
  pushAudioChunk,
  setRecordTimer,
  getRecordTimer,
  setRecordStart,
  getRecordStart,
  interruptPlayback
} from './store.js'
import { escapeHtml } from '../../lib/markdown.js'
import { sendMessage } from '../chat/store.js'

// ── Exported helpers (used by tests) ─────────────────────────────────
export function getVoiceButtonStyle(state: string): { border: string; animation: string } {
  switch (state) {
    case 'listening':
      return { border: 'var(--c-accent)', animation: 'animate-mic-pulse 1.5s ease-in-out infinite' }
    case 'speaking':
      return { border: 'var(--c-accent)', animation: 'animate-speak-pulse 1.5s ease-in-out infinite' }
    case 'processing':
      return { border: 'var(--c-border)', animation: 'none' }
    default: // idle
      return { border: 'var(--c-border)', animation: 'none' }
  }
}

export function getVoiceStatusText(state: string): string {
  switch (state) {
    case 'listening':
      return 'Listening…'
    case 'speaking':
      return 'Speaking…'
    case 'processing':
      return 'Processing…'
    default:
      return 'Tap to speak'
  }
}

export function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData()
  form.append('audio', blob)
  try {
    const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form })
    const data = await res.json()
    return data.text || ''
  } catch {
    return ''
  }
}

export function VoiceView() {
  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setAudioChunks([])
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      })
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) pushAudioChunk(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        processVoiceRecording()
      }
      recorder.start(100)
      setMediaRecorder(recorder)
      setIsRecording(true)
      setRecordStart(Date.now())
      setVoiceState('listening')
      setVoiceStatusText('Listening…')
      setVoiceTimerText('0:00')
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - getRecordStart()) / 1000)
        setVoiceTimerText(`${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`)
      }, 200)
      setRecordTimer(timer)
    } catch {
      setVoiceState('idle')
      setVoiceStatusText('Microphone denied')
    }
  }

  const stopVoiceRecording = () => {
    const recorder = getMediaRecorder()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    setIsRecording(false)
    const timer = getRecordTimer()
    if (timer) clearInterval(timer)
    setRecordTimer(null)
    setVoiceTimerText('')
  }

  const processVoiceRecording = async () => {
    const chunks = getAudioChunks()
    if (chunks.length === 0) {
      setVoiceState('idle')
      setVoiceStatusText('Tap to speak')
      return
    }
    setVoiceState('processing')
    setVoiceStatusText('Transcribing…')
    const blob = new Blob(chunks, { type: 'audio/webm' })
    setAudioChunks([])
    try {
      const text = await transcribeAudio(blob)
      if (!text) {
        setVoiceState('idle')
        setVoiceStatusText('No speech detected')
        return
      }
      setVoiceTranscriptHtml(`<span style="color:var(--c-text)">You:</span> ` + escapeHtml(text))
      setVoiceState('processing')
      setVoiceStatusText('Thinking…')
      sendMessage(text)
    } catch (e) {
      setVoiceState('idle')
      setVoiceStatusText('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const voiceBtnTap = () => {
    const state = voiceState()
    if (state === 'idle') startVoiceRecording()
    else if (state === 'listening') stopVoiceRecording()
    else if (state === 'speaking') interruptPlayback()
  }

  const btnStyle = () => {
    const state = voiceState()
    const base: Record<string, string> = {}
    if (state === 'listening') {
      base['border-color'] = 'var(--c-danger)'
      base.background = 'var(--c-rec-bg)'
      base.color = 'var(--c-danger)'
    } else if (state === 'speaking') {
      base['border-color'] = 'var(--c-accent)'
      base.background = 'color-mix(in srgb, var(--c-accent) 15%, transparent)'
      base.color = 'var(--c-accent)'
    } else if (state === 'processing') {
      base['border-color'] = 'var(--c-text-muted)'
      base.background = 'var(--c-bg-raised)'
      base.color = 'var(--c-text-muted)'
    } else {
      base['border-color'] = 'var(--c-border)'
      base.background = 'var(--c-bg-raised)'
      base.color = 'var(--c-text-muted)'
    }
    return base
  }

  return (
    <div
      class="flex flex-1 flex-col items-center justify-center gap-7 px-5 py-10 text-center"
      classList={{ listening: voiceState() === 'listening', speaking: voiceState() === 'speaking' }}
    >
      <div
        class="text-5xl transition-opacity duration-300"
        classList={{
          'opacity-60': voiceState() === 'idle' || voiceState() === 'processing',
          'opacity-100': voiceState() === 'listening' || voiceState() === 'speaking'
        }}
      >
        ⬡
      </div>

      <div
        class="min-h-6 text-[15px] transition-colors duration-300"
        style={{
          color:
            voiceState() === 'listening'
              ? 'var(--c-danger)'
              : voiceState() === 'speaking'
                ? 'var(--c-accent)'
                : 'var(--c-text-muted)'
        }}
      >
        {voiceStatusText()}
      </div>

      <button
        class="tap-highlight-none flex h-[140px] w-[140px] cursor-pointer items-center justify-center rounded-full border-[3px] transition-all select-none active:scale-95"
        classList={{
          'animate-voice-pulse': voiceState() === 'listening',
          'animate-speak-pulse': voiceState() === 'speaking',
          'cursor-wait': voiceState() === 'processing'
        }}
        style={btnStyle()}
        onClick={voiceBtnTap}
      >
        <Show
          when={voiceState() !== 'speaking'}
          fallback={
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          }
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        </Show>
      </button>

      <div class="min-h-5 text-[13px] tabular-nums" style={{ color: 'var(--c-danger)' }}>
        {voiceTimerText()}
      </div>
      <div
        class="min-h-10 max-w-[300px] text-[13px] leading-relaxed"
        style={{ color: 'var(--c-text-muted)' }}
        innerHTML={voiceTranscriptHtml()}
      />
    </div>
  )
}
