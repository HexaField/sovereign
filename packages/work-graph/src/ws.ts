// WS channel 'forge': forge.updated { membrane } after a sync with changes,
// forge.overlay { membrane, overlays } when the overlay inputs change.

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'

export const FORGE_WS_EVENTS = ['forge.updated', 'forge.overlay'] as const

export function registerForgeChannel(
  ws: Pick<WsHandler, 'registerChannel' | 'broadcastToChannel'>,
  bus: EventBus
): () => void {
  ws.registerChannel('forge', { serverMessages: [...FORGE_WS_EVENTS], clientMessages: [] })
  const offs = FORGE_WS_EVENTS.map((type) =>
    bus.on(type, (event) => {
      ws.broadcastToChannel('forge', {
        type,
        ...(event.payload as Record<string, unknown>),
        timestamp: event.timestamp
      })
    })
  )
  return () => offs.forEach((off) => off())
}
