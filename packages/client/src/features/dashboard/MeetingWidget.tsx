// Meeting dashboard widget — §8.9.4
import type { Meeting, ActionItem } from '../meetings/store.js'

export interface MeetingWidgetProps {
  recentMeetings: Meeting[]
  pendingCount: number
  totalHours: number
  openActionItems: ActionItem[]
}

export function formatHours(h: number | null | undefined): string {
  if (h == null || isNaN(h)) return '0m'
  return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`
}

export function attentionItems(items: ActionItem[] | null | undefined): ActionItem[] {
  if (!items) return []
  const now = Date.now()
  return items.filter((ai) => !ai.done && (!ai.dueDate || new Date(ai.dueDate).getTime() < now))
}

export function MeetingWidget(props: MeetingWidgetProps) {
  return (
    <div class="rounded-lg border p-4" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-3 text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Meetings
      </h3>

      {/* Stats row */}
      <div class="mb-3 flex gap-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
        <span>{formatHours(props.totalHours)} this week</span>
        {props.pendingCount > 0 && <span>{props.pendingCount} pending</span>}
        {(props.openActionItems?.length ?? 0) > 0 && <span>{props.openActionItems.length} action items</span>}
      </div>

      {/* Recent meetings */}
      <div class="flex flex-col gap-1.5">
        {(props.recentMeetings ?? []).slice(0, 5).map((m) => (
          <div class="flex items-center justify-between text-xs">
            <span class="truncate font-medium" style={{ color: 'var(--c-text)' }}>
              {m.title}
            </span>
            <span style={{ color: 'var(--c-text-muted)' }}>{Math.floor(m.durationMs / 60000)}m</span>
          </div>
        ))}
      </div>

      {/* Attention items */}
      {attentionItems(props.openActionItems).length > 0 && (
        <div class="mt-3 border-t pt-2" style={{ 'border-color': 'var(--c-border)' }}>
          <p class="mb-1 text-[10px] font-medium uppercase" style={{ color: 'var(--c-danger, #ef4444)' }}>
            Needs Attention
          </p>
          {attentionItems(props.openActionItems)
            .slice(0, 3)
            .map((ai) => (
              <p class="truncate text-xs" style={{ color: 'var(--c-text)' }}>
                {ai.text}
              </p>
            ))}
        </div>
      )}
    </div>
  )
}
