import { createSignal } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

export type ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'

export const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')

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
    setConnectionStatus(status)
  })
  return unsub
}
