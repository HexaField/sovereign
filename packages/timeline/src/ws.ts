// WS channel 'timeline': `timeline.entry { entry }` for every new line.

import type { WsHandler } from '@sovereign/primitives'
import type { TimelineService } from './service.js'

export function registerTimelineChannel(
  ws: Pick<WsHandler, 'registerChannel' | 'broadcastToChannel'>,
  service: Pick<TimelineService, 'onEntry'>
): () => void {
  ws.registerChannel('timeline', { serverMessages: ['timeline.entry'], clientMessages: [] })
  return service.onEntry((entry) => ws.broadcastToChannel('timeline', { type: 'timeline.entry', entry }))
}
