// LastOriginTracker — keeps the most recently observed `MessageOrigin` per
// modality, so the response tools can default-target the right surface
// without the agent having to carry deviceId/perspective ids around.
//
// In-memory only. Cleared on restart; that's fine — the data is wall-clock
// stale within minutes anyway.

import type { EventBus, MessageOrigin, MessageModality } from '@sovereign/core'

export interface LastOriginTracker {
  /** Returns the most recent origin of the requested modality, or null. */
  get(modality: MessageModality): MessageOrigin | null
  /** Manually record an origin — exposed for tests + edge cases. The bus
   *  subscription set up in the constructor handles the normal flow. */
  set(origin: MessageOrigin): void
  /** Stop listening on the bus. Idempotent. */
  dispose(): void
}

export function createLastOriginTracker(
  bus: EventBus,
  /** When set, only track origins arriving on the given thread (the presence
   *  thread). Pass undefined to track every thread (mostly for tests). */
  presenceThreadId: () => string | null
): LastOriginTracker {
  const latest = new Map<MessageModality, MessageOrigin>()

  function set(origin: MessageOrigin): void {
    latest.set(origin.modality, origin)
  }

  const onChatOrigin = (event: { payload: unknown }) => {
    const payload = event.payload as { threadId?: string; origin?: MessageOrigin }
    if (!payload?.origin) return
    const presenceId = presenceThreadId()
    if (presenceId && payload.threadId !== presenceId) return
    set(payload.origin)
  }
  const unsub = bus.on('chat.message.origin', onChatOrigin)

  let disposed = false
  return {
    get: (modality) => latest.get(modality) ?? null,
    set,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsub()
    }
  }
}
