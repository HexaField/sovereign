// WebSocket Handler — connection management, auth, channel registry

import type { EventBus } from '@template/core'
import type { WsMessage, WsChannelOptions } from '@template/core'

export interface WsHandler {
  registerChannel(name: string, options: WsChannelOptions): void
  handleConnection(ws: unknown, deviceId: string): void
  broadcast(msg: WsMessage): void
  broadcastToChannel(channel: string, msg: WsMessage, scope?: Record<string, string>): void
  sendTo(deviceId: string, msg: WsMessage): void
  sendBinary(channel: string, data: Buffer, scope?: Record<string, string>): void
  getConnectedDevices(): string[]
  getChannels(): string[]
}

export function createWsHandler(_bus: EventBus, _auth: unknown): WsHandler {
  throw new Error('not implemented')
}
