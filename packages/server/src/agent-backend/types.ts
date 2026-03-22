// Agent Backend — Server-side Types

import type { AgentStatus, BackendConnectionStatus } from '@sovereign/core'

export interface OpenClawConfig {
  /** Gateway WebSocket URL (e.g. wss://localhost:3456/ws) */
  gatewayUrl: string
  /** Gateway auth token */
  gatewayToken?: string
  /** Path to device identity key file */
  deviceKeyPath?: string
  /** Data directory for storing device identity */
  dataDir?: string
  /** Reconnection settings */
  reconnect?: ReconnectConfig
  /** Optional config change callback for hot-reload */
  onConfigChange?: (callback: (newConfig: Partial<OpenClawConfig>) => void) => void
}

export interface ReconnectConfig {
  initialDelayMs?: number
  maxDelayMs?: number
  jitter?: boolean
}

export interface DeviceIdentity {
  publicKey: string
  privateKeyDer: string
}

export interface VoiceConfig {
  transcribeUrl?: string
  ttsUrl?: string
}

export interface InternalState {
  connectionStatus: BackendConnectionStatus
  agentStatus: AgentStatus
  reconnectAttempt: number
  activeSessionKey: string | null
  ws: import('ws').WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null

  retryTimer: ReturnType<typeof setTimeout> | null
  destroyed: boolean
}
