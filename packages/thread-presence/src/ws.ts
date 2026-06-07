// thread-presence — WS channel for declaring which thread a device has
// focused. Pure inbound: clients tell us focus/blur; we don't broadcast
// anything back over this channel.

import type { EventBus, WsChannelOptions } from '@sovereign/core'
import type { PresenceTracker } from './presence.js'

export interface WsHandler {
  registerChannel(name: string, options: WsChannelOptions): void
}

/**
 * Register the `presence` WS channel and wire WS lifecycle events so a
 * disconnecting device automatically blurs.
 */
export function registerPresenceWs(
  wsHandler: WsHandler,
  presence: PresenceTracker,
  bus: EventBus,
  onFocus?: (threadId: string, deviceId: string) => void
): { destroy: () => void } {
  wsHandler.registerChannel('presence', {
    serverMessages: [],
    clientMessages: ['thread.focus', 'thread.blur'],
    onMessage(type, payload, deviceId) {
      const p = (payload ?? {}) as Record<string, unknown>
      switch (type) {
        case 'thread.focus': {
          const threadId = typeof p.threadId === 'string' ? p.threadId : ''
          if (threadId) {
            presence.setFocus(deviceId, threadId)
            onFocus?.(threadId, deviceId)
          } else {
            presence.blur(deviceId)
          }
          break
        }
        case 'thread.blur': {
          presence.blur(deviceId)
          break
        }
      }
    },
    onDisconnect(deviceId) {
      presence.clearDevice(deviceId)
    }
  })

  const unsub = bus.on('ws.disconnected', (event) => {
    const p = event.payload as { deviceId?: string }
    if (p?.deviceId) presence.clearDevice(p.deviceId)
  })

  return {
    destroy() {
      unsub()
    }
  }
}
