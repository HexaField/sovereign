// Logs WS channel — §9.3

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

export interface LogEntry {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  module: string
  message: string
  entityId?: string
  threadKey?: string
  metadata?: Record<string, unknown>
}

export interface LogsChannel {
  log(entry: Omit<LogEntry, 'timestamp'>): void
  getBuffer(): LogEntry[]
}

const MAX_BUFFER = 1000

function getLogFileName(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}.jsonl`
}

export function registerLogsChannel(ws: WsHandler, bus: EventBus, dataDir?: string): LogsChannel {
  const buffer: LogEntry[] = []
  let logsDir: string | null = null

  if (dataDir) {
    logsDir = path.join(dataDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
  }

  ws.registerChannel('logs', {
    serverMessages: ['log.entry', 'log.history'],
    clientMessages: [],
    onSubscribe: (deviceId) => {
      ws.sendTo(deviceId, {
        type: 'log.history',
        entries: [...buffer],
        timestamp: new Date().toISOString()
      })
    }
  })

  const log = (entry: Omit<LogEntry, 'timestamp'>): void => {
    const full: LogEntry = { ...entry, timestamp: Date.now() }
    buffer.push(full)
    if (buffer.length > MAX_BUFFER) buffer.shift()

    // Persist to daily JSONL
    if (logsDir) {
      const fileName = getLogFileName()
      const filePath = path.join(logsDir, fileName)
      fs.appendFileSync(filePath, JSON.stringify(full) + '\n')
    }

    ws.broadcastToChannel('logs', {
      type: 'log.entry',
      ...full,
      timestamp: new Date().toISOString()
    })

    bus.emit({
      type: 'log.entry',
      timestamp: new Date().toISOString(),
      source: 'logs',
      payload: full
    })
  }

  const getBuffer = (): LogEntry[] => [...buffer]

  return { log, getBuffer }
}

/** Read persisted logs from daily JSONL files */
export function readPersistedLogs(
  dataDir: string,
  filter?: { level?: string; module?: string; since?: string; limit?: number; offset?: number }
): LogEntry[] {
  const logsDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logsDir)) return []

  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
  const entries: LogEntry[] = []

  for (const file of files) {
    const content = fs.readFileSync(path.join(logsDir, file), 'utf-8').trim()
    if (!content) continue
    for (const line of content.split('\n')) {
      try {
        entries.push(JSON.parse(line) as LogEntry)
      } catch {
        /* skip malformed */
      }
    }
  }

  let result = entries
  if (filter?.level) result = result.filter((e) => e.level === filter.level)
  if (filter?.module) result = result.filter((e) => e.module === filter.module)
  if (filter?.since) {
    const sinceTs = new Date(filter.since).getTime()
    result = result.filter((e) => e.timestamp >= sinceTs)
  }

  const offset = filter?.offset ?? 0
  const limit = filter?.limit ?? result.length
  return result.slice(offset, offset + limit)
}
