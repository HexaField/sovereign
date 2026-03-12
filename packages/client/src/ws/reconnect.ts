// Exponential backoff reconnection

export interface Reconnector {
  start(): void
  stop(): void
  onReconnect(handler: () => void): () => void
}

export function createReconnector(): Reconnector {
  throw new Error('not implemented')
}
