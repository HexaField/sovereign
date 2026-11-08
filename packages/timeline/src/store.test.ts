// Timeline storage: one JSONL file per UTC day plus an in-memory ring.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTimelineStore, type TimelineStore } from './store.js'
import type { TimelineDraft } from './mapping.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-26T12:00:00.000Z')
const draft = (at: number, over: Partial<TimelineDraft> = {}): TimelineDraft => ({
  at: new Date(at).toISOString(),
  kind: 'agent',
  action: 'turn.started',
  title: `at ${new Date(at).toISOString()}`,
  ...over
})

describe('timeline store', () => {
  let dir: string
  let now: number
  let store: TimelineStore
  const open = (opts: { ringSize?: number; retentionDays?: number } = {}) =>
    createTimelineStore({ dir, now: () => now, ...opts })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'))
    now = T0
    store = open()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('appends to the day file of each entry and reads newest first', () => {
    store.append(draft(T0 - DAY - 1000))
    store.append(draft(T0 - 2000))
    store.append(draft(T0 - 1000, { kind: 'forge' }))
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10-25.jsonl', '2026-10-26.jsonl'])
    const lines = fs.readFileSync(path.join(dir, '2026-10-26.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'agent', at: new Date(T0 - 2000).toISOString() })
    const page = store.query({})
    expect(page.entries.map((e) => e.at)).toEqual(
      [T0 - 1000, T0 - 2000, T0 - DAY - 1000].map((t) => new Date(t).toISOString())
    )
    expect(page.more).toBe(false)
  })

  it('gives each entry a time-ordered id and keeps times strictly increasing', () => {
    const a = store.append(draft(T0))
    const b = store.append(draft(T0))
    const c = store.append(draft(T0 - 5000)) // an event logged late
    expect(Date.parse(b.at)).toBeGreaterThan(Date.parse(a.at))
    expect(Date.parse(c.at)).toBeGreaterThan(Date.parse(b.at))
    expect([a.id, b.id, c.id]).toEqual([...new Set([a.id, b.id, c.id])])
    expect(a.id).toMatch(/^t[0-9a-z]+-[0-9a-z]+$/)
  })

  it('filters by since, until and kinds; limit and before page back', () => {
    for (let i = 0; i < 10; i++) store.append(draft(T0 - (10 - i) * 60_000, { kind: i % 2 ? 'forge' : 'agent' }))
    const iso = (t: number) => new Date(t).toISOString()
    expect(store.query({ kinds: ['forge'] }).entries).toHaveLength(5)
    expect(store.query({ since: iso(T0 - 3 * 60_000) }).entries).toHaveLength(3)
    expect(store.query({ until: iso(T0 - 3 * 60_000) }).entries).toHaveLength(7) // until is exclusive
    const first = store.query({ limit: 4 })
    expect(first.entries).toHaveLength(4)
    expect(first.more).toBe(true)
    expect(first.next).toBe(first.entries[3]!.id)
    const second = store.query({ limit: 4, before: first.next })
    expect(second.entries.map((e) => e.at)).toEqual([5, 6, 7, 8].map((k) => iso(T0 - k * 60_000)))
    const third = store.query({ limit: 4, before: second.next })
    expect(third.entries).toHaveLength(2)
    expect(third.more).toBe(false)
    expect(third.next).toBeUndefined()
  })

  it('filters by origin', () => {
    store.append(draft(T0 - 3000, { origin: 'user' }))
    store.append(draft(T0 - 2000, { origin: 'cron' }))
    store.append(draft(T0 - 1000, { origin: 'subagent' }))
    expect(store.query({ origins: ['user', 'subagent'] }).entries.map((e) => e.origin)).toEqual(['subagent', 'user'])
  })

  it('the ring is the fast path; older pages come from the day files', () => {
    const small = open({ ringSize: 3 })
    for (let i = 0; i < 6; i++) small.append(draft(T0 - (6 - i) * 60_000))
    expect(small.ring()).toHaveLength(3)
    // Break the day file: a query the ring answers does not read it.
    const file = path.join(dir, '2026-10-26.jsonl')
    const saved = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '')
    expect(small.query({ limit: 3 }).entries).toHaveLength(3)
    // A query past the ring reads the files.
    fs.writeFileSync(file, saved)
    const all = small.query({ limit: 10 })
    expect(all.entries).toHaveLength(6)
    expect(new Set(all.entries.map((e) => e.id)).size).toBe(6)
  })

  it('a restart loads the newest entries into the ring and keeps ordering after them', () => {
    const a = store.append(draft(T0))
    const again = open()
    expect(again.ring().map((e) => e.id)).toEqual([a.id])
    const b = again.append(draft(T0 - 60_000))
    expect(Date.parse(b.at)).toBeGreaterThan(Date.parse(a.at))
    expect(again.query({}).entries.map((e) => e.id)).toEqual([b.id, a.id])
  })

  it('skips broken lines in a day file', () => {
    store.append(draft(T0 - 1000))
    fs.appendFileSync(path.join(dir, '2026-10-26.jsonl'), '{not json\n')
    expect(open().query({}).entries).toHaveLength(1)
  })

  it('retention deletes day files older than 30 days, at start and on prune()', () => {
    fs.writeFileSync(path.join(dir, '2026-09-25.jsonl'), '')
    fs.writeFileSync(path.join(dir, '2026-09-26.jsonl'), '')
    fs.writeFileSync(path.join(dir, 'notes.txt'), '')
    open()
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09-26.jsonl', 'notes.txt'])
    now += 2 * DAY
    store.prune()
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt'])
  })
})
