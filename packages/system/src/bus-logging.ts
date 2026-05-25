// Bus-level logging: wildcard subscriber for debug logs + targeted info
// loggers for well-known event types. Kept here so the entry point only
// has to call `wireBusLogging(...)`.

import type { EventBus } from '@sovereign/core'
import { createLogger } from './logger.js'
import type { LogsChannel } from './ws.js'

export function wireBusLogging(bus: EventBus, logsChannel: LogsChannel): void {
  const sysLogger = createLogger(logsChannel, 'bus')
  bus.on('*', (event) => {
    if (event.type === 'log.entry') return
    sysLogger.debug(`${event.type}`, { metadata: { source: event.source } })
  })

  const moduleLogger = createLogger(logsChannel, 'modules')

  bus.on('issue.created', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.info(`Issue created: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
  })

  bus.on('issue.updated', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.info(`Issue updated: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
  })

  bus.on('review.merged', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.info(`Review merged: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
  })

  bus.on('scheduler.job.failed', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.error(`Scheduled job failed: ${payload?.jobName ?? 'unknown'}`)
  })

  bus.on('config.changed', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.info(`Config changed: ${payload?.key ?? 'unknown'}`)
  })

  bus.on('webhook.received', (event) => {
    const payload = event.payload as Record<string, unknown>
    moduleLogger.info(`Webhook received from ${event.source}`, { metadata: { type: payload?.type } })
  })
}
