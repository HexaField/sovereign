// Devices Tab — tailnet device monitoring with CPU/RAM/GPU/storage/network breakdown.

import { createSignal, onMount, onCleanup, Show, For, type Component } from 'solid-js'

// ── Types ──────────────────────────────────────────────────────────────

interface GpuInfo {
  name: string
  memoryTotalMB: number
  memoryUsedMB: number
  usagePercent: number
  tempC: number
}

interface StorageMount {
  mount: string
  totalBytes: number
  usedBytes: number
  filesystem: string
}

interface NetInterface {
  name: string
  rxBytes: number
  txBytes: number
}

interface ProcessInfo {
  pid: number
  name: string
  cpuPercent: number
  memPercent: number
}

interface ServiceInfo {
  name: string
  active: boolean
}

interface TempZone {
  label: string
  tempC: number
}

interface DiskTreeEntry {
  path: string
  sizeBytes: number
}

interface DeviceMetrics {
  hostname: string
  os: string
  online: boolean
  tailscaleIP: string | null
  local: boolean
  diskTree?: DiskTreeEntry[]
  cpu?: { cores: number; usagePercent: number; loadAvg: [number, number, number] }
  memory?: { totalBytes: number; usedBytes: number; availableBytes: number }
  gpu?: GpuInfo
  storage?: StorageMount[]
  network?: { interfaces: NetInterface[] }
  processes?: ProcessInfo[]
  services?: ServiceInfo[]
  temperature?: TempZone[]
  collectedAt: number
  error?: string
}

// ── Formatting helpers ─────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`
}

function fmtPct(val: number): string {
  return `${Math.round(val)}%`
}

function fmtAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

// ── Shared micro-components ────────────────────────────────────────────

function UsageBar(props: { label: string; used: number; total: number; color: string; suffix?: string }) {
  const pct = () => (props.total > 0 ? (props.used / props.total) * 100 : 0)
  return (
    <div>
      <div class="flex items-baseline justify-between text-[11px]">
        <span style={{ color: 'var(--c-text-muted)' }}>{props.label}</span>
        <span class="font-mono" style={{ color: 'var(--c-text)' }}>
          {fmtBytes(props.used)} / {fmtBytes(props.total)}
          <Show when={props.suffix}>
            <span style={{ color: 'var(--c-text-muted)' }}> {props.suffix}</span>
          </Show>
        </span>
      </div>
      <div class="mt-0.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--c-border)' }}>
        <div
          class="h-full rounded-full transition-all"
          style={{
            width: `${Math.min(pct(), 100)}%`,
            background: pct() > 90 ? '#ef4444' : pct() > 75 ? '#f59e0b' : props.color
          }}
        />
      </div>
    </div>
  )
}

function StatusDot(props: { online: boolean }) {
  return (
    <span
      class="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: props.online ? '#22c55e' : '#6b7280', opacity: props.online ? 1 : 0.4 }}
    />
  )
}

function Tag(props: { label: string; color: string; bg: string }) {
  return (
    <span
      class="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
      style={{ background: props.bg, color: props.color }}
    >
      {props.label}
    </span>
  )
}

// ── Device card ────────────────────────────────────────────────────────

