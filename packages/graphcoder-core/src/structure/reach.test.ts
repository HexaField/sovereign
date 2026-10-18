import { describe, expect, it } from 'vitest'
import { createEdgeHygiene } from '../hygiene.js'
import { fileNode, link, sym } from './fixtures.js'
import { changeReach } from './reach.js'

/*
 * src/a.ts: f → g (calls), h            src/b.ts: k, imported by a.ts
 * g calls k                             src/c.ts: lone (nothing links it)
 * a test file calls f
 */
const fa = fileNode('src/a.ts')
const fb = fileNode('src/b.ts')
const fc = fileNode('src/c.ts')
const ft = fileNode('src/a.test.ts')
const f = sym('function', 'f', 'src/a.ts', [1, 3])
const g = sym('function', 'g', 'src/a.ts', [5, 7])
const h = sym('function', 'h', 'src/a.ts', [9, 10])
const k = sym('function', 'k', 'src/b.ts', [1, 3])
const lone = sym('function', 'lone', 'src/c.ts', [1, 3])
const nodes = [fa, fb, fc, ft, f, g, h, k, lone]
const edges = [
  link(fa, f, 'contains'),
  link(fa, g, 'contains'),
  link(fa, h, 'contains'),
  link(fb, k, 'contains'),
  link(fc, lone, 'contains'),
  link(f, g),
  link(g, k),
  link(ft, f),
  link(ft, lone)
]
const reachOf = (changed: string[], es = edges) => changeReach(nodes, es, createEdgeHygiene(nodes), changed)

describe('changeReach', () => {
  it('is 0 with no part for nothing changed, 0 with one part for one symbol', () => {
    expect(reachOf([])).toEqual({ reach: 0, parts: 0 })
    expect(reachOf([f.id])).toEqual({ reach: 0, parts: 1 })
  })

  it('counts a call as one hop', () => {
    expect(reachOf([f.id, g.id])).toEqual({ reach: 1, parts: 1 })
  })

  it('takes the longest of the shortest paths: f-g-k is 2, h reaches k through the file and g', () => {
    expect(reachOf([f.id, k.id])).toEqual({ reach: 2, parts: 1 })
    // h – a.ts – g – k
    expect(reachOf([f.id, h.id, k.id])).toEqual({ reach: 3, parts: 1 })
  })

  it('ignores edges hygiene rejects: test code links nothing', () => {
    // f and lone are both called by the test only
    expect(reachOf([f.id, lone.id])).toEqual({ reach: 0, parts: 2 })
  })

  it('ignores guessed edges', () => {
    const guess = link(f, g, 'calls', { metadata: { confidence: 0.4, resolvedBy: 'exact-match' } })
    const withGuess = edges.filter((e) => !(e.source === f.id && e.target === g.id)).concat(guess)
    // only through the file now: f – a.ts – g
    expect(reachOf([f.id, g.id], withGuess)).toEqual({ reach: 2, parts: 1 })
  })

  it('reports the widest part when the change falls apart', () => {
    expect(reachOf([f.id, k.id, lone.id])).toEqual({ reach: 2, parts: 2 })
  })

  it('skips ids the snapshot does not hold', () => {
    expect(reachOf(['nope', f.id])).toEqual({ reach: 0, parts: 1 })
  })
})
