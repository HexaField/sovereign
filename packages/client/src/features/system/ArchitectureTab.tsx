// §6.2 Architecture Tab — Graph of server modules and event subscriptions
// Nodes: module name + status badge. Edges: event subscriptions. Live updates.

import { createSignal, onMount, onCleanup, For, type Component } from 'solid-js'

export interface ModuleNode {
  name: string
  status: 'healthy' | 'degraded' | 'error'
  subscribes: string[]
  publishes: string[]
}

export interface ArchitectureData {
  modules: ModuleNode[]
}

export function getStatusBadgeClass(status: ModuleNode['status']): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500'
    case 'degraded':
      return 'bg-amber-500'
    case 'error':
      return 'bg-red-500'
  }
}

export function getStatusLabel(status: ModuleNode['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export async function fetchArchitecture(): Promise<ArchitectureData> {
  const res = await fetch('/api/system/architecture')
  if (!res.ok) throw new Error(`Failed to fetch architecture: ${res.status}`)
  return res.json()
}

const ArchitectureTab: Component = () => {
  const [data, setData] = createSignal<ArchitectureData | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [pulsingModule, _setPulsingModule] = createSignal<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const load = async () => {
    try {
      const arch = await fetchArchitecture()
      setData(arch)
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  onMount(() => {
    load()
    // Poll for live updates every 5s
    pollTimer = setInterval(load, 5000)
  })

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer)
  })

  return (
    <div>
      {error() && (
        <div class="mb-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      )}

      {!data() && !error() && <div class="text-sm opacity-60">Loading architecture…</div>}

      {data() && (
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <For each={data()!.modules}>
            {(mod) => (
              <div
                class={`rounded-lg border p-4 transition-all ${
                  pulsingModule() === mod.name ? "ring-2 ring-blue-400/50" : ''
                }`}
                style={{
                  background: 'var(--c-bg-raised)',
                  'border-color': 'var(--c-border)'
                }}
              >
                <div class="mb-2 flex items-center gap-2">
                  <span class={`inline-block h-2.5 w-2.5 rounded-full ${getStatusBadgeClass(mod.status)}`} />
                  <span class="font-medium">{mod.name}</span>
                  <span class="ml-auto text-xs opacity-60">{getStatusLabel(mod.status)}</span>
                </div>

                {mod.subscribes.length > 0 && (
                  <div class="mt-2 text-xs opacity-70">
                    <span class="font-medium">Subscribes:</span>
                    <ul class="mt-1 ml-3 list-disc">
                      <For each={mod.subscribes}>{(event) => <li>{event}</li>}</For>
                    </ul>
                  </div>
                )}

                {mod.publishes.length > 0 && (
                  <div class="mt-2 text-xs opacity-70">
                    <span class="font-medium">Publishes:</span>
                    <ul class="mt-1 ml-3 list-disc">
                      <For each={mod.publishes}>{(event) => <li>{event}</li>}</For>
                    </ul>
                  </div>
                )}
              </div>
            )}
          </For>
        </div>
      )}
    </div>
  )
}

export default ArchitectureTab
