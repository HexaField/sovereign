// Threads — WS channel for thread events

import type { EventBus } from '@template/core'
import type { ThreadManager } from './types.js'

export interface WsHandler {
  registerChannel(
    name: string,
    handler: (msg: { type: string; payload: unknown }, send: (msg: unknown) => void) => void
  ): void
  broadcast(channel: string, msg: unknown): void
}

export function registerThreadsWs(
  wsHandler: WsHandler,
  threadManager: ThreadManager,
  bus: EventBus
): { destroy: () => void } {
  const unsubs: Array<() => void> = []

  wsHandler.registerChannel('threads', (msg, send) => {
    const { type, payload } = msg as { type: string; payload: Record<string, unknown> }

    switch (type) {
      case 'thread.list': {
        const threads = threadManager.list()
        send({ type: 'thread.list', payload: { threads } })
        break
      }
      case 'thread.create': {
        const thread = threadManager.create({
          label: payload?.label as string | undefined,
          entities: payload?.entities as never
        })
        send({ type: 'thread.created', payload: { thread } })
        break
      }
      case 'thread.switch': {
        const key = payload?.key as string
        const thread = threadManager.get(key)
        send({ type: 'thread.switched', payload: { thread: thread ?? null } })
        break
      }
      case 'thread.entity.add': {
        const key = payload?.key as string
        const entity = payload?.entity as never
        const thread = threadManager.addEntity(key, entity)
        send({ type: 'thread.updated', payload: { thread } })
        break
      }
      case 'thread.entity.remove': {
        const key = payload?.key as string
        const thread = threadManager.removeEntity(key, payload?.entityType as never, payload?.entityRef as string)
        send({ type: 'thread.updated', payload: { thread } })
        break
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
        wsHandler.broadcast('threads', { type: event.type, payload: event.payload })
      })
    )
  }

  return {
    destroy() {
      for (const unsub of unsubs) unsub()
    }
  }
}
