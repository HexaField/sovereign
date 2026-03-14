// Meetings WS channel — §8.7.1

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerMeetingsChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('meetings', {
    serverMessages: ['meeting.created', 'meeting.updated', 'meeting.deleted'],
    clientMessages: []
  })

  bus.on('meeting.created', (event) => {
    const payload = event.payload as Record<string, unknown>
    ws.broadcastToChannel(
      'meetings',
      {
        type: 'meeting.created',
        ...(payload as Record<string, unknown>),
        timestamp: event.timestamp
      },
      payload.orgId ? { orgId: payload.orgId as string } : undefined
    )
  })

  bus.on('meeting.updated', (event) => {
    const payload = event.payload as Record<string, unknown>
    ws.broadcastToChannel(
      'meetings',
      {
        type: 'meeting.updated',
        ...(payload as Record<string, unknown>),
        timestamp: event.timestamp
      },
      payload.orgId ? { orgId: payload.orgId as string } : undefined
    )
  })

  bus.on('meeting.deleted', (event) => {
    const payload = event.payload as Record<string, unknown>
    ws.broadcastToChannel(
      'meetings',
      {
        type: 'meeting.deleted',
        ...(payload as Record<string, unknown>),
        timestamp: event.timestamp
      },
      payload.orgId ? { orgId: payload.orgId as string } : undefined
    )
  })
}
