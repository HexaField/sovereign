import { Show } from 'solid-js'
import type { VoiceState } from './store.js'

export function getVoiceButtonStyle(state: VoiceState): { border: string; animation: string } {
  switch (state) {
    case 'idle':
      return { border: 'var(--c-border)', animation: 'none' }
    case 'listening':
      return { border: 'var(--c-accent)', animation: 'animate-mic-pulse 1.5s ease-in-out infinite' }
    case 'processing':
      return { border: 'var(--c-border)', animation: 'none' }
    case 'speaking':
      return { border: 'var(--c-accent)', animation: 'animate-speak-pulse 1.5s ease-in-out infinite' }
    default:
      return { border: 'var(--c-border)', animation: 'none' }
  }
}

export function getVoiceStatusText(state: VoiceState): string {
  switch (state) {
    case 'idle':
      return 'Tap to speak'
    case 'listening':
      return 'Listening…'
    case 'processing':
      return 'Processing…'
    case 'speaking':
      return 'Speaking…'
    default:
      return ''
  }
}

export function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export interface VoiceViewProps {
  state: () => VoiceState
  recordingMs: () => number
  onStart: () => void
  onStop: () => void
  onInterrupt: () => void
}

export function VoiceView(props: VoiceViewProps) {
  const handleClick = () => {
    const s = props.state()
    if (s === 'speaking') {
      props.onInterrupt()
    } else if (s === 'listening') {
      props.onStop()
    } else if (s === 'idle') {
      props.onStart()
    }
  }

  const style = () => getVoiceButtonStyle(props.state())
  const icon = () => {
    switch (props.state()) {
      case 'idle':
        return '🎤'
      case 'listening':
        return '🎤'
      case 'processing':
        return '⏳'
      case 'speaking':
        return '🔊'
      default:
        return '🎤'
    }
  }

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-6">
      <button
        class="flex h-20 w-20 items-center justify-center rounded-full text-3xl md:h-20 md:w-20"
        style={{
          'min-width': '120px',
          'min-height': '120px',
          border: `3px solid ${style().border}`,
          animation: style().animation,
          background: 'var(--c-bg-raised)'
        }}
        onClick={handleClick}
      >
        {icon()}
      </button>
      <div class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
        {getVoiceStatusText(props.state())}
      </div>
      <Show when={props.state() === 'listening'}>
        <div class="text-xs tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
          {formatRecordingTime(props.recordingMs())}
        </div>
      </Show>
    </div>
  )
}
