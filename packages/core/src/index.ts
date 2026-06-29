export * from './bus/index.js'
export * from './ws/types.js'
export { isWsMessage, isWsSubscribe, isWsError, isBuiltinType, validateMessage } from './ws/protocol.js'
export * from './agent-backend.js'
export * from './shared.js'
export * from './transcription.js'
export * from './cron.js'
export * from './session-key.js'
export * from './thread.js'
export * from './message-origin.js'

/**
 * A message in the server-side queue waiting to be sent to the agent.
 *
 * State machine:
 *   queued → sending → (removed on success | failed)
 *
 * `failed` entries remain in the queue (with `error`) until the client
 * explicitly retries or cancels them.
 */
export interface QueuedMessage {
  id: string
  threadId: string
  text: string
  timestamp: number
  status: 'queued' | 'sending' | 'failed'
  error?: string
  /** Number of send attempts so far (0 = never tried). */
  attempts?: number
  /** How this message arrived (voice, AD4M mention, webhook, etc.).
   *  Used by the presence thread to choose a reply tool; absent on normal
   *  text sends. See `plans/presence-thread-spec.md`. */
  origin?: import('./message-origin.js').MessageOrigin
}

/**
 * SSE/WS payload broadcast whenever a thread's queue changes.
 * The client uses this to render queued+sending+failed messages as a
 * single source of truth, replacing the previous client-side optimistic queue.
 */
export interface ChatQueueSnapshot {
  threadId: string
  items: QueuedMessage[]
}
