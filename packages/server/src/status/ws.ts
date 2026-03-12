// Status — WebSocket channel registration

import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export function registerStatusChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('status', {
    serverMessages: ['status.update'],
    clientMessages: []
  })

  bus.on('status.update', (event) => {
    ws.broadcastToChannel('status', {
      type: 'status.update',
      ...(event.payload as Record<string, unknown>),
      timestamp: new Date().toISOString()
    })
  })
}
