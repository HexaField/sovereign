import { describe, it } from 'vitest'

describe('Config Schema', () => {
  describe('validation', () => {
    it.todo('accepts valid full config')
    it.todo('accepts config with only some keys (defaults fill rest)')
    it.todo('rejects non-object config')
    it.todo('rejects invalid server.port type')
    it.todo('rejects negative port number')
    it.todo('rejects invalid terminal.shell type')
    it.todo('rejects invalid worktrees.staleDays type')
    it.todo('returns detailed error messages for each violation')
    it.todo('rejects unknown top-level keys')
  })
})
