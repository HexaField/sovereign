import { describe, it, expect } from 'vitest'
import type { WorkNode } from '@sovereign/core'
import { computeLayout, streamCardId } from './layout.js'
import { drawFrame } from './render.js'
import { buildScene } from './scene.js'
import { DEFAULT_PALETTE, edgeStyle } from './style.js'
import { NOW, change, edge, issue, merged, plan, stream } from './test-fixtures.js'

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

  it('keeps edges one screen width at any zoom, and drops references when zoomed out to dots', () => {
    const { calls, stats } = frame(nodes, { tx: 400, ty: 20, scale: 0.2 })
    expect(stats.edgesDrawn).toBe(1)
    const base = edgeStyle(edge(nodes[1], nodes[0], 'base'), nodes[0])
    const widths = calls.filter((c) => c.name === 'set:lineWidth').map((c) => c.args[0] as number)
    expect(widths).toContain(base.width / 0.2)
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

describe('category badge', () => {
  it('draws the category on a categorised card, in its colour, and nothing on an uncategorised one', () => {
    const nodes = [
      merged(R, 1, 1),
      change(R, 2, {
        createdAt: new Date(NOW - 0.5 * 86_400_000).toISOString(),
        category: 'bug',
        categorySource: 'rule'
      }),
      issue(R, 3)
    ]
    const { calls, stats } = frame(nodes)
    expect(stats.nodesDrawn).toBe(3)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
    expect(texts.filter((t) => t === 'bug')).toHaveLength(1)
    expect(calls.filter((c) => c.name === 'set:fillStyle').map((c) => c.args[0])).toContain('#f87171')
    const plain = frame([nodes[0], { ...nodes[1], category: undefined, categorySource: undefined }, nodes[2]])
    const badges = ['bug', 'feature', 'design', 'future', '?']
    expect(plain.calls.some((c) => c.name === 'fillText' && badges.includes(String(c.args[0])))).toBe(false)
  })
})

describe('depends-on edges', () => {
  it('end in an arrowhead at what the dependent needs; related edges do not', () => {
    const a = issue(R, 1)
    const b = issue(R, 2)
    const draw = (kind: 'depends-on' | 'related') => {
      const nodes = [a, b]
      const layout = computeLayout({ nodes, edges: [edge(a, b, kind)], workstreams: [], now: NOW })
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const scene = buildScene(layout, byId, new Set(byId.keys()), new Set(), 1)
      const rec = recordingContext()
      const p = layout.nodes.get(a.id)!
      const stats = drawFrame(rec.ctx, {
        scene,
        vp: { tx: 600 - p.x, ty: 300 - p.y, scale: 1 },
        width: 1200,
        height: 600,
        dpr: 1,
        palette: DEFAULT_PALETTE,
        overlays: new Map(),
        selectedId: null,
        hoverId: null,
        time: 0
      })
      expect(stats.edgesDrawn).toBe(1)
      return rec.calls.filter((c) => c.name === 'closePath').length
    }
    expect(draw('depends-on')).toBe(draw('related') + 1)
  })
})

describe('goal tree cards', () => {
  const p = plan('plans/auth.md')
  const inA = issue(R, 10, { workstreams: ['a'] })
  const goal = stream('g', 'Closed beta', { status: 'active', progress: { done: 3, total: 8, blocked: 2 } })
  const auth = stream('a', 'Auth', { parentId: 'g', plan: p.id })
  const nodes = [p, inA]
  const layout = computeLayout({ nodes, edges: [], workstreams: [goal, auth], now: NOW })
  const byId = new Map(nodes.map((n) => [n.id, n]))

  it('the scene always shows tree cards, undimmed, even when filters or the focus hide the plan node', () => {
    const s = buildScene(layout, byId, new Set([inA.id]), new Set([p.id]), 1)
    expect(s.visible.has(streamCardId('g'))).toBe(true)
    expect(s.visible.has(p.id)).toBe(true)
    expect(s.dimmed.has(p.id)).toBe(false)
    const card = layout.nodes.get(streamCardId('g'))!
    expect(s.hit.at(card.x + 5, card.y + 5)).toBe(streamCardId('g'))
  })

  it('draws the synthetic card with its name and progress, a solid link to its parent and a link from its item', () => {
    const scene = buildScene(layout, byId, new Set(byId.keys()), new Set(), 1)
    const card = layout.nodes.get(streamCardId('g'))!
    const rec = recordingContext()
    // Centre the view on the tree.
    const vp = { tx: 600 - card.x, ty: 300 - card.y, scale: 1 }
    const stats = drawFrame(rec.ctx, {
      scene,
      vp,
      width: 1200,
      height: 600,
      dpr: 1,
      palette: DEFAULT_PALETTE,
      overlays: new Map(),
      selectedId: null,
      hoverId: null,
      time: 0
    })
    const texts = rec.calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
    expect(texts).toContain('Closed beta')
    expect(texts).toContain('3/8')
    expect(texts).toContain('⛔2')
    expect(stats.treeLinksDrawn).toBe(1)
    // inA → its stream's card (the plan node)
    expect(layout.tree.members).toEqual([{ from: inA.id, to: p.id }])
    expect(stats.memberLinksDrawn).toBe(1)
    expect(stats.nodesDrawn).toBe(3)
  })
})
