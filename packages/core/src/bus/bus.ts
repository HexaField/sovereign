import type { BusEvent, BusHandler, EventBus, Unsubscribe } from './types.js'
import { createEventLogger, matchPattern, type EventLogger } from './logger.js'

interface Subscriber {
  pattern: string
  handler: BusHandler
  once: boolean
  queue: BusEvent[]
  processing: boolean
}

export const createEventBus = (dataDir: string): EventBus => {
  const logger: EventLogger = createEventLogger(dataDir)
  const subscribers: Set<Subscriber> = new Set()
  const eventHistory: BusEvent[] = []
  const MAX_HISTORY = 1000

  const emitError = (originalEvent: BusEvent, err: unknown): void => {
    if (originalEvent.type !== 'bus.error') {
      emit({
        type: 'bus.error',
        timestamp: new Date().toISOString(),
        source: 'bus',
        payload: { originalEvent, error: err instanceof Error ? err.message : String(err) }
      })
    }
  }

  const processQueue = (sub: Subscriber): void => {
    if (sub.processing) return
    sub.processing = true
    const drain = (): void => {
      while (sub.queue.length > 0) {
        const event = sub.queue.shift()!
        try {
          const result = sub.handler(event)
          if (result && typeof (result as Promise<void>).then === 'function') {
            // Async handler — wait for it, then continue draining
            sub.processing = true
            ;(result as Promise<void>)
              .catch((err) => {
                emitError(event, err)
              })
              .finally(() => {
                drain()
              })
            return
          }
        } catch (err) {
          emitError(event, err)
        }
      }
      sub.processing = false
    }
    drain()
  }

  const emit = (event: BusEvent): void => {
    eventHistory.push(event)
    if (eventHistory.length > MAX_HISTORY) eventHistory.shift()

    // Log to disk (but not bus.error to avoid noise — actually spec says every event)
    logger.log(event)

    for (const sub of subscribers) {
      if (!matchPattern(event.type, sub.pattern)) continue

      sub.queue.push(event)

      if (sub.once) {
        subscribers.delete(sub)
      }

      processQueue(sub)
    }
  }

  const on = (pattern: string, handler: BusHandler): Unsubscribe => {
    const sub: Subscriber = { pattern, handler, once: false, queue: [], processing: false }
    subscribers.add(sub)
    return () => {
      subscribers.delete(sub)
    }
  }

  const once = (pattern: string, handler: BusHandler): Unsubscribe => {
    const sub: Subscriber = { pattern, handler, once: true, queue: [], processing: false }
    subscribers.add(sub)
    return () => {
      subscribers.delete(sub)
    }
  }

  const replay = (filter: { pattern?: string; after?: string; before?: string }): AsyncIterable<BusEvent> => {
    return logger.read(filter)
  }

  const history = (filter: { pattern?: string; limit?: number }): BusEvent[] => {
    let results = eventHistory
    if (filter.pattern) {
      results = results.filter((e) => matchPattern(e.type, filter.pattern!))
    }
    if (filter.limit) {
      results = results.slice(-filter.limit)
    }
    return [...results]
  }

  return { emit, on, once, replay, history }
}
