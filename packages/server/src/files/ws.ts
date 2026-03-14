import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerFilesChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('files', {
    serverMessages: ['file.changed'],
    clientMessages: []
  })

  bus.on('file.created', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'files',
      {
        type: 'file.changed',
        ...p,
        kind: 'created',
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })

  bus.on('file.deleted', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'files',
      {
        type: 'file.changed',
        ...p,
        kind: 'deleted',
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })
}
