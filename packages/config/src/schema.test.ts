import { describe, it, expect } from 'vitest'
import { validate, invalidConfigPaths } from './schema.js'
import { defaults } from './defaults.js'

describe('Config Schema', () => {
  describe('validation', () => {
    it('accepts valid full config', () => {
      const result = validate(defaults)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('accepts config with only some keys (defaults fill rest)', () => {
      const result = validate({ server: { port: 3001, host: 'localhost' } })
      expect(result.valid).toBe(true)
    })

    it('rejects non-object config', () => {
      expect(validate('string').valid).toBe(false)
      expect(validate(null).valid).toBe(false)
      expect(validate(42).valid).toBe(false)
    })

    it('rejects invalid server.port type', () => {
      const result = validate({ server: { port: 'not-a-number', host: 'localhost' } })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('rejects negative port number', () => {
      const result = validate({ server: { port: -1, host: 'localhost' } })
      expect(result.valid).toBe(false)
    })

    it('rejects invalid terminal.shell type', () => {
      const result = validate({ terminal: { shell: 123 } })
      expect(result.valid).toBe(false)
    })

    it('rejects invalid worktrees.staleDays type', () => {
      const result = validate({ worktrees: { staleDays: 'fourteen' } })
      expect(result.valid).toBe(false)
    })

    it('returns detailed error messages for each violation', () => {
      const result = validate({ server: { port: 'bad', host: 123 } })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    })

    it('rejects unknown top-level keys', () => {
      const result = validate({ unknownKey: true })
      expect(result.valid).toBe(false)
    })
  })

  describe('invalidConfigPaths', () => {
    it('returns [] for valid config', () => {
      expect(invalidConfigPaths(defaults)).toEqual([])
      expect(invalidConfigPaths({ server: { port: 3001, host: 'localhost' } })).toEqual([])
    })

    it('returns [] for a non-object', () => {
      expect(invalidConfigPaths('nope')).toEqual([])
    })

    it('points at the bad leaf for a type/enum violation', () => {
      expect(invalidConfigPaths({ server: { port: 'bad' } })).toContain('/server/port')
    })

    it('points at the offending child key for additionalProperties violations', () => {
      // The dead key itself, not the whole /agentBackend section.
      const paths = invalidConfigPaths({ agentBackend: { openclaw: { gatewayUrl: 'ws://x' } } })
      expect(paths).toContain('/agentBackend/openclaw')
      expect(paths).not.toContain('/agentBackend')
    })

    it('trims an invalid array item back to the array key', () => {
      // /agentBackend/enabled/0 → /agentBackend/enabled, so the field is dropped
      // wholesale and defaults restore a coherent value.
      const paths = invalidConfigPaths({ agentBackend: { enabled: ['openclaw'] } })
      expect(paths).toContain('/agentBackend/enabled')
      expect(paths).not.toContain('/agentBackend/enabled/0')
    })
  })
})
