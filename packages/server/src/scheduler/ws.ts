// Scheduler — WebSocket channel registration

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerSchedulerChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('scheduler', {
    serverMessages: ['scheduler.job.started', 'scheduler.job.completed', 'scheduler.job.failed'],
    clientMessages: []
  })

  for (const eventType of ['scheduler.job.started', 'scheduler.job.completed', 'scheduler.job.failed'] as const) {
    bus.on(eventType, (event) => {
      ws.broadcastToChannel('scheduler', {
        type: eventType,
        ...(event.payload as Record<string, unknown>),
        timestamp: new Date().toISOString()
      })
    })
  }
}
