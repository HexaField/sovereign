import { createSignal } from 'solid-js'

export type ConnectionStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error'

export const [connectionStatus, _setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
export const [statusText, _setStatusText] = createSignal<string>('Disconnected')
