import { describe, it, expect } from 'vitest'
import { deriveSessionKey } from './derive-session-key.js'

// Bare-UUID scheme: `deriveSessionKey` is a coercion to the bare thread id.
// Threads are keyed by their UUID end-to-end; the legacy compound
// `agent:main:thread:<x>` / `agent:main:main` forms are stripped for any
// lingering caller or pre-migration on-disk reference.
describe('deriveSessionKey', () => {
  it('passes a bare id (UUID or label) through unchanged', () => {
    expect(deriveSessionKey('adam')).toBe('adam')
    expect(deriveSessionKey('d4d2e517-06ee-4bcb-9f81-fa6410161a2d')).toBe('d4d2e517-06ee-4bcb-9f81-fa6410161a2d')
  })

  it('strips the legacy agent:main:thread: prefix to the bare id', () => {
    expect(deriveSessionKey('agent:main:thread:adam')).toBe('adam')
  })

  it('coerces the legacy agent:main:main alias to the bare "main"', () => {
    expect(deriveSessionKey('main')).toBe('main')
    expect(deriveSessionKey('agent:main:main')).toBe('main')
  })

  it('strips the legacy agent:main:subagent: prefix to the bare id', () => {
    expect(deriveSessionKey('agent:main:subagent:abc')).toBe('abc')
  })

  it('handles empty string by returning empty', () => {
    expect(deriveSessionKey('')).toBe('')
  })

  it('passes through unrecognised agent:-prefixed keys verbatim', () => {
    expect(deriveSessionKey('agent:main:cron:123')).toBe('agent:main:cron:123')
  })
})
