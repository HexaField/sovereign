import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export function registerOrgsChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('orgs', {
    serverMessages: ['org.created', 'org.updated', 'org.deleted'],
    clientMessages: []
  })

  for (const eventType of ['org.created', 'org.updated', 'org.deleted'] as const) {
    bus.on(eventType, (event) => {
      const p = event.payload as Record<string, string>
      ws.broadcastToChannel('orgs', {
        type: eventType,
        ...p,
        timestamp: new Date().toISOString()
      })
    })
  }
}
