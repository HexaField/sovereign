export * from './bus/index.js'
export * from './ws/types.js'
export { isWsMessage, isWsSubscribe, isWsError, isBuiltinType, validateMessage } from './ws/protocol.js'
export * from './agent-backend.js'
export * from './shared.js'
export * from './transcription.js'
export * from './cron.js'
export * from './session-key.js'

/**
 * A message in the server-side queue waiting to be sent to the agent.
 */
export interface QueuedMessage {
  id: string
  threadKey: string
  text: string
  timestamp: number
  status: 'queued' | 'sending'
}
