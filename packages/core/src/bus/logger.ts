import { mkdirSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BusEvent } from './types.js'

export interface EventLogger {
  log(event: BusEvent): void
  read(filter: { pattern?: string; after?: string; before?: string }): AsyncIterable<BusEvent>
}

const matchPattern = (type: string, pattern: string): boolean => {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return type === prefix || type.startsWith(prefix + '.')
  }
  return type === pattern
}

const dateFromISO = (iso: string): string => iso.slice(0, 10)

export const createEventLogger = (dataDir: string): EventLogger => {
  const eventsDir = join(dataDir, 'events')
  mkdirSync(eventsDir, { recursive: true })

  const log = (event: BusEvent): void => {
    const dateStr = dateFromISO(event.timestamp)
    const filePath = join(eventsDir, `${dateStr}.jsonl`)
    appendFileSync(filePath, JSON.stringify(event) + '\n')
  }

  const read = async function* (filter: {
    pattern?: string
    after?: string
    before?: string
  }): AsyncIterable<BusEvent> {
    if (!existsSync(eventsDir)) return

    const files = readdirSync(eventsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()

    for (const file of files) {
      const filePath = join(eventsDir, file)
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      for (const line of lines) {
        const event: BusEvent = JSON.parse(line)

        if (filter.after && event.timestamp <= filter.after) continue
        if (filter.before && event.timestamp >= filter.before) continue
        if (filter.pattern && !matchPattern(event.type, filter.pattern)) continue

        yield event
      }
    }
  }

  return { log, read }
}

export { matchPattern }
