// Overview Device card — one tailnet device's machine metrics, as System →
// Devices collects them. Shows this machine until a node is picked in the
// Tailscale card (device-selection.ts).

import { createSignal, createEffect, onCleanup, Show, For, on } from 'solid-js'
import { selectedDeviceIp } from './device-selection.js'

interface DeviceMetrics {
  hostname: string
  online: boolean
  local: boolean
  tailscaleIP: string | null
  cpu?: { cores: number; usagePercent: number }
  memory?: { totalBytes: number; usedBytes: number }
  gpu?: { name: string; memoryTotalMB: number; memoryUsedMB: number; usagePercent: number; tempC: number }
  storage?: Array<{ mount: string; totalBytes: number; usedBytes: number }>
  temperature?: Array<{ label: string; tempC: number }>
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`
}

function tempColor(c: number): string {
  return c > 85 ? '#ef4444' : c > 70 ? '#f59e0b' : 'var(--c-text)'
}

function UsageBar(props: { label: string; used: number; total: number; color: string }) {
  const pct = () => (props.total > 0 ? Math.round((props.used / props.total) * 100) : 0)

  return (
    <div>
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
  )
}

export default function DeviceCard() {
  const [devices, setDevices] = createSignal<DeviceMetrics[] | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/system/devices/metrics')
      if (res.ok) setDevices(((await res.json()) as { devices?: DeviceMetrics[] }).devices ?? [])
    } catch {
      /* keep the last value */
    }
  }

  // Reload on a new selection (the metrics may have moved on) and every 30 s.
  createEffect(
    on(selectedDeviceIp, () => {
      void load()
      const timer = setInterval(load, 30_000)
      onCleanup(() => clearInterval(timer))
    })
  )

  const device = () => {
    const ip = selectedDeviceIp()
    return devices()?.find((d) => (ip ? d.tailscaleIP === ip : d.local)) ?? null
  }

  const zones = () => [...(device()?.temperature ?? [])].sort((a, b) => b.tempC - a.tempC)

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Device
        </h3>
        <Show when={device()}>
          {(d) => (
            <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {d().hostname}
            </span>
          )}
        </Show>
      </div>

      <Show when={devices()} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
        <Show
          when={device()}
          fallback={<p class="text-[11px] opacity-40">No metrics for this device. See System → Devices.</p>}
        >
          {(d) => (
            <div class="space-y-2">
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
              <Show when={zones()[0]}>
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
              <Show when={zones().length > 1}>
                <details>
                  <summary class="cursor-pointer text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    All zones ({zones().length})
                  </summary>
                  <div class="mt-1 space-y-0.5">
                    <For each={zones()}>
                      {(z) => (
                        <div
                          class="flex items-center justify-between text-[10px]"
                          style={{ color: 'var(--c-text-muted)' }}
                        >
                          <span>{z.label}</span>
                          <span style={{ color: tempColor(z.tempC) }}>{z.tempC.toFixed(0)}°C</span>
                        </div>
                      )}
                    </For>
                  </div>
                </details>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
