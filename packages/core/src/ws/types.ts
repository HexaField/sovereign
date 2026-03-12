// WebSocket Protocol — Shared Types

export interface WsMessage {
  type: string
  timestamp?: string
  ackId?: string
}

export interface WsSubscribe extends WsMessage {
  type: 'subscribe'
  channels: string[]
  scope?: { orgId?: string; projectId?: string; sessionId?: string }
}

export interface WsUnsubscribe extends WsMessage {
  type: 'unsubscribe'
  channels: string[]
}

export interface WsError extends WsMessage {
  type: 'error'
  code: string
  message: string
}

export interface WsPong extends WsMessage {
  type: 'pong'
}

export interface WsAck extends WsMessage {
  type: 'ack'
  ackId: string
}

export interface WsChannelOptions {
  serverMessages: string[]
  clientMessages: string[]
  binary?: boolean
  onSubscribe?: (deviceId: string, scope?: Record<string, string>) => void
  onUnsubscribe?: (deviceId: string, scope?: Record<string, string>) => void
  onDisconnect?: (deviceId: string) => void
  onMessage?: (type: string, payload: unknown, deviceId: string) => void
}
