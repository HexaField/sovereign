// Notifications — WebSocket channel registration

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerNotificationsChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('notifications', {
    serverMessages: ['notification.new', 'notification.read'],
    clientMessages: []
  })

  bus.on('notification.created', (event) => {
    ws.broadcastToChannel('notifications', {
      type: 'notification.new',
      ...(event.payload as Record<string, unknown>),
      timestamp: new Date().toISOString()
    })
  })

  bus.on('notification.read', (event) => {
    ws.broadcastToChannel('notifications', {
      type: 'notification.read',
      ...(event.payload as Record<string, unknown>),
      timestamp: new Date().toISOString()
    })
  })
}
