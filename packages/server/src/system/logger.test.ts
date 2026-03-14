import { describe, it } from 'vitest'

describe('Logger', () => {
  describe('createLogger factory', () => {
    it.todo('returns object with debug/info/warn/error methods')
    it.todo('each log level calls logsChannel.log with correct level')
    it.todo('metadata is passed through')
    it.todo('module name is set on every entry')
  })
})
