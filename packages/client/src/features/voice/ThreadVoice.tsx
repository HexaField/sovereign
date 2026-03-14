// Thread voice controls — §8.9.3

export interface ThreadVoiceProps {
  onStartRecording?: () => void
  onStopRecording?: () => void
  onToggleVoiceMode?: () => void
  onPlayTts?: (messageId: string) => void
  isRecording?: boolean
  isTranscribing?: boolean
  voiceModeEnabled?: boolean
}

export function micButtonClass(recording: boolean): string {
  return recording ? 'text-red-500 animate-pulse' : 'text-[var(--c-text-muted)]'
}

export function voiceModeLabel(enabled: boolean): string {
  return enabled ? 'Voice Mode' : 'Text Mode'
}

export function transcribingIndicator(active: boolean): string {
  return active ? 'Transcribing…' : ''
}

export function ThreadVoice(props: ThreadVoiceProps) {
  return (
    <div class="flex items-center gap-2">
      {/* Mic button */}
      <button
        class={`rounded-full p-2 transition-colors ${micButtonClass(!!props.isRecording)}`}
        style={{ background: 'var(--c-bg-raised)' }}
        onClick={() => (props.isRecording ? props.onStopRecording?.() : props.onStartRecording?.())}
        title={props.isRecording ? 'Stop recording' : 'Start recording'}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      </button>

      {/* Voice mode toggle */}
      <button
        class="rounded px-2 py-1 text-xs font-medium"
        style={{
          background: props.voiceModeEnabled ? 'var(--c-accent)' : 'var(--c-bg-raised)',
          color: props.voiceModeEnabled ? 'white' : 'var(--c-text-muted)'
        }}
        onClick={() => props.onToggleVoiceMode?.()}
      >
        {voiceModeLabel(!!props.voiceModeEnabled)}
      </button>

      {/* Transcribing indicator */}
      {props.isTranscribing && (
        <span class="animate-pulse text-xs" style={{ color: 'var(--c-accent)' }}>
          {transcribingIndicator(true)}
        </span>
      )}
    </div>
  )
}
