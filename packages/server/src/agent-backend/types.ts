// Agent Backend — Server-side Types

export interface OpenClawConfig {
  /** Gateway WebSocket URL (e.g. wss://localhost:3456/ws) */
  gatewayUrl: string
  /** Path to device identity key file */
  deviceKeyPath?: string
  /** Reconnection settings */
  reconnect?: {
    initialDelayMs?: number
    maxDelayMs?: number
    jitter?: boolean
  }
}

export interface VoiceConfig {
  transcribeUrl?: string
  ttsUrl?: string
}
