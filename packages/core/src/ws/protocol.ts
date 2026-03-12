// WebSocket Protocol — Message validation and type guards

import type { WsMessage, WsSubscribe, WsError } from './types.js'

const BUILTIN_TYPES = ['subscribe', 'unsubscribe', 'ping', 'pong', 'error', 'ack'] as const

export function isWsMessage(msg: unknown): msg is WsMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as WsMessage).type === 'string'
}

export function isWsSubscribe(msg: unknown): msg is WsSubscribe {
  return isWsMessage(msg) && msg.type === 'subscribe' && Array.isArray((msg as WsSubscribe).channels)
}

export function isWsError(msg: unknown): msg is WsError {
  return (
    isWsMessage(msg) &&
    msg.type === 'error' &&
    typeof (msg as WsError).code === 'string' &&
    typeof (msg as WsError).message === 'string'
  )
}

export function isBuiltinType(type: string): boolean {
  return (BUILTIN_TYPES as readonly string[]).includes(type)
}

export function validateMessage(msg: unknown): { valid: boolean; error?: string } {
  if (typeof msg !== 'object' || msg === null) {
    return { valid: false, error: 'Message must be a non-null object' }
  }
  if (typeof (msg as WsMessage).type !== 'string') {
    return { valid: false, error: 'Message must have a string type field' }
  }
  // Check JSON-serializability
  try {
    JSON.stringify(msg)
  } catch {
    return { valid: false, error: 'Message must be JSON-serializable' }
  }
  return { valid: true }
}
