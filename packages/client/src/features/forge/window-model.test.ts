import { describe, it, expect } from 'vitest'
import type { ForgeGraph, WorkNode } from '@sovereign/core'
import { DAY_MS } from './layout.js'
import {
  EMPTY_PAGES_TO_STOP,
  WINDOW_DAYS,
  applySearch,
  applyWindow,
  emptyWindow,
  initialRequest,
  nextRequest,
  trimToCap,
  unpinAll,
  widenRequest,
  windowQuery,
  type WindowState
} from './window-model.js'
import { NOW, change, edge, issue, merged } from './test-fixtures.js'

const R = 'demo-org/engine'
const STEP = WINDOW_DAYS * DAY_MS

const graph = (nodes: WorkNode[], over: Partial<ForgeGraph> = {}): ForgeGraph => ({
  membrane: 'demo',
  since: '',
  until: '',
  nodes,
  edges: [],
  workstreams: [],
  syncing: false,
  ...over
})

function loaded(): WindowState {
  const req = initialRequest(NOW)
  return applyWindow(
    emptyWindow('demo', NOW),
    graph([merged(R, 1, 2), merged(R, 2, 15), change(R, 3), issue(R, 4)], { identity: 'hexbot' }),
    req
  )
}

describe('window model', () => {
  it('opens on the last 21 days', () => {
    const req = initialRequest(NOW)
    expect(req).toEqual({ since: NOW - STEP, until: null, side: 'initial' })
    const s = loaded()
    expect(s.since).toBe(NOW - STEP)
    expect(s.until).toBeNull()
    expect(s.nodes.size).toBe(4)
    expect(s.identity).toBe('hexbot')
  })

  it('asks for the next 21 days when the view crosses the left edge, and nothing inside', () => {
    const s = loaded()
    expect(nextRequest(s, NOW - 10 * DAY_MS, NOW, NOW)).toBeNull()
    expect(nextRequest(s, NOW - 22 * DAY_MS, NOW, NOW)).toEqual({
      since: NOW - 2 * STEP,
      until: NOW - STEP,
      side: 'older'
    })
  })

  it('extends the slice with an older page and keeps the newer one', () => {
    const s0 = loaded()
    const req = nextRequest(s0, NOW - 30 * DAY_MS, NOW, NOW)!
    const s1 = applyWindow(s0, graph([merged(R, 10, 30)]), req)
    expect(s1.since).toBe(NOW - 2 * STEP)
    expect(s1.nodes.size).toBe(5)
    expect(s1.nodes.has(`github:github.com/${R}#1`)).toBe(true)
    expect(s1.emptyOlder).toBe(0)
  })

  it('stops asking after several empty older pages in a row', () => {
    let s = loaded()
    for (let i = 0; i < EMPTY_PAGES_TO_STOP; i++) {
      const req = widenRequest(s)!
      expect(req).not.toBeNull()
      s = applyWindow(s, graph([]), req)
    }
    expect(s.exhausted).toBe(true)
    expect(widenRequest(s)).toBeNull()
    expect(nextRequest(s, s.since - DAY_MS, NOW, NOW)).toBeNull()
  })

  it('a live refetch replaces present/future items and drops ones that vanished', () => {
    const s0 = loaded()
    const merged3 = merged(R, 3, 0.5)
    const s1 = applyWindow(s0, graph([merged(R, 1, 2), merged3, issue(R, 4)]), initialRequest(NOW))
    expect(s1.nodes.get(merged3.id)!.state).toBe('merged')
    // #2 closed 15 days ago is still in the window but missing from the reply: it went.
    expect(s1.nodes.has(`github:github.com/${R}#2`)).toBe(false)
  })

  it('a live refetch keeps older pages already loaded', () => {
    const s0 = loaded()
    const old = merged(R, 10, 30)
    const s1 = applyWindow(s0, graph([old]), widenRequest(s0)!)
    const s2 = applyWindow(s1, graph([change(R, 3)]), initialRequest(NOW))
    expect(s2.nodes.has(old.id)).toBe(true)
    expect(s2.since).toBe(NOW - 2 * STEP)
  })

  it('pins search results across trims and refetches; unpinning drops the out-of-window ones', () => {
    const s0 = loaded()
    const ancient = merged(R, 5, 400)
    const s1 = applySearch(s0, { nodes: [ancient], edges: [edge(ancient, `github:github.com/${R}#1`, 'references')] })
    expect(s1.pinned.has(ancient.id)).toBe(true)
    expect(s1.edges).toHaveLength(1)
    const s2 = applyWindow(s1, graph([merged(R, 1, 2)]), initialRequest(NOW))
    expect(s2.nodes.has(ancient.id)).toBe(true)
    const s3 = trimToCap(s2, 1, NOW)
    expect(s3.nodes.has(ancient.id)).toBe(true)
    const s4 = unpinAll(s2)
    expect(s4.nodes.has(ancient.id)).toBe(false)
    expect(s4.edges).toHaveLength(0)
  })

  it('trims past nodes farthest from the focus first, never present or future', () => {
    let s = loaded()
    s = applyWindow(s, graph([merged(R, 20, 25), merged(R, 21, 35)]), widenRequest(s)!)
    // Focus on today: the oldest past items go first.
    const t = trimToCap(s, 4, NOW)
    expect(t.nodes.size).toBe(4)
    expect([...t.nodes.values()].map((n) => n.number).sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4])
    // The slice shrinks so panning back there reloads it.
    expect(t.since).toBeGreaterThan(NOW - 25 * DAY_MS)
    expect(nextRequest(t, NOW - 26 * DAY_MS, NOW, NOW)?.side).toBe('older')

    // Focus far back: the newest past items go, the slice gets an upper bound.
    const u = trimToCap(s, 5, NOW - 35 * DAY_MS)
    expect(u.nodes.has(`github:github.com/${R}#1`)).toBe(false)
    expect(u.nodes.has(`github:github.com/${R}#21`)).toBe(true)
    expect(u.until).not.toBeNull()
    const back = nextRequest(u, NOW - 3 * DAY_MS, NOW, NOW)
    expect(back?.side).toBe('newer')
    // The newer page reaching today turns the slice live again.
    const v = applyWindow(u, graph([merged(R, 1, 2)]), back!)
    expect(v.until === null || v.until > u.until!).toBe(true)
  })

  it('trimming leaves a state under the cap untouched', () => {
    const s = loaded()
    expect(trimToCap(s, 100, NOW)).toBe(s)
  })

  it('builds the GET /api/forge query', () => {
    const q = new URLSearchParams(windowQuery('demo', { since: NOW - STEP, until: null, side: 'initial' }, 'view-1'))
    expect(q.get('membrane')).toBe('demo')
    expect(q.get('view')).toBe('view-1')
    expect(q.get('since')).toBe(new Date(NOW - STEP).toISOString())
    expect(q.has('until')).toBe(false)
    const q2 = new URLSearchParams(windowQuery('demo', { since: 0, until: NOW, side: 'older' }))
    expect(q2.get('until')).toBe(new Date(NOW).toISOString())
    expect(q2.has('view')).toBe(false)
  })
})
