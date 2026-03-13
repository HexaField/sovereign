// Planning Module — WebSocket Integration

import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export function registerPlanningWs(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('planning', {
    serverMessages: ['planning.graph.updated', 'planning.sync.completed', 'planning.cycle.detected'],
    clientMessages: []
  })

  bus.on('planning.graph.updated', (event) => {
    const payload = event.payload as { orgId?: string }
    const scope = payload?.orgId ? { orgId: payload.orgId } : undefined
    ws.broadcastToChannel(
      'planning',
      {
        type: 'planning.graph.updated',
        ...(payload as Record<string, unknown>),
        timestamp: new Date().toISOString()
      },
      scope
    )
  })

  bus.on('planning.sync.completed', (event) => {
    const payload = event.payload as { orgId?: string }
    const scope = payload?.orgId ? { orgId: payload.orgId } : undefined
    ws.broadcastToChannel(
      'planning',
      {
        type: 'planning.sync.completed',
        ...(payload as Record<string, unknown>),
        timestamp: new Date().toISOString()
      },
      scope
    )
  })

  bus.on('planning.cycle.detected', (event) => {
    const payload = event.payload as { orgId?: string }
    const scope = payload?.orgId ? { orgId: payload.orgId } : undefined
    ws.broadcastToChannel(
      'planning',
      {
        type: 'planning.cycle.detected',
        ...(payload as Record<string, unknown>),
        timestamp: new Date().toISOString()
      },
      scope
    )
  })
}
