import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkNode } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDigest, createEventLog, ruleTriage, triage, TRIAGE_THRESHOLD, type TriageContext } from './events.js'
import type { ForgeClassifier, ForgeEvent, TriagedEvent } from './types.js'

const node = (over: Partial<WorkNode> = {}): WorkNode => ({
  id: 'github:github.com/acme-labs/widget#1',
  forge: 'github',
  kind: 'change',
  repo: 'acme-labs/widget',
  number: 1,
  title: 'Sprockets',
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over
})

const ev = (type: ForgeEvent['type'], detail: Record<string, unknown> = {}, nodeId = node().id): ForgeEvent => ({
  at: '2026-10-16T00:00:00.000Z',
  nodeId,
  type,
  detail
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  node: node(),
  owned: false,
  tracked: () => false,
  identity: 'hex-agent',
  mentions: ['alex'],
  ...over
})

describe('ruleTriage', () => {
  it('places the fixed needs-agent cases', () => {
    expect(ruleTriage(ev('ci_failed'), ctx({ owned: true }))).toBe('needs-agent')
    expect(ruleTriage(ev('reviewed', { state: 'changes_requested', login: 'x' }), ctx())).toBe('needs-agent')
    expect(ruleTriage(ev('conflict'), ctx())).toBe('needs-agent')
    const approved = node({ reviewers: [{ login: 'jo', state: 'approved' }] })
    expect(ruleTriage(ev('behind_base', { behind: 2 }), ctx({ node: approved }))).toBe('needs-agent')
    expect(ruleTriage(ev('commented', { text: ['ping @hex-agent please'] }), ctx())).toBe('needs-agent')
    expect(ruleTriage(ev('commented', { text: ['Alex, can you look?'] }), ctx())).toBe('needs-agent')
    expect(ruleTriage(ev('referenced', { byKind: 'issue' }), ctx({ tracked: () => true }))).toBe('needs-agent')
    expect(ruleTriage(ev('assigned', { added: ['Hex-Agent'], removed: [] }), ctx())).toBe('needs-agent')
    expect(ruleTriage(ev('review_requested', { login: 'hex-agent' }), ctx())).toBe('needs-agent')
  })

  it('places the plain info cases', () => {
    expect(ruleTriage(ev('ci_failed'), ctx())).toBe('info')
    expect(ruleTriage(ev('behind_base', { behind: 2 }), ctx())).toBe('info')
    expect(ruleTriage(ev('commented', { text: ['nice, @hex-agentx'] }), ctx())).toBe('info')
    expect(ruleTriage(ev('assigned', { added: ['hex-agent'] }), ctx({ owned: true }))).toBe('info')
    expect(ruleTriage(ev('referenced', { byKind: 'change' }), ctx({ tracked: () => true }))).toBe('info')
    for (const t of ['opened', 'merged', 'closed', 'pushed', 'ci_passed', 'labelled'] as const)
      expect(ruleTriage(ev(t), ctx())).toBe('info')
  })

  it('leaves owned judgement calls to the model', () => {
    expect(ruleTriage(ev('commented', { text: ['looks odd'] }), ctx({ owned: true }))).toBeUndefined()
    expect(ruleTriage(ev('reviewed', { state: 'commented' }), ctx({ owned: true }))).toBeUndefined()
    expect(ruleTriage(ev('stale'), ctx({ owned: true }))).toBeUndefined()
    expect(ruleTriage(ev('plan_changed'), ctx())).toBeUndefined()
  })
})

describe('triage tiers', () => {
  const model = (choice: 'info' | 'needs-agent', confidence: number): ForgeClassifier => ({
    classify: async () => ({ choice, confidence })
  })
  const open = ev('plan_changed', {}, 'plan:acme/p.md')

  it('rule first, without asking the model', async () => {
    let asked = 0
    const r = await triage(ev('conflict'), ctx(), {
      classify: async () => (asked++, { choice: 'info', confidence: 1 })
    })
    expect(r).toMatchObject({ triage: 'needs-agent', tier: 'rule' })
    expect(asked).toBe(0)
  })

  it('the model decides at or above the threshold', async () => {
    expect(await triage(open, ctx(), model('info', TRIAGE_THRESHOLD))).toMatchObject({
      triage: 'info',
      tier: 'model',
      confidence: 0.7
    })
    expect(await triage(open, ctx(), model('needs-agent', 0.9))).toMatchObject({ triage: 'needs-agent', tier: 'model' })
  })

  it('below the threshold → needs-agent; no model, an error or no answer → needs-agent', async () => {
    expect(await triage(open, ctx(), model('info', 0.69))).toMatchObject({
      triage: 'needs-agent',
      tier: 'model-low',
      confidence: 0.69
    })
    expect(await triage(open, ctx(), undefined)).toMatchObject({ triage: 'needs-agent', tier: 'unavailable' })
    expect(await triage(open, ctx(), { classify: async () => Promise.reject(new Error('down')) })).toMatchObject({
      tier: 'unavailable'
    })
    expect(await triage(open, ctx(), { classify: async () => undefined })).toMatchObject({ tier: 'unavailable' })
  })
})

