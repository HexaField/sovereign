// Threads — WS channel for thread events

import type { EventBus, WsChannelOptions } from '@sovereign/core'
import type { ThreadManager } from './types.js'

export interface WsHandler {
  registerChannel(name: string, options: WsChannelOptions): void
  broadcastToChannel(channel: string, msg: { type: string; payload: unknown }): void
}

export function registerThreadsWs(
  wsHandler: WsHandler,
  threadManager: ThreadManager,
  bus: EventBus
): { destroy: () => void } {
  const unsubs: Array<() => void> = []

  wsHandler.registerChannel('threads', {
    serverMessages: [
      'thread.list',
      'thread.created',
      'thread.switched',
      'thread.updated',
      'thread.deleted',
      'thread.entity.added',
      'thread.entity.removed',
      'thread.event.routed'
    ],
    clientMessages: ['thread.list', 'thread.create', 'thread.switch', 'thread.entity.add', 'thread.entity.remove'],
    onMessage(type, payload, _deviceId) {
      const p = payload as Record<string, unknown>
      switch (type) {
        case 'thread.list': {
          const threads = threadManager.list()
          wsHandler.broadcastToChannel('threads', { type: 'thread.list', payload: { threads } })
          break
        }
        case 'thread.create': {
          const thread = threadManager.create({
            label: p?.label as string | undefined,
            entities: p?.entities as never
          })
          wsHandler.broadcastToChannel('threads', { type: 'thread.created', payload: { thread } })
          break
        }
        case 'thread.switch': {
          const key = p?.key as string
          const thread = threadManager.get(key)
          wsHandler.broadcastToChannel('threads', { type: 'thread.switched', payload: { thread: thread ?? null } })
          break
        }
        case 'thread.entity.add': {
          const key = p?.key as string
          const entity = p?.entity as never
          const thread = threadManager.addEntity(key, entity)
          wsHandler.broadcastToChannel('threads', { type: 'thread.updated', payload: { thread } })
          break
        }
        case 'thread.entity.remove': {
          const key = p?.key as string
          const thread = threadManager.removeEntity(key, p?.entityType as never, p?.entityRef as string)
          wsHandler.broadcastToChannel('threads', { type: 'thread.updated', payload: { thread } })
          break
        }
      }
    }
  })

  // Broadcast bus events to WS
  const busEvents = [
    'thread.created',
    'thread.deleted',
    'thread.entity.added',
    'thread.entity.removed',
    'thread.event.routed'
  ]
  for (const eventType of busEvents) {
    unsubs.push(
      bus.on(eventType, (event) => {
        wsHandler.broadcastToChannel('threads', { type: event.type, payload: event.payload })
      })
    )
  }

  return {
    destroy() {
      for (const unsub of unsubs) unsub()
    }
  }
}
