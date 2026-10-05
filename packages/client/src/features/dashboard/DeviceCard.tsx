import { createSignal, createEffect, onMount, onCleanup, Show, For, on } from 'solid-js'
import { selectedDeviceIp } from './device-selection.js'

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

/** A tailnet device's metrics, as System → Devices collects them. */
interface RemoteMetrics {
  hostname: string
  online: boolean
  tailscaleIP: string | null
  cpu?: { cores: number; usagePercent: number }
  memory?: { totalBytes: number; usedBytes: number }
  gpu?: { name: string; memoryTotalMB: number; memoryUsedMB: number; usagePercent: number; tempC: number }
  storage?: Array<{ mount: string; totalBytes: number; usedBytes: number }>
  temperature?: Array<{ label: string; tempC: number }>
  collectedAt: number
  error?: string
}

function tempColor(c: number): string {
  return c > 85 ? '#ef4444' : c > 70 ? '#f59e0b' : 'var(--c-text)'
}

/** The Device card's body for a device picked in the Tailscale card. */
function RemoteDevice(props: { ip: string }) {
  const [device, setDevice] = createSignal<RemoteMetrics | null | undefined>(undefined)

  async function load(ip: string) {
    try {
      const res = await fetch('/api/system/devices/metrics')
      if (!res.ok) return
      const data = (await res.json()) as { devices?: RemoteMetrics[] }
      if (ip === props.ip) setDevice(data.devices?.find((d) => d.tailscaleIP === ip) ?? null)
    } catch {
      /* keep the last value */
    }
  }

  createEffect(
    on(
      () => props.ip,
      (ip) => {
        setDevice(undefined)
        void load(ip)
        const timer = setInterval(() => load(ip), 30_000)
        onCleanup(() => clearInterval(timer))
      }
    )
  )

  const hottest = () => {
    const zones = device()?.temperature ?? []
    return zones.length ? zones.reduce((a, b) => (a.tempC > b.tempC ? a : b)) : null
  }

  return (
    <Show when={device() !== undefined} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
      <Show
        when={device()}
        fallback={<p class="text-[11px] opacity-40">No metrics for this device. See System → Devices.</p>}
      >
        {(d) => (
          <div class="space-y-2">
            <div class="text-[11px] font-medium" style={{ color: 'var(--c-text)' }}>
              {d().hostname}
            </div>
            <Show when={!d().online || d().error}>
              <p class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                {d().error ?? 'offline'}
              </p>
            </Show>
            <Show when={d().cpu}>
              {(cpu) => (
                <div class="flex items-baseline justify-between text-[11px]">
                  <span style={{ color: 'var(--c-text-muted)' }}>CPU ({cpu().cores} cores)</span>
                  <span style={{ color: 'var(--c-text)' }}>{Math.round(cpu().usagePercent)}%</span>
                </div>
              )}
            </Show>
            <Show when={d().memory}>
              {(m) => <UsageBar label="Memory" used={m().usedBytes} total={m().totalBytes} color="#6366f1" />}
            </Show>
            <Show when={d().storage?.[0]}>
              {(s) => (
                <UsageBar label={`Disk ${s().mount}`} used={s().usedBytes} total={s().totalBytes} color="#8b5cf6" />
              )}
            </Show>
            <Show when={d().gpu}>
              {(g) => (
                <UsageBar
                  label={`${g().name} · ${g().usagePercent}%`}
                  used={g().memoryUsedMB * 1024 ** 2}
                  total={g().memoryTotalMB * 1024 ** 2}
                  color="#06b6d4"
                />
              )}
            </Show>
            <Show when={hottest()}>
              {(zone) => (
                <div class="flex items-center gap-1.5 text-[11px]">
                  <span style={{ color: 'var(--c-text-muted)' }}>Temp</span>
                  <span style={{ color: tempColor(zone().tempC) }}>{zone().tempC.toFixed(0)}°C</span>
                  <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    ({zone().label})
                  </span>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}

/** The Device card's body for this machine: health, temperature zones. */
function LocalDevice(props: {
  health: HealthData | null
  temps: ThermalZone[]
  memHistory: number[]
  hottest: ThermalZone | null
}) {
  return (
    <>
      <Show when={props.health} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
        {(h) => (
          <div class="space-y-2">
            <UsageBar
              label="Memory"
              used={h().resources.memoryUsage.used}
              total={h().resources.memoryUsage.total}
              color="#6366f1"
              sparkValues={props.memHistory}
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

      <Show when={props.hottest}>
        {(zone) => (
          <div class="mt-2 flex items-center gap-1.5 text-[11px]">
            <span style={{ color: 'var(--c-text-muted)' }}>Temp</span>
            <span style={{ color: tempColor(zone().tempC) }}>{zone().tempC.toFixed(0)}°C</span>
            <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              ({zone().type})
            </span>
          </div>
        )}
      </Show>

      <Show when={props.temps.length > 1}>
        <details class="mt-1">
          <summary class="cursor-pointer text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            All zones ({props.temps.length})
          </summary>
          <div class="mt-1 space-y-0.5">
            <For each={props.temps}>
              {(z) => (
                <div class="flex items-center justify-between text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  <span>{z.type}</span>
                  <span style={{ color: tempColor(z.tempC) }}>{z.tempC.toFixed(0)}°C</span>
                </div>
              )}
            </For>
          </div>
        </details>
      </Show>
    </>
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
        <Show when={health() && selectedDeviceIp() === null}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            up {formatUptime(health()!.connection.uptime)}
          </span>
        </Show>
      </div>

      <Show
        when={selectedDeviceIp()}
        fallback={<LocalDevice health={health()} temps={temps()} memHistory={memHistory()} hottest={hottest()} />}
      >
        {(ip) => <RemoteDevice ip={ip()} />}
      </Show>
    </div>
  )
}
