// Bus event → timeline entry. Made-up threads, repos and logins only.

import type { BusEvent } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { mapEvent, TIMELINE_EVENT_TYPES } from './mapping.js'

const AT = '2026-10-26T09:00:00.000Z'
const ev = (type: string, payload: unknown): BusEvent => ({ type, timestamp: AT, source: 'test', payload })
const labels: Record<string, string> = { t1: 'Widget work', parent: 'Release prep', rt: 'forge-rethink' }
const ctx = { labelOf: (id: string) => labels[id] }
const map = (type: string, payload: unknown) => mapEvent(ev(type, payload), ctx)
const one = (type: string, payload: unknown) => {
  const out = map(type, payload)
  expect(out).toHaveLength(1)
  return out[0]!
}

describe('agent turns', () => {
  it('a turn start names the thread, its origin and what started it', () => {
    expect(
      one('chat.turn.started', { threadId: 't1', via: 'user', modality: 'voice', preview: 'Fix the gear ratio' })
    ).toEqual({
      at: AT,
      kind: 'agent',
      action: 'turn.started',
      title: 'Widget work: turn started (voice)',
      detail: 'Fix the gear ratio',
      threadId: 't1',
      threadLabel: 'Widget work',
      origin: 'user'
    })
  })

  it.each([
    ['user', 'Widget work: turn started'],
    ['cron', 'Widget work: turn started by a cron job'],
    ['rethink', 'Widget work: turn started by Forge rethink'],
    ['agent', 'Widget work: turn started by another thread'],
    ['subagent', 'Widget work: turn started by a subagent result'],
    ['system', 'Widget work: turn started by Sovereign']
  ] as const)('origin %s', (via, title) => {
    const e = one('chat.turn.started', { threadId: 't1', via })
    expect(e.origin).toBe(via)
    expect(e.title).toBe(title)
  })

  it('a turn end carries its duration; a stuck reset says so', () => {
    expect(one('chat.turn.ended', { threadId: 't1', via: 'cron', durationMs: 125_000 })).toMatchObject({
      kind: 'agent',
      action: 'turn.ended',
      title: 'Widget work: turn ended',
      detail: 'took 2m 5s',
      origin: 'cron'
    })
    expect(one('chat.turn.ended', { threadId: 't1', via: 'user', durationMs: 900, reason: 'stuck' })).toMatchObject({
      detail: 'took 1s · reset after 30 min without events'
    })
  })

  it('an unknown thread falls back to its id; an unknown origin to system', () => {
    expect(one('chat.turn.started', { threadId: 'abcdef123456', via: 'nonsense' })).toMatchObject({
      title: 'abcdef12: turn started by Sovereign',
      origin: 'system'
    })
  })

  it('compactions and recycles', () => {
    expect(one('chat.compacted', { threadId: 't1' })).toMatchObject({
      kind: 'agent',
      action: 'session.compacted',
      title: 'Widget work: context compacted',
      origin: 'system'
    })
    expect(
      one('chat.recycled', { threadId: 't1', method: 'auto-recycle', preTokens: 600_000, postTokens: 200_000 })
    ).toMatchObject({
      action: 'session.recycled',
      title: 'Widget work: session recycled',
      detail: 'auto · 600k → 200k tokens'
    })
  })
})

