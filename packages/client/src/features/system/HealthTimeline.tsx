// §P.1.3 HealthTimeline — vertical timeline of system health events with stats summary
// Ported from voice-ui HealthTimeline.tsx, adapted for Sovereign architecture

import { type Component, createSignal, onMount, onCleanup, For, Show } from 'solid-js'

export interface HealthEvent {
  type: string
  timestamp: string
  summary: string
  details?: string
  severity: 'info' | 'warning' | 'error'
}

export interface HealthTimelineData {
  uptime: { startedAt: string; uptimeMs: number }
  events: HealthEvent[]
  stats: {
    totalCronRuns24h: number
    totalErrors24h: number
    totalWebhooks24h: number
    avgCronDurationMs: number
  }
}

export interface HealthSnapshot {
  timestamp: number
  cpu: number
  memory: number
  disk: number
  loadAvg: number
  uptimeSec: number
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

const typeIcons: Record<string, string> = {
  restart: '🔄',
  compaction: '📦',
  'cron-run': '⏰',
  error: '❌',
  session: '💬',
  webhook: '📨'
}

const severityColors: Record<string, string> = {
  info: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444'
}

const METRIC_COLORS = {
  cpu: '#3b82f6',
  memory: '#a855f7',
  loadAvg: '#f59e0b'
}

async function fetchHealthHistory(windowMs: number): Promise<HealthSnapshot[]> {
  try {
    const res = await fetch(`/api/system/health/history?window=${windowMs}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.snapshots || []
  } catch {
    return []
  }
}

async function fetchHealthTimeline(): Promise<HealthTimelineData | null> {
  try {
    const res = await fetch('/api/system/health')
    if (!res.ok) return null
    const health = await res.json()
    // Transform the health endpoint data into timeline format
    const startTime = Date.now() - (health.connection?.uptime ?? 0) * 1000
    return {
      uptime: { startedAt: new Date(startTime).toISOString(), uptimeMs: (health.connection?.uptime ?? 0) * 1000 },
      events: (health.errors?.recent ?? []).map((e: { message: string; timestamp: string }) => ({
        type: 'error',
        timestamp: e.timestamp,
        summary: e.message,
        severity: 'error' as const
      })),
      stats: {
        totalCronRuns24h: health.jobs?.active ?? 0,
        totalErrors24h: health.errors?.countLastHour ?? 0,
        totalWebhooks24h: 0,
        avgCronDurationMs: 0
      }
    }
  } catch {
    return null
  }
}

function MiniChart(props: {
  snapshots: HealthSnapshot[]
  metric: keyof HealthSnapshot
  color: string
  label: string
  max?: number
}) {
  const width = 280
  const height = 60
  const padding = { top: 4, right: 4, bottom: 14, left: 4 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom

  const path = () => {
    const snaps = props.snapshots
    if (snaps.length < 2) return ''
    const maxVal = props.max ?? Math.max(...snaps.map((s) => s[props.metric] as number), 1)
    const points = snaps.map((s, i) => {
      const x = padding.left + (i / (snaps.length - 1)) * chartW
      const y = padding.top + chartH - ((s[props.metric] as number) / maxVal) * chartH
      return `${x},${y}`
    })
    return `M ${points.join(' L ')}`
  }

  const current = () => {
    const snaps = props.snapshots
    if (!snaps.length) return '—'
    const val = snaps[snaps.length - 1][props.metric] as number
    return props.metric === 'loadAvg' ? val.toFixed(2) : `${val}%`
  }

  return (
    <div class="rounded-lg border p-2" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[10px] font-semibold tracking-wider uppercase" style={{ color: props.color }}>
          {props.label}
        </span>
        <span class="font-mono text-xs" style={{ color: 'var(--c-text)' }}>
          {current()}
        </span>
      </div>
      <svg width={width} height={height} class="w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path d={path()} fill="none" stroke={props.color} stroke-width="1.5" opacity="0.8" />
      </svg>
    </div>
  )
}

const HealthTimeline: Component = () => {
  const [data, setData] = createSignal<HealthTimelineData | null>(null)
  const [snapshots, setSnapshots] = createSignal<HealthSnapshot[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [range, setRange] = createSignal<'1h' | '24h'>('1h')
  const [expanded, setExpanded] = createSignal<Set<number>>(new Set())

  async function loadData() {
    try {
      const [timeline, history] = await Promise.all([
        fetchHealthTimeline(),
        fetchHealthHistory(range() === '1h' ? 3600_000 : 86400_000)
      ])
      if (timeline) setData(timeline)
      setSnapshots(history)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    loadData()
  })
  const interval = setInterval(loadData, 30000)
  onCleanup(() => clearInterval(interval))

  function toggleExpand(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function filteredEvents() {
    const d = data()
    if (!d) return []
    const cutoff = range() === '1h' ? 3600_000 : 86400_000
    const now = Date.now()
    return d.events.filter((e) => now - new Date(e.timestamp).getTime() < cutoff)
  }

  return (
    <div class="space-y-4">
      <Show when={loading() && !data()}>
        <div class="py-8 text-center text-sm opacity-50">Loading health data…</div>
      </Show>

      <Show when={error() && !data()}>
        <div class="py-8 text-center text-sm text-red-400">{error()}</div>
      </Show>

      <Show when={data()}>
        {(d) => (
          <>
            {/* Resource charts */}
            <Show when={snapshots().length > 1}>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <MiniChart snapshots={snapshots()} metric="cpu" color={METRIC_COLORS.cpu} label="CPU" max={100} />
                <MiniChart
                  snapshots={snapshots()}
                  metric="memory"
                  color={METRIC_COLORS.memory}
                  label="Memory"
                  max={100}
                />
                <MiniChart snapshots={snapshots()} metric="loadAvg" color={METRIC_COLORS.loadAvg} label="Load Avg" />
              </div>
            </Show>

            {/* Stats summary */}
            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div
                class="rounded-lg border p-3 text-center"
                style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
              >
                <div class="text-2xl font-bold" style={{ color: 'var(--c-accent)' }}>
                  {d().stats.totalCronRuns24h}
                </div>
                <div class="text-[10px] tracking-wider uppercase opacity-60">Cron Runs (24h)</div>
              </div>
              <div
                class="rounded-lg border p-3 text-center"
                style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
              >
                <div
                  class="text-2xl font-bold"
                  style={{ color: d().stats.totalErrors24h > 0 ? '#ef4444' : 'var(--c-text)' }}
                >
                  {d().stats.totalErrors24h}
                </div>
                <div class="text-[10px] tracking-wider uppercase opacity-60">Errors (24h)</div>
              </div>
              <div
                class="rounded-lg border p-3 text-center"
                style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
              >
                <div class="text-2xl font-bold">{d().stats.totalWebhooks24h}</div>
                <div class="text-[10px] tracking-wider uppercase opacity-60">Webhooks (24h)</div>
              </div>
              <div
                class="rounded-lg border p-3 text-center"
                style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
              >
                <div class="text-2xl font-bold">
                  {d().stats.avgCronDurationMs > 0 ? `${(d().stats.avgCronDurationMs / 1000).toFixed(1)}s` : '—'}
                </div>
                <div class="text-[10px] tracking-wider uppercase opacity-60">Avg Cron Duration</div>
              </div>
            </div>

            {/* Uptime bar */}
            <div
              class="flex items-center gap-3 rounded-lg border px-4 py-2 text-[11px]"
              style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
            >
              <span class="opacity-60">Server uptime:</span>
              <span class="font-mono">{formatDuration(d().uptime.uptimeMs)}</span>
              <span class="opacity-60">since {new Date(d().uptime.startedAt).toLocaleString()}</span>
            </div>

            {/* Range toggle */}
            <div class="flex items-center gap-2">
              <button
                class="cursor-pointer rounded-md px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  background: range() === '1h' ? 'var(--c-accent)' : 'transparent',
                  color: range() === '1h' ? 'white' : 'var(--c-text)'
                }}
                onClick={() => {
                  setRange('1h')
                  loadData()
                }}
              >
                1h
              </button>
              <button
                class="cursor-pointer rounded-md px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  background: range() === '24h' ? 'var(--c-accent)' : 'transparent',
                  color: range() === '24h' ? 'white' : 'var(--c-text)'
                }}
                onClick={() => {
                  setRange('24h')
                  loadData()
                }}
              >
                24h
              </button>
              <span class="ml-2 text-[10px] opacity-60">{filteredEvents().length} events</span>
            </div>

            {/* Timeline */}
            <div class="relative pl-6">
              <div class="absolute top-0 bottom-0 left-[9px] w-px" style={{ background: 'var(--c-border)' }} />

              <Show when={filteredEvents().length === 0}>
                <div class="py-4 text-[11px] italic opacity-50">No events in this period</div>
              </Show>

              <For each={filteredEvents()}>
                {(event, idx) => (
                  <div class="relative mb-3 cursor-pointer" onClick={() => toggleExpand(idx())}>
                    <div
                      class="absolute top-1 -left-6 h-3 w-3 rounded-full"
                      style={{
                        'background-color': severityColors[event.severity] || '#6b7280',
                        border: '2px solid var(--c-bg)'
                      }}
                    />
                    <div
                      class="rounded-md border px-3 py-2 text-[11px] transition-colors"
                      style={{
                        background: event.severity === 'error' ? 'rgba(239,68,68,0.05)' : 'var(--c-bg-raised)',
                        'border-color': event.severity === 'error' ? 'rgba(239,68,68,0.3)' : 'var(--c-border)'
                      }}
                    >
                      <div class="flex items-center gap-1.5">
                        <span>{typeIcons[event.type] || '•'}</span>
                        <span class="flex-1">{event.summary}</span>
                        <span class="shrink-0 text-[10px] opacity-50">{relativeTime(event.timestamp)}</span>
                      </div>
                      <Show when={expanded().has(idx())}>
                        <div
                          class="mt-1.5 space-y-0.5 border-t pt-1.5 text-[10px] opacity-60"
                          style={{ 'border-color': 'var(--c-border)' }}
                        >
                          <div class="font-mono">{new Date(event.timestamp).toLocaleString()}</div>
                          <div>
                            Type: {event.type} · Severity: {event.severity}
                          </div>
                          <Show when={event.details}>
                            <pre
                              class="mt-1 max-h-32 overflow-y-auto rounded border p-2 font-mono text-[9px] whitespace-pre-wrap"
                              style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
                            >
                              {event.details}
                            </pre>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

export default HealthTimeline
