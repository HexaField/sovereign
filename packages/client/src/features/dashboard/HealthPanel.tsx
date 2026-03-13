export function HealthPanel() {
  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        System Health
      </h3>
      <div class="flex items-center gap-2">
        <span class="inline-block h-2 w-2 rounded-full bg-green-500" />
        <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          All services operational
        </span>
      </div>
    </div>
  )
}
