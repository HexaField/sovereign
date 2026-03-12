// Event Bus — Type Definitions

export interface BusEvent {
  type: string
  timestamp: string
  source: string
  payload: unknown
}

export type Unsubscribe = () => void

export type BusHandler = (event: BusEvent) => void | Promise<void>

export interface EventBus {
  emit(event: BusEvent): void
  on(pattern: string, handler: BusHandler): Unsubscribe
  once(pattern: string, handler: BusHandler): Unsubscribe
  replay(filter: { pattern?: string; after?: string; before?: string }): AsyncIterable<BusEvent>
  history(filter: { pattern?: string; limit?: number }): BusEvent[]
}

export interface ModuleStatus {
  name: string
  status: 'ok' | 'degraded' | 'error'
  metrics?: Record<string, unknown>
}