describe('event log and digest', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-events-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const t = (e: ForgeEvent, triage: TriagedEvent['triage'], tier: TriagedEvent['tier'] = 'rule'): TriagedEvent => ({
    ...e,
    triage,
    tier
  })

  it('appends JSON lines, counts coverage per tier, and recounts after a restart (a torn line skipped)', () => {
    const log = createEventLog(dir, 'acme')
    log.append([
      t(ev('conflict'), 'needs-agent'),
      t(ev('pushed'), 'info'),
      t(ev('stale'), 'info', 'model'),
      t(ev('stale'), 'needs-agent', 'model-low'),
      t(ev('stale'), 'needs-agent', 'unavailable')
    ])
    expect(log.coverage()).toEqual({
      rule: { info: 1, needsAgent: 1 },
      model: { info: 1, needsAgent: 0 },
      modelLow: 1,
      unavailable: 1
    })
    expect(log.file).toBe(path.join(dir, 'forge', 'acme', 'events.jsonl'))
    fs.appendFileSync(log.file, '{"broken":')
    const again = createEventLog(dir, 'acme')
    expect(again.read()).toHaveLength(5)
    expect(again.coverage()).toEqual(log.coverage())
    expect(again.read({ verdict: 'needs-agent' })).toHaveLength(3)
    // The torn line does not swallow the next event.
    again.append([t(ev('conflict'), 'needs-agent')])
    expect(createEventLog(dir, 'acme').read()).toHaveLength(6)
  })

  it('an event logged after a digest read it never lands behind the cursor', () => {
    const log = createEventLog(dir, 'acme')
    log.append([t({ ...ev('conflict'), at: '2026-10-16T10:00:05.000Z' }, 'needs-agent')])
    const cursor = log.read()[0].at
    // Detected earlier, logged later (a slow triage while another path logged).
    log.append([t({ ...ev('commented'), at: '2026-10-16T10:00:01.000Z' }, 'needs-agent')])
    expect(log.read({ since: cursor }).map((e) => e.type)).toEqual(['commented'])
  })

  it('keeps the newest events once the log passes its cap', () => {
    const log = createEventLog(dir, 'acme', 8)
    for (let i = 0; i < 10; i++) log.append([t({ ...ev('pushed'), detail: { i } }, 'info')])
    expect(log.count()).toBe(7)
    expect(log.read().map((e) => e.detail.i)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(createEventLog(dir, 'acme', 8).count()).toBe(7)
  })

  it('digest: needs-agent since the cursor, grouped by stream then node, with card data', () => {
    const a = node({ id: 'n:a', workstreams: ['s1'] })
    const b = node({ id: 'n:b', workstreams: [] })
    const c = node({ id: 'n:c', workstreams: ['s1', 's2'] })
    const nodes = new Map([a, b, c].map((n) => [n.id, n]))
    const events: TriagedEvent[] = [
      t({ ...ev('conflict', {}, 'n:a'), at: '2026-10-15T00:00:00.000Z' }, 'needs-agent'),
      t({ ...ev('ci_failed', {}, 'n:a'), at: '2026-10-16T01:00:00.000Z' }, 'needs-agent'),
      t({ ...ev('pushed', {}, 'n:a'), at: '2026-10-16T01:00:00.000Z' }, 'info'),
      t({ ...ev('reviewed', {}, 'n:b'), at: '2026-10-16T02:00:00.000Z' }, 'needs-agent'),
      t({ ...ev('conflict', {}, 'n:c'), at: '2026-10-16T03:00:00.000Z' }, 'needs-agent'),
      t({ ...ev('conflict', {}, 'n:a'), at: '2026-10-16T04:00:00.000Z' }, 'needs-agent'),
      t({ ...ev('conflict', {}, 'gone'), at: '2026-10-16T05:00:00.000Z' }, 'needs-agent')
    ]
    const streams = [
      { id: 's1', name: 'Plan 20', membrane: 'acme', memberCount: 2, status: 'active' as const },
      { id: 's2', name: 'Other', membrane: 'acme', memberCount: 1, status: 'planned' as const }
    ]
    const d = buildDigest('acme', events, nodes, streams, '2026-10-15T12:00:00.000Z')
    expect(d.count).toBe(4)
    expect(d.cursor).toBe('2026-10-16T05:00:00.000Z')
    expect(d.groups.map((g) => g.stream?.name ?? null)).toEqual(['Plan 20', null])
    expect(d.groups[0].nodes.map((n) => [n.node.id, n.events.map((e) => e.type)])).toEqual([
      ['n:a', ['ci_failed', 'conflict']],
      ['n:c', ['conflict']]
    ])
    expect(d.groups[1].nodes[0].node.title).toBe('Sprockets')
    expect(buildDigest('acme', [], nodes, streams).count).toBe(0)
  })
})
