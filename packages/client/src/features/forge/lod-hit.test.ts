import { describe, it, expect } from 'vitest'
import type { WorkNode } from '@sovereign/core'
import { createHitIndex } from './hit-index.js'
import { computeLayout, timeToX } from './layout.js'
import { COLLAPSE_SCALE, binDaysFor, collapsePast, detailFor } from './lod.js'
import { anchorOf, bandHitId, bandIndexOf, buildScene } from './scene.js'
import { NOW, change, issue, merged } from './test-fixtures.js'

const R = 'demo-org/engine'
const R2 = 'demo-org/app'

describe('level of detail', () => {
  it('picks dot / compact / full by scale', () => {
    expect(detailFor(0.1)).toBe('dot')
    expect(detailFor(0.5)).toBe('compact')
    expect(detailFor(1)).toBe('full')
  })

  it('widens bands as the view zooms out, so a band stays readable', () => {
    expect(binDaysFor(0.36)).toBe(1) // 1 day = 57.6 px
    expect(binDaysFor(0.34)).toBe(2) // 1 day = 54.4 px: too narrow
    expect(binDaysFor(0.1)).toBe(7)
    expect(binDaysFor(0.01)).toBe(56)
    expect(binDaysFor(0.0001)).toBe(224)
  })

  it('leaves the past alone when zoomed in', () => {
    const l = computeLayout({ nodes: [merged(R, 1, 2)], edges: [], workstreams: [], now: NOW })
    const nodes = new Map([[`github:github.com/${R}#1`, merged(R, 1, 2)]])
    expect(collapsePast(l, nodes, COLLAPSE_SCALE).bands).toEqual([])
  })

  it('collapses past nodes into per-group bands spanning their rows, with counts; present and future stay', () => {
    const list: WorkNode[] = [
      merged(R, 1, 1.1),
      merged(R, 2, 1.5),
      merged(R, 3, 9),
      change(R, 4, { state: 'closed', zone: 'past', closedAt: new Date(NOW - 1.2 * 86_400_000).toISOString() }),
      merged(R2, 5, 1.3),
      change(R, 6),
      issue(R, 7)
    ]
    const l = computeLayout({ nodes: list, edges: [], workstreams: [], now: NOW })
    const byId = new Map(list.map((n) => [n.id, n]))
    const c = collapsePast(l, byId, 0.1) // 7-day bins
    expect(c.binDays).toBe(7)
    const engine = c.bands.filter((b) => b.group === `repo:${R}`)
    expect(engine.map((b) => b.count)).toEqual([1, 3]) // days 7–14, then 0–7
    expect(engine[1]).toMatchObject({ merged: 2, closed: 1 })
    expect(engine[1].x + engine[1].w).toBeCloseTo(timeToX(NOW, NOW))
    expect(c.bands.filter((b) => b.group === `repo:${R2}`).map((b) => b.count)).toEqual([1])
    // A band covers every member's row.
    for (const id of engine[1].nodeIds) {
      const p = l.nodes.get(id)!
      expect(p.y).toBeGreaterThanOrEqual(engine[1].y)
      expect(p.y + p.h).toBeLessThanOrEqual(engine[1].y + engine[1].h)
    }
    expect(c.bandOf.has(list[5].id)).toBe(false)
    expect(c.bandOf.has(list[6].id)).toBe(false)
    expect(c.bandOf.get(list[0].id)).toBe(c.bands.indexOf(engine[1]))
  })

  it('counts only included (filtered) nodes', () => {
    const list = [merged(R, 1, 1), merged(R, 2, 1)]
    const l = computeLayout({ nodes: list, edges: [], workstreams: [], now: NOW })
    const c = collapsePast(l, new Map(list.map((n) => [n.id, n])), 0.1, (id) => id === list[0].id)
    expect(c.bands.map((b) => b.count)).toEqual([1])
  })
})

describe('hit index', () => {
  const rects = [
    { id: 'a', x: 0, y: 0, w: 100, h: 40 },
    { id: 'b', x: 90, y: 10, w: 100, h: 40 },
    { id: 'far', x: 5000, y: 3000, w: 50, h: 50 }
  ]

  it('returns the topmost rect at a point, or null', () => {
    const h = createHitIndex(rects)
    expect(h.at(10, 10)).toBe('a')
    expect(h.at(95, 20)).toBe('b') // overlap: the later rect is on top
    expect(h.at(150, 45)).toBe('b')
    expect(h.at(300, 300)).toBeNull()
    expect(h.at(5025, 3025)).toBe('far')
  })

  it('finds rects in a region, across cell boundaries, without duplicates', () => {
    const h = createHitIndex(rects, 64)
    expect(h.inRect(0, 0, 200, 60)).toEqual(['a', 'b'])
    expect(h.inRect(4990, 2990, 20, 20)).toEqual(['far'])
    expect(h.inRect(-1e6, -1e6, 2e6, 2e6)).toEqual(['a', 'b', 'far'])
  })

  it('handles negative coordinates (the past zone)', () => {
    const h = createHitIndex([{ id: 'p', x: -900, y: 20, w: 200, h: 44 }])
    expect(h.at(-850, 40)).toBe('p')
    expect(h.inRect(-1000, 0, 200, 100)).toEqual(['p'])
  })
})

describe('scene', () => {
  it('hits a band when zoomed out and routes edges to it', () => {
    const list = [merged(R, 1, 1), change(R, 2)]
    const l = computeLayout({
      nodes: list,
      edges: [{ from: list[1].id, to: list[0].id, kind: 'references', dashed: true, source: 'sync' }],
      workstreams: [],
      now: NOW
    })
    const byId = new Map(list.map((n) => [n.id, n]))
    const all = new Set(byId.keys())
    const s = buildScene(l, byId, all, new Set(), 0.1)
    const band = s.collapsed.bands[0]
    const hit = s.hit.at(band.x + 1, band.y + 1)!
    expect(bandIndexOf(hit)).toBe(0)
    expect(hit).toBe(bandHitId(0))
    expect(anchorOf(s, list[0].id)).toBe(band)
    const p = l.nodes.get(list[1].id)!
    expect(s.hit.at(p.x + 5, p.y + 5)).toBe(list[1].id)
  })

  it('hidden nodes neither hit nor anchor', () => {
    const list = [change(R, 1)]
    const l = computeLayout({ nodes: list, edges: [], workstreams: [], now: NOW })
    const s = buildScene(l, new Map(list.map((n) => [n.id, n])), new Set(), new Set(), 1)
    const p = l.nodes.get(list[0].id)!
    expect(s.hit.at(p.x + 5, p.y + 5)).toBeNull()
    expect(anchorOf(s, list[0].id)).toBeNull()
  })
})