describe('subagents', () => {
  it('spawned, done, failed, stopped, timed out', () => {
    expect(
      one('subagent.spawned', { threadId: 'parent', childKey: 'c1', label: 'Port the parser', task: 'Port it' })
    ).toEqual({
      at: AT,
      kind: 'subagent',
      action: 'subagent.spawned',
      title: 'Subagent started: Port the parser',
      detail: 'Port it',
      threadId: 'parent',
      threadLabel: 'Release prep',
      origin: 'subagent'
    })
    expect(
      one('subagent.completed', { threadId: 'parent', childKey: 'c1', label: 'Port the parser', durationMs: 61_000 })
    ).toMatchObject({ action: 'subagent.completed', title: 'Subagent done: Port the parser', detail: 'took 1m 1s' })
    expect(
      one('subagent.failed', { threadId: 'parent', childKey: 'c1', label: 'Port the parser', error: 'boom' })
    ).toMatchObject({ action: 'subagent.failed', title: 'Subagent failed: Port the parser', detail: 'boom' })
    expect(
      one('subagent.failed', {
        threadId: 'parent',
        childKey: 'c1',
        label: 'P',
        error: 'stopped by the parent',
        ended: 'stopped'
      })
    ).toMatchObject({ action: 'subagent.stopped', title: 'Subagent stopped: P' })
    expect(
      one('subagent.failed', {
        threadId: 'parent',
        childKey: 'c1',
        label: 'P',
        error: 'timed out after 240 min',
        ended: 'timed-out'
      })
    ).toMatchObject({ action: 'subagent.failed', title: 'Subagent timed out: P', detail: 'timed out after 240 min' })
  })

  it("the resume orchestrator's synthetic completion (parent key only) still maps", () => {
    const e = one('subagent.completed', { parentKey: 'agent:main:x', childKey: 'agent:main:subagent:9', result: '…' })
    expect(e.title).toBe('Subagent done: subagent')
    expect(e.threadId).toBeUndefined()
  })
})

describe('scheduler', () => {
  it('a job firing and failing; system jobs are system', () => {
    expect(one('scheduler.job.started', { job: { id: 'j1', name: 'Morning digest', tags: [] }, runId: 'r1' })).toEqual({
      at: AT,
      kind: 'scheduler',
      action: 'job.fired',
      title: 'Job fired: Morning digest',
      origin: 'cron'
    })
    expect(
      one('scheduler.job.started', { job: { id: 'j2', name: 'context-cleanup-sweep', tags: ['system'] } }).origin
    ).toBe('system')
    expect(one('scheduler.job.failed', { jobId: 'j1', jobName: 'Morning digest', error: 'no thread' })).toMatchObject({
      kind: 'scheduler',
      action: 'job.failed',
      title: 'Job failed: Morning digest',
      detail: 'no thread'
    })
  })

  it('completions are not worth a line', () => {
    expect(map('scheduler.job.completed', { jobId: 'j1', jobName: 'x' })).toEqual([])
  })
})

describe('CI watch', () => {
  it('red, green and stopped', () => {
    const base = {
      threadId: 't1',
      repo: 'acme-labs/widget',
      target: 'acme-labs/widget#12',
      url: 'https://github.com/acme-labs/widget/pull/12'
    }
    expect(one('ci.watch.ended', { ...base, result: 'failed', failed: ['lint', 'unit'] })).toEqual({
      at: AT,
      kind: 'github',
      action: 'ci.failed',
      title: 'CI failed on acme-labs/widget#12',
      detail: 'lint, unit',
      threadId: 't1',
      threadLabel: 'Widget work',
      origin: 'system',
      url: 'https://github.com/acme-labs/widget/pull/12'
    })
    expect(one('ci.watch.ended', { ...base, result: 'passed' })).toMatchObject({
      action: 'ci.passed',
      title: 'CI passed on acme-labs/widget#12'
    })
    expect(one('ci.watch.ended', { ...base, result: 'timed-out', message: 'timed out' })).toMatchObject({
      action: 'ci.stopped',
      title: 'Stopped watching CI on acme-labs/widget#12',
      detail: 'timed out'
    })
  })
})

