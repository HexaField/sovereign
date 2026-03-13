export function ActivityFeed() {
  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Activity
      </h3>
      <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
        No recent activity
      </p>
    </div>
  )
}
