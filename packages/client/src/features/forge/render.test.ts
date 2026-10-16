import { describe, it, expect } from 'vitest'
import type { WorkNode } from '@sovereign/core'
import { computeLayout } from './layout.js'
import { drawFrame } from './render.js'
import { buildScene } from './scene.js'
import { DEFAULT_PALETTE } from './style.js'
import { NOW, change, edge, issue, merged } from './test-fixtures.js'

/** A 2D context that records calls instead of painting. */
function recordingContext() {
  const calls: { name: string; args: unknown[] }[] = []
  const state: Record<string, unknown> = { font: '10px sans-serif' }
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 })
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
      }
    },
    set(target, prop: string, value) {
      target[prop] = value
      calls.push({ name: `set:${prop}`, args: [value] })
      return true
    }
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

const R = 'demo-org/engine'

// At scale 0.5 with tx 400 the 1200-px view spans world x −800…1600: past, present and the first future column.
function frame(nodes: WorkNode[], vp = { tx: 400, ty: 20, scale: 0.5 }, dpr = 2) {
  const edges = [edge(nodes[1], nodes[0], 'base'), edge(nodes[1], nodes[2], 'references')]
  const layout = computeLayout({ nodes, edges, workstreams: [], now: NOW })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const scene = buildScene(layout, byId, new Set(byId.keys()), new Set(), vp.scale)
  const rec = recordingContext()
  const stats = drawFrame(rec.ctx, {
    scene,
    vp,
    width: 1200,
    height: 600,
    dpr,
    palette: DEFAULT_PALETTE,
    overlays: new Map([[nodes[1].id, { nodeId: nodes[1].id, subagents: [{ key: 'k', label: 's', startedAt: 0 }] }]]),
    selectedId: null,
    hoverId: null,
    time: 0
  })
  return { ...rec, stats, layout }
}

describe('drawFrame', () => {
  const nodes = [
    merged(R, 1, 1),
    change(R, 2, { createdAt: new Date(NOW - 0.5 * 86_400_000).toISOString() }),
    issue(R, 3)
  ]

  it('scales by devicePixelRatio and draws what is on screen', () => {
    const { calls, stats } = frame(nodes)
    const first = calls.find((c) => c.name === 'setTransform')!
    expect(first.args).toEqual([2, 0, 0, 2, 0, 0])
    expect(stats.nodesDrawn).toBe(3)
    expect(stats.edgesDrawn).toBe(2)
  })

  it('culls nodes and edges outside the viewport', () => {
    // Pan far into the future zone, past every node.
    const { stats } = frame(nodes, { tx: -100_000, ty: 20, scale: 1 })
    expect(stats.nodesDrawn).toBe(0)
    expect(stats.edgesDrawn).toBe(0)
  })

  it('dashes future-facing edges and keeps base edges solid', () => {
    const { calls } = frame(nodes)
    const dashes = calls.filter((c) => c.name === 'setLineDash').map((c) => (c.args[0] as number[]).length)
    expect(dashes).toContain(0)
    expect(dashes).toContain(2)
  })

  it('keeps animating while a visible ring pulses', () => {
    expect(frame(nodes).stats.animating).toBe(true)
    expect(frame(nodes, { tx: -100_000, ty: 20, scale: 1 }).stats.animating).toBe(false)
  })

  it('draws bands, not past nodes, when zoomed out', () => {
    const { stats } = frame(nodes, { tx: 200, ty: 20, scale: 0.1 })
    expect(stats.bandsDrawn).toBe(1)
    expect(stats.nodesDrawn).toBe(2)
  })
})
