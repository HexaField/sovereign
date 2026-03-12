// WebSocket Protocol — Message validation and type guards

import type { WsMessage, WsSubscribe, WsError } from './types.js'

export function isWsMessage(_msg: unknown): _msg is WsMessage {
  throw new Error('not implemented')
}

export function isWsSubscribe(_msg: unknown): _msg is WsSubscribe {
  throw new Error('not implemented')
}

export function isWsError(_msg: unknown): _msg is WsError {
  throw new Error('not implemented')
}

export function validateMessage(_msg: unknown): { valid: boolean; error?: string } {
  throw new Error('not implemented')
}
