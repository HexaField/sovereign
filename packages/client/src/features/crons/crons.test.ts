import { describe, it, expect } from 'vitest'
import { deriveThreadKey, detectCronIssues, buildFixToThreadPatch } from './types.js'

describe('deriveThreadKey', () => {
  it('extracts key from session:agent:main:thread:<key>', () => {
    expect(deriveThreadKey('session:agent:main:thread:v2-app')).toBe('v2-app')
  })

  it('extracts key from agent:main:thread:<key>', () => {
    expect(deriveThreadKey(undefined, 'agent:main:thread:upgrades')).toBe('upgrades')
  })

  it('prefers sessionTarget over sessionKey', () => {
    expect(deriveThreadKey('session:agent:main:thread:from-target', 'agent:main:thread:from-key')).toBe('from-target')
  })

  it('returns null for isolated sessions', () => {
    expect(deriveThreadKey('isolated')).toBeNull()
  })

  it('returns null for main sessions', () => {
    expect(deriveThreadKey('main')).toBeNull()
  })

  it('returns null when both are undefined', () => {
    expect(deriveThreadKey(undefined, undefined)).toBeNull()
  })

  it('returns null for agent:main:main', () => {
    expect(deriveThreadKey('agent:main:main')).toBeNull()
  })

  it('handles hyphenated thread keys', () => {
    expect(deriveThreadKey('session:agent:main:thread:my-cool-thread')).toBe('my-cool-thread')
  })
})

describe('detectCronIssues', () => {
  const baseJob = {
    id: 'test-1',
    name: 'Test Job',
    enabled: true,
    schedule: { kind: 'cron', expr: '*/5 * * * *' },
    payload: { kind: 'agentTurn', message: 'hello' },
    delivery: { mode: 'announce', channel: 'webchat' },
    sessionTarget: 'session:agent:main:thread:v2-app',
    state: { lastStatus: 'ok' }
  }

  it('returns empty array for healthy cron', () => {
    expect(detectCronIssues(baseJob)).toEqual([])
  })

  it('detects missing-channel when no delivery', () => {
    const job = { ...baseJob, delivery: undefined }
    expect(detectCronIssues(job)).toContain('missing-channel')
  })

  it('detects missing-channel when channel is empty', () => {
    const job = { ...baseJob, delivery: { mode: 'announce' } }
    expect(detectCronIssues(job)).toContain('missing-channel')
  })

  it('detects wrong-session-target for isolated', () => {
    const job = { ...baseJob, sessionTarget: 'isolated' }
    expect(detectCronIssues(job)).toContain('wrong-session-target')
  })

  it('detects wrong-session-target for main', () => {
    const job = { ...baseJob, sessionTarget: 'main' }
    expect(detectCronIssues(job)).toContain('wrong-session-target')
  })

  it('detects system-event-on-thread', () => {
    const job = {
      ...baseJob,
      payload: { kind: 'systemEvent', text: 'check status' },
      sessionTarget: 'session:agent:main:thread:v2-app'
    }
    expect(detectCronIssues(job)).toContain('system-event-on-thread')
  })

  it('does NOT flag system-event when not on thread', () => {
    const job = {
      ...baseJob,
      payload: { kind: 'systemEvent', text: 'check status' },
      sessionTarget: 'isolated'
    }
    // Should have wrong-session-target but NOT system-event-on-thread (no thread key)
    const issues = detectCronIssues(job)
    expect(issues).not.toContain('system-event-on-thread')
  })

  it('detects disabled-after-error', () => {
    const job = { ...baseJob, enabled: false, state: { lastStatus: 'error' } }
    expect(detectCronIssues(job)).toContain('disabled-after-error')
  })

  it('does NOT flag disabled-after-error when status is ok', () => {
    const job = { ...baseJob, enabled: false, state: { lastStatus: 'ok' } }
    expect(detectCronIssues(job)).not.toContain('disabled-after-error')
  })

  it('can detect multiple issues at once', () => {
    const job = {
      ...baseJob,
      delivery: undefined,
      sessionTarget: 'isolated',
      enabled: false,
      state: { lastStatus: 'error' }
    }
    const issues = detectCronIssues(job)
    expect(issues).toContain('missing-channel')
    expect(issues).toContain('wrong-session-target')
    expect(issues).toContain('disabled-after-error')
  })
})

describe('buildFixToThreadPatch', () => {
  const baseJob = {
    id: 'test-1',
    name: 'Test Job',
    enabled: true,
    schedule: { kind: 'cron', expr: '*/5 * * * *' },
    payload: { kind: 'agentTurn', message: 'check status' },
    delivery: { mode: 'announce', channel: 'webchat' },
    sessionTarget: 'isolated',
    threadKey: null as string | null,
    issues: ['wrong-session-target' as const, 'missing-channel' as const]
  }

  it('sets correct sessionTarget', () => {
    const patch = buildFixToThreadPatch(baseJob, 'v2-app')
    expect(patch.sessionTarget).toBe('session:agent:main:thread:v2-app')
  })

  it('sets delivery to announce/webchat', () => {
    const patch = buildFixToThreadPatch(baseJob, 'v2-app')
    expect(patch.delivery).toEqual({ mode: 'announce', channel: 'webchat' })
  })

  it('preserves agentTurn payload', () => {
    const patch = buildFixToThreadPatch(baseJob, 'v2-app')
    const payload = patch.payload as Record<string, unknown>
    expect(payload.kind).toBe('agentTurn')
    expect(payload.message).toBe('check status')
  })

  it('converts systemEvent to agentTurn', () => {
    const job = {
      ...baseJob,
      payload: { kind: 'systemEvent', text: 'check status' }
    }
    const patch = buildFixToThreadPatch(job, 'v2-app')
    const payload = patch.payload as Record<string, unknown>
    expect(payload.kind).toBe('agentTurn')
    expect(payload.message).toBe('check status')
    expect(payload.text).toBeUndefined()
  })

  it('does not overwrite existing message with text on systemEvent conversion', () => {
    const job = {
      ...baseJob,
      payload: { kind: 'systemEvent', text: 'old text', message: 'existing message' }
    }
    const patch = buildFixToThreadPatch(job, 'v2-app')
    const payload = patch.payload as Record<string, unknown>
    expect(payload.kind).toBe('agentTurn')
    expect(payload.message).toBe('existing message')
  })
})
