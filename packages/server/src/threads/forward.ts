// Threads — Message Forwarding Logic

import type { EventBus } from '@template/core'
import type { ThreadManager, ForwardedMessage } from './types.js'

export interface ForwardHandler {
  forward(sourceKey: string, targetKey: string, message: ForwardedMessage): { success: boolean; error?: string }
}

export function createForwardHandler(bus: EventBus, threadManager: ThreadManager): ForwardHandler {
  function forward(
    sourceKey: string,
    targetKey: string,
    message: ForwardedMessage
  ): { success: boolean; error?: string } {
    const source = threadManager.get(sourceKey)
    if (!source) return { success: false, error: 'Source thread not found' }
    const target = threadManager.get(targetKey)
    if (!target) return { success: false, error: 'Target thread not found' }

    bus.emit({
      type: 'thread.message.forwarded',
      timestamp: new Date().toISOString(),
      source: 'threads.forward',
      payload: {
        sourceThread: sourceKey,
        targetThread: targetKey,
        message
      }
    })

    return { success: true }
  }

  return { forward }
}
