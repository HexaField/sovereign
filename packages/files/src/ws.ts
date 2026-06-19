import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'

export function registerFilesChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('files', {
    serverMessages: ['file.changed'],
    clientMessages: []
  })

  for (const busEvent of ['file.created', 'file.changed', 'file.deleted'] as const) {
    bus.on(busEvent, (event) => {
      const p = event.payload as Record<string, string>
      const kind = busEvent === 'file.created' ? 'created' : busEvent === 'file.deleted' ? 'deleted' : 'modified'
      ws.broadcastToChannel(
        'files',
        {
          type: 'file.changed',
          ...p,
          kind,
          timestamp: new Date().toISOString()
        },
        { projectId: p.projectId }
      )
    })
  }
}
