import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'

interface HealthData {
  resources: {
    diskUsage: { used: number; total: number }
    memoryUsage: { used: number; total: number }
  }
  connection: { uptime: number }
}

interface ThermalZone {
  name: string
  type: string
  tempC: number
}

interface HealthSnapshot {
  timestamp: string
  resources: {
    memoryUsage: { used: number; total: number }
    diskUsage: { used: number; total: number }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

function Sparkline(props: { values: number[]; max: number; color: string }) {
  const width = 80
  const height = 24
  const points = () => {
    const vals = props.values
    if (vals.length < 2) return ''
    const step = width / (vals.length - 1)
    return vals
      .map((v, i) => {
        const x = i * step
        const y = height - (v / (props.max || 1)) * height
        return `${x},${y}`
      })
      .join(' ')
  }

  return (
    <svg width={width} height={height} class="shrink-0">
      <Show when={props.values.length >= 2}>
        <polyline
          points={points()}
          fill="none"
          stroke={props.color}
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </Show>
    </svg>
  )
}

function UsageBar(props: {
  label: string
  used: number
  total: number
  color: string
  sparkValues?: number[]
  sparkMax?: number
}) {
  const pct = () => (props.total > 0 ? Math.round((props.used / props.total) * 100) : 0)

  return (
    <div class="flex items-center gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between text-[11px]">
          <span style={{ color: 'var(--c-text-muted)' }}>{props.label}</span>
          <span style={{ color: 'var(--c-text)' }}>
            {formatBytes(props.used)} / {formatBytes(props.total)}
          </span>
        </div>
        <div class="mt-0.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--c-border)' }}>
          <div
            class="h-full rounded-full transition-all"
            style={{
              width: `${pct()}%`,
              background: pct() > 90 ? '#ef4444' : pct() > 75 ? '#f59e0b' : props.color
            }}
          />
        </div>
      </div>
      <Show when={props.sparkValues && props.sparkValues.length >= 2}>
        <Sparkline values={props.sparkValues!} max={props.sparkMax ?? 100} color={props.color} />
      </Show>
    </div>
  )
}

export default function DeviceCard() {
  const [health, setHealth] = createSignal<HealthData | null>(null)
  const [temps, setTemps] = createSignal<ThermalZone[]>([])
  const [memHistory, setMemHistory] = createSignal<number[]>([])

  let interval: ReturnType<typeof setInterval> | undefined

  async function loadHealth() {
    try {
      const res = await fetch('/api/system/health')
      if (res.ok) setHealth(await res.json())
    } catch {
      /* ignore */
    }
  }

  async function loadTemps() {
    try {
      const res = await fetch('/api/system/temperature')
      if (res.ok) {
        const data = await res.json()
        setTemps(data.zones ?? [])
      }
    } catch {
      /* ignore */
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/system/health/history?window=3600000')
      if (res.ok) {
        const data = await res.json()
        const snapshots: HealthSnapshot[] = data.snapshots ?? []
        setMemHistory(
          snapshots.map((s) => {
            const m = s.resources?.memoryUsage
            return m && m.total > 0 ? (m.used / m.total) * 100 : 0
          })
        )
      }
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    Promise.all([loadHealth(), loadTemps(), loadHistory()])
    interval = setInterval(() => {
      loadHealth()
      loadTemps()
    }, 30_000)
  })

  onCleanup(() => clearInterval(interval))

  const hottest = () => {
    const z = temps()
    if (!z.length) return null
    return z.reduce((a, b) => (a.tempC > b.tempC ? a : b))
  }

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Device
        </h3>
        <Show when={health()}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            up {formatUptime(health()!.connection.uptime)}
          </span>
        </Show>
      </div>

      <Show when={health()} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
        {(h) => (
          <div class="space-y-2">
            <UsageBar
              label="Memory"
              used={h().resources.memoryUsage.used}
              total={h().resources.memoryUsage.total}
              color="#6366f1"
              sparkValues={memHistory()}
              sparkMax={100}
            />
            <UsageBar
              label="Disk"
              used={h().resources.diskUsage.used}
              total={h().resources.diskUsage.total}
              color="#8b5cf6"
            />
          </div>
        )}
      </Show>

      <Show when={hottest()}>
        {(zone) => (
          <div class="mt-2 flex items-center gap-1.5 text-[11px]">
            <span style={{ color: 'var(--c-text-muted)' }}>Temp</span>
            <span
              style={{
                color: zone().tempC > 85 ? '#ef4444' : zone().tempC > 70 ? '#f59e0b' : 'var(--c-text)'
              }}
            >
              {zone().tempC.toFixed(0)}°C
            </span>
            <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              ({zone().type})
            </span>
          </div>
        )}
      </Show>

      <Show when={temps().length > 1}>
        <details class="mt-1">
          <summary class="cursor-pointer text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            All zones ({temps().length})
          </summary>
          <div class="mt-1 space-y-0.5">
            <For each={temps()}>
              {(z) => (
                <div class="flex items-center justify-between text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  <span>{z.type}</span>
                  <span style={{ color: z.tempC > 85 ? '#ef4444' : z.tempC > 70 ? '#f59e0b' : 'var(--c-text)' }}>
                    {z.tempC.toFixed(0)}°C
                  </span>
                </div>
              )}
            </For>
          </div>
        </details>
      </Show>
    </div>
  )
}
