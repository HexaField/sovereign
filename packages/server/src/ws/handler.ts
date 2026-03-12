// WebSocket Handler — connection management, channel registry

import type { EventBus } from '@template/core'
import type { WsMessage, WsChannelOptions } from '@template/core'
import { isWsMessage } from '@template/core'
import { createSubscriptionTracker } from './subscriptions.js'
import { encodeBinaryFrame, createBinaryChannelRegistry } from './binary.js'

export interface WsHandler {
  registerChannel(name: string, options: WsChannelOptions): void
  handleConnection(ws: WsLike, deviceId: string): void
  broadcast(msg: WsMessage): void
  broadcastToChannel(channel: string, msg: WsMessage, scope?: Record<string, string>): void
  sendTo(deviceId: string, msg: WsMessage): void
  sendBinary(channel: string, data: Buffer, scope?: Record<string, string>): void
  getConnectedDevices(): string[]
  getChannels(): string[]
}

export interface WsLike {
  send(data: string | Buffer): void
  close(): void
  on(event: string, handler: (...args: unknown[]) => void): void
}

export function createWsHandler(bus: EventBus): WsHandler {
  const channels = new Map<string, WsChannelOptions>()
  // Maps client message type -> channel name
  const clientTypeToChannel = new Map<string, string>()
  const connections = new Map<string, WsLike>()
  const tracker = createSubscriptionTracker()
  const binaryRegistry = createBinaryChannelRegistry()

  const registerChannel = (name: string, options: WsChannelOptions): void => {
    if (channels.has(name)) throw new Error(`Channel '${name}' already registered`)
    channels.set(name, options)
    for (const t of options.clientMessages) {
      clientTypeToChannel.set(t, name)
    }
    if (options.binary) {
      binaryRegistry.assignChannelId(name)
    }
  }

  const sendJson = (ws: WsLike, msg: WsMessage): void => {
    ws.send(JSON.stringify(msg))
  }

  const sendTo = (deviceId: string, msg: WsMessage): void => {
    const ws = connections.get(deviceId)
    if (ws) sendJson(ws, msg)
  }

  const broadcast = (msg: WsMessage): void => {
    const data = JSON.stringify(msg)
    for (const ws of connections.values()) {
      ws.send(data)
    }
  }

  const broadcastToChannel = (channel: string, msg: WsMessage, scope?: Record<string, string>): void => {
    const subscribers = tracker.getSubscribers(channel, scope)
    const data = JSON.stringify(msg)
    for (const deviceId of subscribers) {
      const ws = connections.get(deviceId)
      if (ws) ws.send(data)
    }
  }

  const sendBinary = (channel: string, data: Buffer, scope?: Record<string, string>): void => {
    const channelId = binaryRegistry.getChannelId(channel)
    if (channelId === undefined) return
    const frame = encodeBinaryFrame(channelId, data)
    const subscribers = tracker.getSubscribers(channel, scope)
    for (const deviceId of subscribers) {
      const ws = connections.get(deviceId)
      if (ws) ws.send(frame)
    }
  }

  const sendError = (ws: WsLike, code: string, message: string): void => {
    ws.send(JSON.stringify({ type: 'error', code, message }))
  }

  const handleConnection = (ws: WsLike, deviceId: string): void => {
    connections.set(deviceId, ws)
    // Default subscription to status channel
    tracker.subscribe(deviceId, ['status'])
    bus.emit({ type: 'ws.connected', timestamp: new Date().toISOString(), source: 'ws', payload: { deviceId } })

    ws.on('message', (raw: unknown) => {
      let msg: unknown
      if (typeof raw === 'string') {
        try {
          msg = JSON.parse(raw)
        } catch {
          sendError(ws, 'PARSE_ERROR', 'Invalid JSON')
          return
        }
      } else if (Buffer.isBuffer(raw)) {
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          sendError(ws, 'PARSE_ERROR', 'Invalid JSON')
          return
        }
      } else {
        return
      }

      if (!isWsMessage(msg)) {
        sendError(ws, 'INVALID_MESSAGE', 'Message must have a type field')
        return
      }

      const { type } = msg

      // Built-in: ping
      if (type === 'ping') {
        sendJson(ws, { type: 'pong' })
        return
      }

      // Built-in: subscribe
      if (type === 'subscribe') {
        const sub = msg as { channels?: string[]; scope?: Record<string, string> }
        if (!Array.isArray(sub.channels)) {
          sendError(ws, 'INVALID_SUBSCRIBE', 'channels must be an array')
          return
        }
        // Check all channels are registered
        for (const ch of sub.channels) {
          if (!channels.has(ch)) {
            sendError(ws, 'UNKNOWN_CHANNEL', `Channel '${ch}' is not registered`)
            return
          }
        }
        tracker.subscribe(deviceId, sub.channels, sub.scope)
        // Invoke onSubscribe callbacks
        for (const ch of sub.channels) {
          channels.get(ch)?.onSubscribe?.(deviceId, sub.scope)
        }
        return
      }

      // Built-in: unsubscribe
      if (type === 'unsubscribe') {
        const unsub = msg as { channels?: string[] }
        if (Array.isArray(unsub.channels)) {
          // Invoke onUnsubscribe callbacks
          for (const ch of unsub.channels) {
            channels.get(ch)?.onUnsubscribe?.(deviceId)
          }
          tracker.unsubscribe(deviceId, unsub.channels)
        }
        return
      }

      // Ack support
      if ((msg as WsMessage).ackId) {
        sendJson(ws, { type: 'ack', ackId: (msg as WsMessage).ackId })
      }

      // Route client message to channel handler
      const channelName = clientTypeToChannel.get(type)
      if (!channelName) {
        sendError(ws, 'UNKNOWN_TYPE', `Message type '${type}' is not registered to any channel`)
        return
      }
      const opts = channels.get(channelName)
      opts?.onMessage?.(type, msg, deviceId)
    })

    ws.on('close', () => {
      connections.delete(deviceId)
      const removedChannels = tracker.removeDevice(deviceId)
      // Invoke onDisconnect for all channels the device was subscribed to
      for (const ch of removedChannels) {
        channels.get(ch)?.onDisconnect?.(deviceId)
      }
      bus.emit({ type: 'ws.disconnected', timestamp: new Date().toISOString(), source: 'ws', payload: { deviceId } })
    })
  }

  const getConnectedDevices = (): string[] => [...connections.keys()]
  const getChannels = (): string[] => [...channels.keys()]

  return {
    registerChannel,
    handleConnection,
    broadcast,
    broadcastToChannel,
    sendTo,
    sendBinary,
    getConnectedDevices,
    getChannels
  }
}
