import { createSignal, createMemo } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

export type ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'

/** Browser ↔ Sovereign WebSocket status */
export const [wsStatus, setWsStatus] = createSignal<ConnectionStatus>('disconnected')

/** Sovereign ↔ OpenClaw agent backend status */
export const [backendStatus, setBackendStatus] = createSignal<ConnectionStatus>('disconnected')

/** Combined status: green only when both browser↔Sovereign AND Sovereign↔OpenClaw are connected */
export const connectionStatus = createMemo<ConnectionStatus>(() => {
  const ws = wsStatus()
  const backend = backendStatus()
  // If the browser WS isn't connected, show that status
  if (ws !== 'connected') return ws
  // Browser WS is connected but agent backend isn't — show backend status
  if (backend === 'disconnected' || backend === 'error') return 'disconnected'
  if (backend === 'connecting' || backend === 'authenticating') return 'connecting'
  return 'connected'
})

/** For backward compat — callers that set connectionStatus directly now set wsStatus */
export const setConnectionStatus = setWsStatus

const STATUS_TEXT_MAP: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  authenticating: 'Authenticating…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection error'
}

export function statusText(): string {
  return STATUS_TEXT_MAP[connectionStatus()]
}

export function initConnectionStore(ws: WsStore): () => void {
  const unsub = ws.on('backend.status', (msg: any) => {
    const status = msg.status as ConnectionStatus
    setBackendStatus(status)
  })
  return unsub
}
