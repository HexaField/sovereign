import { describe, it, expect, vi } from 'vitest'
import { createLogger } from './logger.js'
import type { LogsChannel } from './ws.js'

function createMockLogsChannel(): LogsChannel & { _entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = []
  return {
    _entries: entries,
    log(entry) {
      entries.push(entry as Record<string, unknown>)
    },
    getBuffer() {
      return []
    }
  }
}

describe('Logger', () => {
  describe('createLogger factory', () => {
    it('returns object with debug/info/warn/error methods', () => {
      const ch = createMockLogsChannel()
      const logger = createLogger(ch, 'test')
      expect(typeof logger.debug).toBe('function')
      expect(typeof logger.info).toBe('function')
      expect(typeof logger.warn).toBe('function')
      expect(typeof logger.error).toBe('function')
    })

    it('each log level calls logsChannel.log with correct level', () => {
      const ch = createMockLogsChannel()
      const logSpy = vi.spyOn(ch, 'log')
      const logger = createLogger(ch, 'mymod')

      logger.debug('d')
      logger.info('i')
      logger.warn('w')
      logger.error('e')

      expect(logSpy).toHaveBeenCalledTimes(4)
      expect(ch._entries[0]).toMatchObject({ level: 'debug', message: 'd', module: 'mymod' })
      expect(ch._entries[1]).toMatchObject({ level: 'info', message: 'i', module: 'mymod' })
      expect(ch._entries[2]).toMatchObject({ level: 'warn', message: 'w', module: 'mymod' })
      expect(ch._entries[3]).toMatchObject({ level: 'error', message: 'e', module: 'mymod' })
    })

    it('metadata is passed through', () => {
      const ch = createMockLogsChannel()
      const logger = createLogger(ch, 'test')
      logger.info('hello', { metadata: { key: 'val' } })
      expect(ch._entries[0]).toMatchObject({ metadata: { key: 'val' } })
    })

    it('module name is set on every entry', () => {
      const ch = createMockLogsChannel()
      const logger = createLogger(ch, 'specific-mod')
      logger.debug('a')
      logger.error('b')
      expect(ch._entries[0]).toMatchObject({ module: 'specific-mod' })
      expect(ch._entries[1]).toMatchObject({ module: 'specific-mod' })
    })
  })
})
