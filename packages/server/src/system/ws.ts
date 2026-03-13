// Logs WS channel — §9.3

import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export interface LogEntry {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  module: string
  message: string
}

export interface LogsChannel {
  log(entry: Omit<LogEntry, 'timestamp'>): void
  getBuffer(): LogEntry[]
}

const MAX_BUFFER = 1000

export function registerLogsChannel(ws: WsHandler, bus: EventBus): LogsChannel {
  const buffer: LogEntry[] = []

  ws.registerChannel('logs', {
    serverMessages: ['log.entry', 'log.history'],
    clientMessages: [],
    onSubscribe: (deviceId) => {
      // Send buffered entries to new subscriber
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