describe('forge', () => {
  const event = (type: string, detail: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    at: AT,
    nodeId: 'github:github.com/acme-labs/widget#12',
    type,
    triage: 'info',
    ref: 'acme-labs/widget#12',
    title: 'Stream teeth',
    url: 'https://github.com/acme-labs/widget/pull/12',
    kind: 'change',
    detail,
    ...extra
  })

  it('a sync that brought N events: one summary line, then one line per event worth it', () => {
    const out = map('forge.events', {
      membrane: 'acme',
      via: 'sync',
      count: 4,
      events: [
        event('opened', { kind: 'change', author: 'alex-dev' }),
        event('pushed'),
        event('ci_failed', { failed: ['lint'] }),
        event('labelled')
      ]
    })
    expect(out.map((e) => [e.kind, e.action, e.title])).toEqual([
      ['forge', 'forge.sync', 'Forge sync: 4 new events in acme'],
      ['forge', 'forge.opened', 'PR opened: acme-labs/widget#12 Stream teeth'],
      ['github', 'forge.ci_failed', 'CI failed: acme-labs/widget#12 Stream teeth']
    ])
    expect(out[0]).toMatchObject({ membrane: 'acme', origin: 'system' })
    expect(out[1]).toMatchObject({
      membrane: 'acme',
      url: 'https://github.com/acme-labs/widget/pull/12',
      detail: 'by alex-dev'
    })
    expect(out[2]!.detail).toBe('lint')
  })

  it.each([
    ['merged', { into: 'main' }, 'PR merged: acme-labs/widget#12 Stream teeth', 'into main'],
    ['closed', { merged: false }, 'PR closed: acme-labs/widget#12 Stream teeth', undefined],
    ['reopened', {}, 'PR reopened: acme-labs/widget#12 Stream teeth', undefined],
    [
      'reviewed',
      { login: 'sam-reviewer', state: 'approved' },
      'Review: acme-labs/widget#12 Stream teeth',
      'approved by sam-reviewer'
    ],
    ['ci_passed', {}, 'CI passed: acme-labs/widget#12 Stream teeth', undefined],
    ['conflict', { base: 'main' }, 'Conflict: acme-labs/widget#12 Stream teeth', 'with main']
  ])('%s', (type, detail, title, line) => {
    const out = map('forge.events', { membrane: 'acme', via: 'sync', count: 1, events: [event(type, detail)] })
    expect(out[1]).toMatchObject({ action: `forge.${type}`, title })
    expect(out[1]!.detail).toBe(line)
  })

  it('issues read as issues', () => {
    const issue = {
      kind: 'issue',
      ref: 'acme-labs/widget#7',
      title: 'Gear slips',
      url: 'https://github.com/acme-labs/widget/issues/7'
    }
    const out = map('forge.events', {
      membrane: 'acme',
      via: 'sync',
      count: 2,
      events: [event('opened', { kind: 'issue' }, issue), event('closed', { reason: 'not_planned' }, issue)]
    })
    expect(out.slice(1).map((e) => [e.title, e.detail])).toEqual([
      ['Issue opened: acme-labs/widget#7 Gear slips', undefined],
      ['Issue closed: acme-labs/widget#7 Gear slips', 'not planned']
    ])
  })

  it('a comment is worth a line only when it needs an agent, and never carries the text', () => {
    const quiet = map('forge.events', {
      membrane: 'acme',
      via: 'sync',
      count: 1,
      events: [event('commented', { count: 2, authors: ['alex-dev'], text: ['secret text'] })]
    })
    expect(quiet).toHaveLength(1)
    const loud = map('forge.events', {
      membrane: 'acme',
      via: 'sync',
      count: 1,
      events: [
        event('commented', { count: 2, authors: ['alex-dev'], text: ['secret text'] }, { triage: 'needs-agent' })
      ]
    })
    expect(loud[1]).toMatchObject({
      action: 'forge.commented',
      title: 'Comments need an agent: acme-labs/widget#12 Stream teeth',
      detail: '2 new by alex-dev'
    })
    expect(JSON.stringify(loud)).not.toContain('secret text')
  })

  it('tracked items say so; plan edits alone are not a sync worth a line', () => {
    expect(
      map('forge.events', { membrane: 'acme', via: 'tracked', count: 1, events: [event('pushed')] })[0]!.title
    ).toBe('Forge: 1 new event on tracked items in acme')
    expect(map('forge.events', { membrane: 'acme', via: 'plans', count: 1, events: [event('plan_changed')] })).toEqual(
      []
    )
    expect(map('forge.events', { membrane: 'acme', via: 'sync', count: 0, events: [] })).toEqual([])
  })

  it('rethink runs starting and ending', () => {
    expect(
      one('forge.rethink', { membrane: 'acme', runId: 'r1', status: 'running', trigger: 'schedule', threadId: 'rt' })
    ).toEqual({
      at: AT,
      kind: 'forge',
      action: 'rethink.started',
      title: 'Rethink started in acme',
      detail: 'schedule',
      threadId: 'rt',
      threadLabel: 'forge-rethink',
      membrane: 'acme',
      origin: 'rethink'
    })
    expect(
      one('forge.rethink', {
        membrane: 'acme',
        runId: 'r1',
        status: 'done',
        trigger: 'manual',
        threadId: 'rt',
        actions: 3,
        events: 9
      })
    ).toMatchObject({ action: 'rethink.done', title: 'Rethink done in acme', detail: 'manual · 3 actions · 9 events' })
    expect(one('forge.rethink', { membrane: 'acme', runId: 'r1', status: 'timed-out', actions: 1 })).toMatchObject({
      action: 'rethink.timed-out',
      title: 'Rethink timed out in acme',
      detail: '1 action'
    })
  })

  it('rethink dependency and supersede actions', () => {
    expect(
      one('forge.rethink.action', {
        membrane: 'acme',
        runId: 'r1',
        action: 'depend',
        from: 'github:github.com/acme-labs/widget#12',
        to: 'github:github.com/acme-labs/widget#9',
        removed: false,
        reason: 'needs the new API'
      })
    ).toMatchObject({
      kind: 'forge',
      action: 'rethink.depend',
      title: 'Dependency: acme-labs/widget#12 needs acme-labs/widget#9',
      detail: 'needs the new API',
      origin: 'rethink'
    })
    expect(
      one('forge.rethink.action', {
        membrane: 'acme',
        action: 'depend',
        from: 'a',
        to: 'b',
        removed: true,
        reason: 'done'
      }).title
    ).toBe('Dependency removed: a no longer needs b')
    expect(
      one('forge.rethink.action', {
        membrane: 'acme',
        action: 'supersede',
        nodeId: 'task:t9',
        by: 'github:github.com/acme-labs/widget#12',
        title: 'Plan the API',
        reason: 'opened as a PR'
      })
    ).toMatchObject({ action: 'rethink.supersede', title: 'Superseded: "Plan the API" by acme-labs/widget#12' })
  })

  it('forge.updated and forge.overlay are graph refreshes, not lines', () => {
    expect(map('forge.updated', { membrane: 'acme' })).toEqual([])
    expect(map('forge.overlay', { membrane: 'acme', overlays: [] })).toEqual([])
  })
})

