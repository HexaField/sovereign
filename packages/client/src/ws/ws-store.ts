// Reactive SolidJS WebSocket store

import type { WsMessage } from '@template/core'

export interface WsStore {
  connected: () => boolean
  subscribe(channels: string[], scope?: Record<string, string>): void
  unsubscribe(channels: string[]): void
  on<T extends WsMessage>(type: string, handler: (msg: T) => void): () => void
  send(msg: WsMessage): void
}

export function createWsStore(): WsStore {
  throw new Error('not implemented')
}
