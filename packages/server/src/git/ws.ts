import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export function registerGitChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('git', {
    serverMessages: ['git.status'],
    clientMessages: []
  })

  bus.on('git.status.changed', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'git',
      {
        type: 'git.status',
        ...p,
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })
}
