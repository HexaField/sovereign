import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebhookEvent } from './types.js'

export interface WebhookStore {
  persist(event: WebhookEvent): void
  list(filter?: { source?: string; classification?: string; limit?: number }): WebhookEvent[]
  get(eventId: string): WebhookEvent | undefined
}

export const createWebhookStore = (dataDir: string): WebhookStore => {
  const eventsDir = join(dataDir, 'webhooks', 'events')
  mkdirSync(eventsDir, { recursive: true })

  const dateFile = (date: string): string => {
    const day = date.slice(0, 10) // YYYY-MM-DD
    return join(eventsDir, `${day}.jsonl`)
  }

  const persist = (event: WebhookEvent): void => {
    const file = dateFile(event.receivedAt)
    appendFileSync(file, JSON.stringify(event) + '\n')
  }

  const readAll = (): WebhookEvent[] => {
    if (!existsSync(eventsDir)) return []
    const files = readdirSync(eventsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    const events: WebhookEvent[] = []
    for (const file of files) {
      const content = readFileSync(join(eventsDir, file), 'utf-8').trim()
      if (!content) continue
      for (const line of content.split('\n')) {
        if (line.trim()) events.push(JSON.parse(line))
      }
    }
    return events
  }

  const list = (filter?: { source?: string; classification?: string; limit?: number }): WebhookEvent[] => {
    let events = readAll()
    if (filter?.source) events = events.filter((e) => e.source === filter.source)
    if (filter?.classification) events = events.filter((e) => e.classification === filter.classification)
    if (filter?.limit) events = events.slice(-filter.limit)
    return events
  }

  const get = (eventId: string): WebhookEvent | undefined => {
    return readAll().find((e) => e.id === eventId)
  }

  return { persist, list, get }
}
