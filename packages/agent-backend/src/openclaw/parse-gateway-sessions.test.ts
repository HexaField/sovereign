import { describe, it, expect } from 'vitest'
import {
  parseSessionEntry,
  filterMainAndThread,
  mergeWithLocal,
  effectiveStatus,
  STALE_RUNNING_MS
} from './parse-gateway-sessions.js'

describe('parseSessionEntry', () => {
  it('parses agent:main:main as kind=main, shortKey=main', () => {
    const s = parseSessionEntry('agent:main:main', {})
    expect(s.kind).toBe('main')
    expect(s.shortKey).toBe('main')
    expect(s.key).toBe('agent:main:main')
  })

  it('parses agent:main:thread:adam as kind=thread, shortKey=adam', () => {
    const s = parseSessionEntry('agent:main:thread:adam', {})
    expect(s.kind).toBe('thread')
    expect(s.shortKey).toBe('adam')
  })

  it('parses agent:main:cron:123 as kind=cron', () => {
    const s = parseSessionEntry('agent:main:cron:123', {})
    expect(s.kind).toBe('cron')
  })

  it('parses agent:main:subagent:abc as kind=subagent', () => {
    const s = parseSessionEntry('agent:main:subagent:abc', {})
    expect(s.kind).toBe('subagent')
  })

  it('uses meta.label when present', () => {
    const s = parseSessionEntry('agent:main:thread:x', { label: 'My Thread' })
    expect(s.label).toBe('My Thread')
  })

  it('falls back to shortKey when no label', () => {
    const s = parseSessionEntry('agent:main:thread:x', {})
    expect(s.label).toBe('x')
  })

  it('picks up lastActivity from updatedAt or createdAt', () => {
    expect(parseSessionEntry('agent:main:main', { updatedAt: 100 }).lastActivity).toBe(100)
    expect(parseSessionEntry('agent:main:main', { createdAt: 50 }).lastActivity).toBe(50)
    expect(parseSessionEntry('agent:main:main', { updatedAt: 100, createdAt: 50 }).lastActivity).toBe(100)
  })
})

describe('filterMainAndThread', () => {
  it('keeps only main and thread sessions', () => {
    const sessions = [
      parseSessionEntry('agent:main:main', {}),
      parseSessionEntry('agent:main:thread:adam', {}),
      parseSessionEntry('agent:main:cron:123', {}),
      parseSessionEntry('agent:main:subagent:abc', {})
    ]
    const filtered = filterMainAndThread(sessions)
    expect(filtered).toHaveLength(2)
    expect(filtered.map((s) => s.kind)).toEqual(['main', 'thread'])
  })

  it('returns empty for no main/thread sessions', () => {
    const sessions = [parseSessionEntry('agent:main:cron:x', {})]
    expect(filterMainAndThread(sessions)).toHaveLength(0)
  })
})

describe('mergeWithLocal', () => {
  it('marks matched local thread as isRegistered with orgId', () => {
    const sessions = [parseSessionEntry('agent:main:thread:adam', {})]
    const local = [{ key: 'adam', orgId: 'org1', label: 'Adam Thread' }]
    const merged = mergeWithLocal(sessions, local)
    expect(merged[0].isRegistered).toBe(true)
    expect(merged[0].orgId).toBe('org1')
    expect(merged[0].localLabel).toBe('Adam Thread')
  })

  it('marks unmatched session as isRegistered=false', () => {
    const sessions = [parseSessionEntry('agent:main:thread:unknown', {})]
    const merged = mergeWithLocal(sessions, [])
    expect(merged[0].isRegistered).toBe(false)
    expect(merged[0].orgId).toBeUndefined()
  })

  it('matches by short key', () => {
    const sessions = [parseSessionEntry('agent:main:thread:bob', {})]
    const local = [{ key: 'bob', orgId: 'o2' }]
    const merged = mergeWithLocal(sessions, local)
    expect(merged[0].isRegistered).toBe(true)
  })

  it('matches by full key for main', () => {
    const sessions = [parseSessionEntry('agent:main:main', {})]
    const local = [{ key: 'main', orgId: 'global' }]
    const merged = mergeWithLocal(sessions, local)
    expect(merged[0].isRegistered).toBe(true)
    expect(merged[0].orgId).toBe('global')
  })
})

describe('effectiveStatus', () => {
  const now = 1_000_000_000_000

  it('passes through non-running statuses unchanged regardless of age', () => {
    expect(effectiveStatus('done', now - STALE_RUNNING_MS * 10, now)).toBe('done')
    expect(effectiveStatus('failed', now - STALE_RUNNING_MS * 10, now)).toBe('failed')
    expect(effectiveStatus('idle', undefined, now)).toBe('idle')
    expect(effectiveStatus(undefined, now, now)).toBeUndefined()
  })

  it('passes through fresh `running` sessions', () => {
    expect(effectiveStatus('running', now - 1000, now)).toBe('running')
    expect(effectiveStatus('running', now - STALE_RUNNING_MS + 1, now)).toBe('running')
  })

  it('coerces stale `running` to `failed`', () => {
    expect(effectiveStatus('running', now - STALE_RUNNING_MS - 1, now)).toBe('failed')
    expect(effectiveStatus('running', now - STALE_RUNNING_MS * 100, now)).toBe('failed')
  })

  it('leaves `running` alone when lastActivity is missing (cannot judge staleness)', () => {
    expect(effectiveStatus('running', undefined, now)).toBe('running')
    expect(effectiveStatus('running', 0, now)).toBe('running')
  })
})
