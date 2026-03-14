// Meeting card — §8.9.1
import type { Meeting } from './store.js'

export interface MeetingCardProps {
  meeting: Meeting
  expanded?: boolean
  onToggleExpand?: () => void
  onClick?: () => void
}

export function statusBadgeClass(hasIt: boolean): string {
  return hasIt ? 'bg-green-600 text-white' : 'bg-gray-600 text-gray-300'
}

export function statusBadgeText(kind: 'transcript' | 'summary', has: boolean): string {
  if (kind === 'transcript') return has ? 'Transcript ✓' : 'No Transcript'
  return has ? 'Summary ✓' : 'No Summary'
}

export function formatCardDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatCardDuration(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}m`
}

export function MeetingCard(props: MeetingCardProps) {
  const m = () => props.meeting
  return (
    <div
      class="cursor-pointer rounded-lg border p-3 transition-colors hover:border-[var(--c-accent)]"
      style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
      onClick={() => props.onClick?.()}
    >
      <div class="flex items-center justify-between">
        <h4 class="font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          {m().title}
        </h4>
        <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          {formatCardDate(m().date)}
        </span>
      </div>
      <div class="mt-1 flex items-center gap-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
        <span>{formatCardDuration(m().durationMs)}</span>
        <span>·</span>
        <span>
          {m().participants.length} participant{m().participants.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div class="mt-2 flex gap-1">
        <span class={`rounded px-1.5 py-0.5 text-[10px] ${statusBadgeClass(m().hasTranscript)}`}>
          {statusBadgeText('transcript', m().hasTranscript)}
        </span>
        <span class={`rounded px-1.5 py-0.5 text-[10px] ${statusBadgeClass(m().hasSummary)}`}>
          {statusBadgeText('summary', m().hasSummary)}
        </span>
      </div>
      {props.expanded && m().summary && (
        <p class="mt-2 text-xs leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>
          {m().summary}
        </p>
      )}
    </div>
  )
}
