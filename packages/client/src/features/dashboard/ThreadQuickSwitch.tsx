import { QUICK_SWITCH_LIMIT } from './dashboard-helpers'

export function ThreadQuickSwitch() {
  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Quick Switch (⌘K)
      </h3>
      <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
        {QUICK_SWITCH_LIMIT} most recent threads — press ⌘K to search
      </p>
    </div>
  )
}
