// §6.4 Health Tab — System health metrics in card grid layout
// Connection, Resources, Jobs, Cache, Errors cards. Data from WS system channel with REST fallback.

import { createSignal, onMount, onCleanup, Show, For, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export interface HealthData {
  connection: {
    wsStatus: string
    agentBackend: string
    uptime: number
  }
  resources: {
    diskUsage: { used: number; total: number }
    memoryUsage?: { used: number; total: number }
  }
  jobs: {
    active: number
    lastStatus: string
    nextRun: string | null
  }
  cache?: {
    hitRate: number
  }
  errors: {
    countLastHour: number
    recent: Array<{ message: string; timestamp: string }>
  }
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

export async function fetchHealth(): Promise<HealthData> {
  const res = await fetch('/api/system/health')
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.status}`)
  return res.json()
}

function HealthCard(props: { title: string; children: import('solid-js').JSX.Element }) {
  return (
    <div class="rounded-lg border p-4" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-3 text-sm font-semibold opacity-80">{props.title}</h3>
      {props.children}
    </div>
  )
}

const HealthTab: Component = () => {
  const [data, setData] = createSignal<HealthData | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const load = async () => {
    try {
      const health = await fetchHealth()
      setData(health)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }

  onMount(() => {
    // Initial REST fetch
    load()

    // Subscribe to WS system channel for reactive health updates
    wsStore.subscribe(['system'])

    const offHealth = wsStore.on('system.health', (msg: Record<string, unknown>) => {
      // Extract health data from WS message (remove type/timestamp metadata)
      const { type: _t, timestamp: _ts, ...healthData } = msg
      if (healthData.connection) {
        setData(healthData as unknown as HealthData)
        setError(null)
      }
    })

    // Fallback polling when WS disconnected
    pollTimer = setInterval(() => {
      if (!wsStore.connected()) {
        load()
      }
    }, 10000)

    onCleanup(() => {
      offHealth()
      wsStore.unsubscribe(['system'])
      if (pollTimer) clearInterval(pollTimer)
    })
  })

  return (
    <div>
      {error() && (
        <div class="mb-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      )}

      {!data() && !error() && <div class="text-sm opacity-60">Loading health data…</div>}

      <Show when={data()}>
        {(health) => (
          <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <HealthCard title="Connection">
              <div class="space-y-1 text-sm">
                <div class="flex justify-between">
                  <span class="opacity-60">WebSocket</span>
                  <span>{health().connection.wsStatus}</span>
                </div>
                <div class="flex justify-between">
                  <span class="opacity-60">Agent Backend</span>
                  <span>{health().connection.agentBackend}</span>
                </div>
                <div class="flex justify-between">
                  <span class="opacity-60">Uptime</span>
                  <span>{formatUptime(health().connection.uptime)}</span>
                </div>
              </div>
            </HealthCard>

            <HealthCard title="Resources">
              <div class="space-y-1 text-sm">
                <div class="flex justify-between">
                  <span class="opacity-60">Disk</span>
                  <span>
                    {formatBytes(health().resources.diskUsage.used)} / {formatBytes(health().resources.diskUsage.total)}
                  </span>
                </div>
                <Show when={health().resources.memoryUsage}>
                  {(mem) => (
                    <div class="flex justify-between">
                      <span class="opacity-60">Memory</span>
                      <span>
                        {formatBytes(mem().used)} / {formatBytes(mem().total)}
                      </span>
                    </div>
                  )}
                </Show>
              </div>
            </HealthCard>

            <HealthCard title="Jobs">
              <div class="space-y-1 text-sm">
                <div class="flex justify-between">
                  <span class="opacity-60">Active</span>
                  <span>{health().jobs.active}</span>
                </div>
                <div class="flex justify-between">
                  <span class="opacity-60">Last Status</span>
                  <span>{health().jobs.lastStatus}</span>
                </div>
                <Show when={health().jobs.nextRun}>
                  {(next) => (
                    <div class="flex justify-between">
                      <span class="opacity-60">Next Run</span>
                      <span>{next()}</span>
                    </div>
                  )}
                </Show>
              </div>
            </HealthCard>

            <Show when={health().cache}>
              {(cache) => (
                <HealthCard title="Cache">
                  <div class="space-y-1 text-sm">
                    <div class="flex justify-between">
                      <span class="opacity-60">Hit Rate</span>
                      <span>{formatPercent(cache().hitRate)}</span>
                    </div>
                  </div>
                </HealthCard>
              )}
            </Show>

            <HealthCard title="Errors">
              <div class="space-y-2 text-sm">
                <div class="flex justify-between">
                  <span class="opacity-60">Last hour</span>
                  <span class={health().errors.countLastHour > 0 ? "font-medium text-red-400" : ''}>
                    {health().errors.countLastHour}
                  </span>
                </div>
                <Show when={health().errors.recent.length > 0}>
                  <div class="mt-2 space-y-1">
                    <For each={health().errors.recent.slice(0, 5)}>
                      {(err) => (
                        <div class="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
                          <span class="opacity-60">{new Date(err.timestamp).toLocaleTimeString()}</span> {err.message}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </HealthCard>
          </div>
        )}
      </Show>
    </div>
  )
}

export default HealthTab