function DeviceCard(props: { device: DeviceMetrics }) {
  const d = () => props.device
  const hottest = () => {
    const temps = d().temperature
    if (!temps?.length) return null
    return temps.reduce((a, b) => (a.tempC > b.tempC ? a : b))
  }

  return (
    <div
      class="rounded-lg border p-4"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': d().online ? 'var(--c-border)' : 'var(--c-border)',
        opacity: d().online ? 1 : 0.6
      }}
    >
      {/* Header */}
      <div class="mb-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <StatusDot online={d().online} />
          <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
            {d().hostname}
          </span>
          <Show when={d().local}>
            <Tag label="this device" color="#3b82f6" bg="#3b82f622" />
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <Show when={d().tailscaleIP}>
            <span class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {d().tailscaleIP}
            </span>
          </Show>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {fmtAgo(d().collectedAt)}
          </span>
        </div>
      </div>

      <Show
        when={d().online && !d().error}
        fallback={
          <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            {d().error ?? 'Offline'}
          </div>
        }
      >
        <div class="space-y-3">
          {/* CPU + Load */}
          <Show when={d().cpu}>
            {(cpu) => (
              <div>
                <div class="flex items-baseline justify-between text-[11px]">
                  <span style={{ color: 'var(--c-text-muted)' }}>CPU ({cpu().cores} cores)</span>
                  <span class="font-mono" style={{ color: 'var(--c-text)' }}>
                    {fmtPct(cpu().usagePercent)}
                    <span class="ml-1" style={{ color: 'var(--c-text-muted)' }}>
                      load{' '}
                      {cpu()
                        .loadAvg.map((l) => l.toFixed(1))
                        .join(' ')}
                    </span>
                  </span>
                </div>
                <div class="mt-0.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--c-border)' }}>
                  <div
                    class="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(cpu().usagePercent, 100)}%`,
                      background: cpu().usagePercent > 90 ? '#ef4444' : cpu().usagePercent > 70 ? '#f59e0b' : '#3b82f6'
                    }}
                  />
                </div>
              </div>
            )}
          </Show>

          {/* Memory */}
          <Show when={d().memory}>
            {(mem) => <UsageBar label="Memory" used={mem().usedBytes} total={mem().totalBytes} color="#8b5cf6" />}
          </Show>

          {/* GPU */}
          <Show when={d().gpu}>
            {(gpu) => (
              <div>
                <div class="mb-1 flex items-baseline justify-between text-[11px]">
                  <span style={{ color: 'var(--c-text-muted)' }}>{gpu().name}</span>
                  <span class="font-mono" style={{ color: 'var(--c-text)' }}>
                    {fmtPct(gpu().usagePercent)}
                    <Show when={gpu().tempC > 0}>
                      <span class="ml-1" style={{ color: gpu().tempC > 85 ? '#ef4444' : 'var(--c-text-muted)' }}>
                        {gpu().tempC}°C
                      </span>
                    </Show>
                  </span>
                </div>
                <UsageBar
                  label="VRAM"
                  used={gpu().memoryUsedMB * 1024 * 1024}
                  total={gpu().memoryTotalMB * 1024 * 1024}
                  color="#06b6d4"
                />
              </div>
            )}
          </Show>

          {/* Storage */}
          <Show when={d().storage?.length}>
            <div class="space-y-1.5">
              <For each={d().storage}>
                {(m) => (
                  <UsageBar
                    label={m.mount}
                    used={m.usedBytes}
                    total={m.totalBytes}
                    color="#a855f7"
                    suffix={m.filesystem}
                  />
                )}
              </For>
            </div>
          </Show>

          {/* Network */}
          <Show when={d().network?.interfaces?.length}>
            <div>
              <div
                class="mb-1 text-[10px] tracking-wide uppercase"
                style={{ color: 'var(--c-text-muted)', opacity: 0.6 }}
              >
                Network
              </div>
              <div class="space-y-0.5">
                <For each={d().network!.interfaces}>
                  {(iface) => (
                    <div class="flex items-center justify-between text-[11px]">
                      <span class="font-mono" style={{ color: 'var(--c-text-muted)' }}>
                        {iface.name}
                      </span>
                      <span class="font-mono" style={{ color: 'var(--c-text)' }}>
                        <span style={{ color: '#22c55e' }}>↓{fmtBytes(iface.rxBytes)}</span>
                        <span class="mx-1" style={{ color: 'var(--c-text-muted)' }}>
                          /
                        </span>
                        <span style={{ color: '#3b82f6' }}>↑{fmtBytes(iface.txBytes)}</span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Temperature + Services row */}
          <div class="flex flex-wrap gap-4">
            <Show when={hottest()}>
              {(zone) => (
                <div class="flex items-center gap-1.5 text-[11px]">
                  <span style={{ color: 'var(--c-text-muted)' }}>Temp</span>
                  <span
                    class="font-mono"
                    style={{ color: zone().tempC > 85 ? '#ef4444' : zone().tempC > 70 ? '#f59e0b' : 'var(--c-text)' }}
                  >
                    {zone().tempC.toFixed(0)}°C
                  </span>
                  <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    ({zone().label})
                  </span>
                </div>
              )}
            </Show>

            <Show when={d().services?.length}>
              <div class="flex items-center gap-1.5">
                <For each={d().services}>
                  {(svc) => (
                    <div class="flex items-center gap-1 text-[11px]">
                      <span
                        class="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: svc.active ? '#22c55e' : '#6b7280' }}
                      />
                      <span style={{ color: 'var(--c-text-muted)' }}>{svc.name}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Disk tree (collapsible) */}
          <Show when={d().diskTree?.length}>
            <details>
              <summary class="cursor-pointer text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                Disk usage by directory
              </summary>
              <div class="mt-1.5 space-y-0.5">
                <For each={d().diskTree}>
                  {(entry) => {
                    const totalStorage = () => d().storage?.reduce((acc, m) => Math.max(acc, m.totalBytes), 0) ?? 0
                    const pct = () => (totalStorage() > 0 ? Math.min((entry.sizeBytes / totalStorage()) * 100, 100) : 0)
                    return (
                      <div class="flex items-center gap-2">
                        <span
                          class="w-[38%] shrink-0 truncate font-mono text-[10px]"
                          style={{ color: 'var(--c-text-muted)' }}
                          title={entry.path}
                        >
                          {entry.path}
                        </span>
                        <div class="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--c-border)' }}>
                          <div
                            class="h-full rounded-full"
                            style={{ width: `${pct()}%`, background: pct() > 80 ? '#ef4444' : '#a855f7' }}
                          />
                        </div>
                        <span
                          class="w-[20%] shrink-0 text-right font-mono text-[10px]"
                          style={{ color: 'var(--c-text)' }}
                        >
                          {fmtBytes(entry.sizeBytes)}
                        </span>
                      </div>
                    )
                  }}
                </For>
              </div>
            </details>
          </Show>

          {/* Top processes (collapsible) */}
          <Show when={d().processes?.length}>
            <details>
              <summary class="cursor-pointer text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                Top processes ({d().processes!.length})
              </summary>
              <div class="mt-1 space-y-0.5">
                <For each={d().processes}>
                  {(p) => (
                    <div class="flex items-center justify-between font-mono text-[10px]">
                      <span class="max-w-[60%] truncate" style={{ color: 'var(--c-text-muted)' }}>
                        {p.name}
                      </span>
                      <span style={{ color: 'var(--c-text)' }}>
                        <span style={{ color: p.cpuPercent > 50 ? '#f59e0b' : 'var(--c-text-muted)' }}>
                          {p.cpuPercent.toFixed(1)}% cpu
                        </span>
                        <span class="mx-1 opacity-30">|</span>
                        <span style={{ color: p.memPercent > 10 ? '#8b5cf6' : 'var(--c-text-muted)' }}>
                          {p.memPercent.toFixed(1)}% mem
                        </span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </details>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ── Tab component ──────────────────────────────────────────────────────

const DevicesTab: Component = () => {
  const [devices, setDevices] = createSignal<DeviceMetrics[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [lastRefresh, setLastRefresh] = createSignal(0)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const load = async () => {
    try {
      const res = await fetch('/api/system/devices/metrics')
      if (!res.ok) {
        if (res.status === 404) {
          setError('Device monitoring endpoint not available')
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await res.json()
      setDevices(data.devices ?? [])
      setLastRefresh(Date.now())
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/system/devices/refresh', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setDevices(data.devices ?? [])
        setLastRefresh(Date.now())
        setError(null)
      }
    } catch {
      // Fall back to cached
      await load()
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    load()
    pollTimer = setInterval(load, 30_000)
  })

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer)
  })

  const onlineCount = () => devices().filter((d) => d.online).length
  const totalCount = () => devices().length

  return (
    <div class="space-y-4">
      {/* Header */}
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
            Devices
          </h2>
          <Show when={totalCount() > 0}>
            <span class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
              {onlineCount()}/{totalCount()} online
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <Show when={lastRefresh() > 0}>
            <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {fmtAgo(lastRefresh())}
            </span>
          </Show>
          <button
            class="rounded border-none px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: 'var(--c-hover-bg)',
              color: 'var(--c-text-muted)',
              cursor: loading() ? 'wait' : 'pointer'
            }}
            onClick={refresh}
            disabled={loading()}
          >
            {loading() ? '…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      <Show when={error()}>
        <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      </Show>

      <Show
        when={!loading() || devices().length > 0}
        fallback={<div class="py-8 text-center text-xs opacity-40">Loading device metrics…</div>}
      >
        <div class="grid gap-4 lg:grid-cols-2">
          <For
            each={devices().sort((a, b) =>
              a.local ? -1 : b.local ? 1 : a.online === b.online ? 0 : a.online ? -1 : 1
            )}
          >
            {(device) => <DeviceCard device={device} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default DevicesTab
