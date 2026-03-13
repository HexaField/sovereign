// §6.6 Devices Tab — Connected devices list + pending pairing requests
// Approve/reject buttons. Data from auth device management endpoints.

import { createSignal, onMount, Show, For, type Component } from 'solid-js'

export interface Device {
  id: string
  name: string
  status: 'connected' | 'disconnected'
  lastSeen: string
}

export interface PairingRequest {
  id: string
  deviceName: string
  requestedAt: string
}

export interface DevicesData {
  devices: Device[]
  pendingRequests: PairingRequest[]
}

export function getDeviceStatusClass(status: Device['status']): string {
  return status === 'connected' ? 'bg-green-500' : 'bg-gray-500'
}

export function getDeviceStatusLabel(status: Device['status']): string {
  return status === 'connected' ? 'Connected' : 'Disconnected'
}

export async function fetchDevices(): Promise<DevicesData> {
  const res = await fetch('/api/devices')
  if (!res.ok) throw new Error(`Failed to fetch devices: ${res.status}`)
  return res.json()
}

export async function approvePairing(requestId: string): Promise<void> {
  const res = await fetch(`/api/devices/pair/${requestId}/approve`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to approve: ${res.status}`)
}

export async function rejectPairing(requestId: string): Promise<void> {
  const res = await fetch(`/api/devices/pair/${requestId}/reject`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to reject: ${res.status}`)
}

const DevicesTab: Component = () => {
  const [data, setData] = createSignal<DevicesData | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    try {
      const devices = await fetchDevices()
      setData(devices)
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  onMount(load)

  const handleApprove = async (id: string) => {
    try {
      await approvePairing(id)
      await load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleReject = async (id: string) => {
    try {
      await rejectPairing(id)
      await load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div class="space-y-6">
      {error() && <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>}

      {!data() && !error() && <div class="text-sm opacity-60">Loading devices…</div>}

      <Show when={data()}>
        {(d) => (
          <>
            {/* Connected devices */}
            <div>
              <h3 class="mb-3 text-sm font-semibold opacity-80">Devices ({d().devices.length})</h3>
              <div class="space-y-2">
                <For each={d().devices}>
                  {(device) => (
                    <div
                      class="flex items-center gap-3 rounded-lg border p-3"
                      style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
                    >
                      <span class={`inline-block h-2.5 w-2.5 rounded-full ${getDeviceStatusClass(device.status)}`} />
                      <div class="flex-1">
                        <div class="text-sm font-medium">{device.name}</div>
                        <div class="text-xs opacity-50">ID: {device.id}</div>
                      </div>
                      <div class="text-right text-xs opacity-50">
                        <div>{getDeviceStatusLabel(device.status)}</div>
                        <div>Last seen: {new Date(device.lastSeen).toLocaleString()}</div>
                      </div>
                    </div>
                  )}
                </For>

                {d().devices.length === 0 && <div class="text-sm opacity-50">No devices connected</div>}
              </div>
            </div>

            {/* Pending pairing requests */}
            <Show when={d().pendingRequests.length > 0}>
              <div>
                <h3 class="mb-3 text-sm font-semibold opacity-80">Pending Requests ({d().pendingRequests.length})</h3>
                <div class="space-y-2">
                  <For each={d().pendingRequests}>
                    {(req) => (
                      <div class="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                        <div class="flex-1">
                          <div class="text-sm font-medium">{req.deviceName}</div>
                          <div class="text-xs opacity-50">Requested: {new Date(req.requestedAt).toLocaleString()}</div>
                        </div>
                        <div class="flex gap-2">
                          <button
                            class="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                            onClick={() => handleApprove(req.id)}
                          >
                            Approve
                          </button>
                          <button
                            class="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                            onClick={() => handleReject(req.id)}
                          >
                            Reject
                          </button>
                        </div>
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
