// §6.6 Devices Tab — Device identity, gateway connection, and pairing
import { createSignal, onMount, Show, For, type Component } from 'solid-js'

export interface DeviceInfo {
  deviceId: string
  publicKey: string
  name: string
  connectionStatus: string
  gatewayUrl: string
  reconnectAttempt: number
  isCurrent: boolean
}

export interface PairingRequest {
  id: string
  deviceName: string
  requestedAt: string
}

export interface DevicesData {
  devices: DeviceInfo[]
  pendingRequests?: PairingRequest[]
}

function statusColor(status: string): string {
  if (status === 'connected') return 'bg-green-500'
  if (status === 'connecting') return 'bg-amber-500'
  return 'bg-red-500'
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

const DevicesTab: Component = () => {
  const [data, setData] = createSignal<DevicesData | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    try {
      const res = await fetch('/api/system/devices')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  onMount(load)

  return (
    <div class="space-y-6">
      {error() && <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>}

      {!data() && !error() && <div class="text-sm opacity-60">Loading devices…</div>}

      <Show when={data()}>
        {(d) => (
          <>
            <div>
              <h3 class="mb-3 text-sm font-semibold opacity-80">Devices ({d().devices.length})</h3>
              <div class="space-y-2">
                <For each={d().devices}>
                  {(device) => (
                    <div
                      class="rounded-lg border p-4"
                      style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
                    >
                      <div class="flex items-center gap-3">
                        <span class={`inline-block h-2.5 w-2.5 rounded-full ${statusColor(device.connectionStatus)}`} />
                        <div class="flex-1">
                          <div class="flex items-center gap-2 text-sm font-medium">
                            {device.name}
                            {device.isCurrent && (
                              <span class="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-400">
                                Current
                              </span>
                            )}
                          </div>
                          <div class="mt-1 font-mono text-xs opacity-50">ID: {device.deviceId.slice(0, 16)}…</div>
                        </div>
                        <div class="text-right text-xs opacity-60">
                          <div>{statusLabel(device.connectionStatus)}</div>
                          {device.reconnectAttempt > 0 && (
                            <div class="text-amber-400">Retry #{device.reconnectAttempt}</div>
                          )}
                        </div>
                      </div>

                      <div class="mt-3 space-y-1 border-t pt-3 text-xs" style={{ 'border-color': 'var(--c-border)' }}>
                        <div class="flex justify-between">
                          <span class="opacity-60">Gateway</span>
                          <span class="font-mono">{device.gatewayUrl}</span>
                        </div>
                        <div class="flex justify-between">
                          <span class="opacity-60">Public Key</span>
                          <span class="font-mono">{device.publicKey.slice(0, 20)}…</span>
                        </div>
                      </div>
                    </div>
                  )}
                </For>

                {d().devices.length === 0 && <div class="text-sm opacity-50">No device identity found</div>}
              </div>
            </div>

            <Show when={(d().pendingRequests?.length ?? 0) > 0}>
              <div>
                <h3 class="mb-3 text-sm font-semibold opacity-80">Pending Requests</h3>
                <div class="space-y-2">
                  <For each={d().pendingRequests!}>
                    {(req) => (
                      <div class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        <div class="font-medium">{req.deviceName}</div>
                        <div class="text-xs opacity-50">Requested: {new Date(req.requestedAt).toLocaleString()}</div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

export default DevicesTab
