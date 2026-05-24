// Backend-agnostic typed event emitter used by every adapter.

import type { AgentBackendEvents, AgentBackendKind } from '@sovereign/core'

export interface BackendEmitter {
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  emit<K extends keyof AgentBackendEvents>(event: K, data: AgentBackendEvents[K]): void
}

/**
 * Create an emitter that stamps every emitted event with the owning `backendKind`,
 * so the routing layer can demultiplex events from multiple backends.
 */
export function createBackendEmitter(kind: AgentBackendKind): BackendEmitter {
  const listeners = new Map<string, Set<(data: any) => void>>()

  return {
    on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler as any)
    },
    off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      listeners.get(event)?.delete(handler as any)
    },
    emit<K extends keyof AgentBackendEvents>(event: K, data: AgentBackendEvents[K]) {
      const stamped = { ...(data as object), backendKind: kind } as AgentBackendEvents[K]
      listeners.get(event)?.forEach((fn) => fn(stamped))
    }
  }
}