describe('everything else', () => {
  it.each([
    'chat.stream',
    'chat.work',
    'chat.status',
    'chat.turn',
    'chat.turn.completed',
    'chat.message.sent',
    'thread.updated',
    'file.changed',
    'made.up'
  ])('%s → nothing', (type) => {
    expect(map(type, { threadId: 't1', text: 'token' })).toEqual([])
  })

  it('the subscribed types are exactly the mapped ones', () => {
    expect([...TIMELINE_EVENT_TYPES].sort()).toEqual(
      [
        'chat.compacted',
        'chat.recycled',
        'chat.turn.ended',
        'chat.turn.started',
        'ci.watch.ended',
        'forge.events',
        'forge.rethink',
        'forge.rethink.action',
        'scheduler.job.failed',
        'scheduler.job.started',
        'subagent.completed',
        'subagent.failed',
        'subagent.spawned'
      ].sort()
    )
  })

  it('a malformed payload maps to nothing rather than throwing', () => {
    expect(map('chat.turn.started', null)).toEqual([])
    expect(map('forge.events', { membrane: 'acme', events: 'x' })).toEqual([])
  })

  it('titles and details are clipped to 200 characters', () => {
    const e = one('chat.turn.started', { threadId: 't1', via: 'user', preview: 'x'.repeat(500) })
    expect(e.detail!.length).toBeLessThanOrEqual(200)
    expect(e.detail!.endsWith('…')).toBe(true)
  })
})
