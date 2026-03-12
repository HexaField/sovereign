import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export function registerWorktreesChannel(ws: WsHandler, bus: EventBus): void {
  ws.registerChannel('worktrees', {
    serverMessages: ['worktree.update', 'worktree.stale'],
    clientMessages: []
  })

  bus.on('worktree.created', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'worktrees',
      {
        type: 'worktree.update',
        ...p,
        kind: 'created',
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })

  bus.on('worktree.removed', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'worktrees',
      {
        type: 'worktree.update',
        ...p,
        kind: 'removed',
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })

  bus.on('worktree.stale', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel(
      'worktrees',
      {
        type: 'worktree.stale',
        ...p,
        timestamp: new Date().toISOString()
      },
      { projectId: p.projectId }
    )
  })
}
