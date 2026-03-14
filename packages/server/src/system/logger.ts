// Logger factory — §7 Observability
// createLogger wraps a LogsChannel with module-scoped convenience methods

import type { LogsChannel } from './ws.js'

export interface Logger {
  debug(message: string, opts?: LogOpts): void
  info(message: string, opts?: LogOpts): void
  warn(message: string, opts?: LogOpts): void
  error(message: string, opts?: LogOpts): void
}

export interface LogOpts {
  entityId?: string
  threadKey?: string
  metadata?: Record<string, unknown>
}

export function createLogger(logsChannel: LogsChannel, moduleName: string): Logger {
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, opts?: LogOpts): void => {
    logsChannel.log({
      level,
      module: moduleName,
      message,
      ...(opts?.entityId !== undefined ? { entityId: opts.entityId } : {}),
      ...(opts?.threadKey !== undefined ? { threadKey: opts.threadKey } : {}),
      ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {})
    })
  }

  return {
    debug: (message, opts) => log('debug', message, opts),
    info: (message, opts) => log('info', message, opts),
    warn: (message, opts) => log('warn', message, opts),
    error: (message, opts) => log('error', message, opts)
  }
}
