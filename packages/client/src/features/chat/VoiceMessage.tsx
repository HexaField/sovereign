// Voice message component — §8.5.1

export interface VoiceMessageProps {
  audioUrl: string
  transcript?: string
  durationMs?: number
}

export function formatVoiceDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const s = sec % 60
  return `${min}:${s.toString().padStart(2, '0')}`
}

export function VoiceMessage(props: VoiceMessageProps) {
  return (
    <div
      class="flex flex-col gap-1.5 rounded-lg border p-2"
      style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
    >
      <div class="flex items-center gap-2">
        <audio controls src={props.audioUrl} class="h-8 flex-1" />
        {props.durationMs && (
          <span class="text-xs tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
            {formatVoiceDuration(props.durationMs)}
          </span>
        )}
      </div>
      {props.transcript && (
        <p class="text-xs leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>
          {props.transcript}
        </p>
      )}
    </div>
  )
}
