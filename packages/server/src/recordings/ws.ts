// Recordings WS channel — §8.7.2

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerRecordingsChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('recordings', {
    serverMessages: ['recording.created', 'recording.updated', 'recording.deleted'],
    clientMessages: []
  })

  for (const eventType of ['recording.created', 'recording.updated', 'recording.deleted'] as const) {
    bus.on(eventType, (event) => {
      const payload = event.payload as Record<string, unknown>
      ws.broadcastToChannel(
        'recordings',
        {
          type: eventType,
          ...(payload as Record<string, unknown>),
          timestamp: event.timestamp
        },
        payload.orgId ? { orgId: payload.orgId as string } : undefined
      )
    })
  }
}
