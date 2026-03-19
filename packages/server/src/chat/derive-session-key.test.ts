import { describe, it, expect } from 'vitest'
import { deriveSessionKey } from './derive-session-key.js'

describe('deriveSessionKey', () => {
  it('maps "main" to "agent:main:main"', () => {
    expect(deriveSessionKey('main')).toBe('agent:main:main')
  })

  it('maps a short thread name to agent:main:thread:<name>', () => {
    expect(deriveSessionKey('adam')).toBe('agent:main:thread:adam')
  })

  it('passes through already-qualified thread keys', () => {
    expect(deriveSessionKey('agent:main:thread:adam')).toBe('agent:main:thread:adam')
  })

  it('passes through agent:main:main', () => {
    expect(deriveSessionKey('agent:main:main')).toBe('agent:main:main')
  })

  it('handles empty string as a thread name', () => {
    expect(deriveSessionKey('')).toBe('agent:main:thread:')
  })

  it('passes through other agent:-prefixed keys', () => {
    expect(deriveSessionKey('agent:main:cron:123')).toBe('agent:main:cron:123')
    expect(deriveSessionKey('agent:main:subagent:abc')).toBe('agent:main:subagent:abc')
  })
})
