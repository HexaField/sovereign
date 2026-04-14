// §6.6 Devices Tab — Device identity, gateway connection, and pairing
import { createSignal, onMount, onCleanup, Show, For, type Component } from 'solid-js'

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

export async function fetchDevices(): Promise<DevicesData> {
  const res = await fetch('/api/system/devices')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function requestGatewayRestart(): Promise<{ status: string; message?: string; command?: string }> {
  const res = await fetch('/api/system/gateway/restart', {
    method: 'POST',
    headers: { Accept: 'application/json' }
  })
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    status?: string
    message?: string
    command?: string
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return {
    status: body.status || 'accepted',
    message: body.message,
    command: body.command
  }
}

export async function waitForGatewayReconnect(options?: {
  pollMs?: number
  timeoutMs?: number
  fetchDevicesFn?: typeof fetchDevices
}): Promise<'connected' | 'timeout'> {
  const pollMs = options?.pollMs ?? 1000
  const timeoutMs = options?.timeoutMs ?? 20_000
  const fetchDevicesFn = options?.fetchDevicesFn ?? fetchDevices
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const data = await fetchDevicesFn()
      if (data.devices.some((device) => device.isCurrent && device.connectionStatus === 'connected')) {
        return 'connected'
      }
    } catch {
      // Ignore transient fetch failures while the gateway is bouncing.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  return 'timeout'
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
  const [restartState, setRestartState] = createSignal<'idle' | 'restarting' | 'recovering'>('idle')
  const [restartMessage, setRestartMessage] = createSignal<string | null>(null)
  let disposed = false

  const load = async () => {
    try {
      setData(await fetchDevices())
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  const handleRestartGateway = async () => {
    if (restartState() !== 'idle') return

    setRestartState('restarting')
    setRestartMessage('Restarting OpenClaw gateway…')

    try {
      const result = await requestGatewayRestart()
      if (disposed) return
      await load()
      setRestartState('recovering')
      setRestartMessage(result.message || 'Gateway restart requested. Waiting for reconnect…')
      const reconnectResult = await waitForGatewayReconnect()
      if (disposed) return
      await load()
      if (reconnectResult === 'connected') {
        setRestartMessage('OpenClaw gateway restarted and reconnected.')
      } else {
        setRestartMessage(
          'Gateway restart completed, but reconnect was not observed yet. Check the device status above.'
        )
      }
    } catch (e: any) {
      if (disposed) return
      setRestartMessage(e?.message ?? 'Failed to restart OpenClaw gateway')
    } finally {
      if (!disposed) setRestartState('idle')
    }
  }

  onMount(load)
  onCleanup(() => {
    disposed = true
  })

  return (
    <div class="space-y-6">
      {error() && <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>}

      {restartMessage() && (
        <div
          class="rounded border p-3 text-sm"
          style={{
            'border-color': restartMessage()?.toLowerCase().includes('failed')
              ? 'rgb(239 68 68 / 0.3)'
              : 'var(--c-border)',
            background: restartState() === 'idle' ? 'var(--c-bg-raised)' : 'rgb(59 130 246 / 0.08)',
            color: restartMessage()?.toLowerCase().includes('failed') ? 'rgb(248 113 113)' : 'var(--c-text)'
          }}
        >
          {restartMessage()}
        </div>
      )}

      {!data() && !error() && <div class="text-sm opacity-60">Loading devices…</div>}

      <Show when={data()}>
        {(d) => (
          <>
            <div>
              <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 class="text-sm font-semibold opacity-80">Devices ({d().devices.length})</h3>
                <button
                  class="cursor-pointer rounded border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ 'border-color': 'var(--c-border)', background: 'transparent', color: 'var(--c-accent)' }}
                  disabled={restartState() !== 'idle'}
                  onClick={() => void handleRestartGateway()}
                >
                  {restartState() === 'restarting'
                    ? 'Restarting Gateway…'
                    : restartState() === 'recovering'
                      ? 'Waiting for Reconnect…'
                      : 'Restart OpenClaw Gateway'}
                </button>
              </div>
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
