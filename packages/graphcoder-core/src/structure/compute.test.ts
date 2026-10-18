import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '../graph.js'
import type { PackageInfo } from '../hygiene.js'
import { computeChangeStructure, testEdgeFilter, type StructureSide } from './compute.js'
import { changed, fileNode, link, sym } from './fixtures.js'

const pkg: PackageInfo = { name: 'app', deps: [], dir: 'app' }

/*
 * base: app/src/math/ops.ts  add(1-3)  sub(5-7)
 *       app/src/ui/view.ts   render(1-4) → add
 *       app/src/math/ops.test.ts  it('adds') (2-4) → add
 * head: add's body edited, sub removed, mul added (9-11), render unchanged
 */
function side(nodes: GraphNode[], edges: GraphEdge[]): StructureSide {
  return {
    snapshot: { nodes, edges },
    testFiles: [
      {
        file: 'app/src/math/ops.test.ts',
        cases: [
          {
            id: 'app/src/math/ops.test.ts::adds',
            file: 'app/src/math/ops.test.ts',
            name: 'adds',
            start: 2,
            end: 4,
            scopes: []
          }
        ]
      }
    ],
    testRanges: new Map(),
    packages: new Map(nodes.map((n) => [n.filePath, pkg]))
  }
}

const ops = fileNode('app/src/math/ops.ts')
const view = fileNode('app/src/ui/view.ts')
const test = fileNode('app/src/math/ops.test.ts')
const render = sym('function', 'render', 'app/src/ui/view.ts', [1, 4])

const baseAdd = sym('function', 'add', 'app/src/math/ops.ts', [1, 3])
const sub = sym('function', 'sub', 'app/src/math/ops.ts', [5, 7])
const base = side(
  [ops, view, test, baseAdd, sub, render],
  [
    link(ops, baseAdd, 'contains'),
    link(ops, sub, 'contains'),
    link(view, render, 'contains'),
    link(render, baseAdd),
    link(test, baseAdd, 'calls', { line: 3 })
  ]
)

const add = sym('function', 'add', 'app/src/math/ops.ts', [1, 4])
const mul = sym('function', 'mul', 'app/src/math/ops.ts', [6, 8])
const head = side(
  [ops, view, test, add, mul, render],
  [
    link(ops, add, 'contains'),
    link(ops, mul, 'contains'),
    link(view, render, 'contains'),
    link(render, add),
    link(test, add, 'calls', { line: 3 })
  ]
)

describe('computeChangeStructure', () => {
  const files = [
    changed('app/src/math/ops.ts', [
      [2, 0, 3, 1],
      [5, 3, 6, 3]
    ])
  ]
  const s = computeChangeStructure({
    base: 'b'.repeat(40),
    head: 'h'.repeat(40),
    files,
    baseSide: base,
    headSide: head
  })

  it('names the symbols the change adds, removes and modifies', () => {
    expect(s.symbols.added.map((r) => r.qualifiedName)).toEqual(['mul'])
    expect(s.symbols.removed.map((r) => r.qualifiedName)).toEqual(['sub'])
    expect(s.symbols.modified.map((r) => r.qualifiedName)).toEqual(['add'])
    expect(s.symbols.added[0]).toMatchObject({ kind: 'function', filePath: 'app/src/math/ops.ts' })
    expect(s.symbols.added[0].id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('groups them by module', () => {
    expect(s.modules).toEqual([{ module: 'app/src/math', label: 'app/src/math', added: 1, removed: 1, modified: 1 }])
  })

  it('measures reach over the head: add and mul share a file, 2 hops apart', () => {
    expect([s.reach, s.parts]).toEqual([2, 1])
  })

  it('finds the tests that reach the changed symbols', () => {
    expect(s.tests).toEqual([{ id: 'app/src/math/ops.test.ts::adds', file: 'app/src/math/ops.test.ts', depth: 1 }])
  })

  it('carries the shas and no violations yet', () => {
    expect(s).toMatchObject({ base: 'b'.repeat(40), head: 'h'.repeat(40), violations: [] })
  })

  it('measures a change that only removes over the base', () => {
    const lonely = sym('function', 'lonely', 'app/src/ui/view.ts', [6, 8])
    const b = side([...base.snapshot.nodes, lonely], [...base.snapshot.edges, link(view, lonely, 'contains')])
    const r = computeChangeStructure({
      base: 'b',
      head: 'h',
      files: [changed('app/src/ui/view.ts', [[6, 3, 5, 0]]), changed('app/src/math/ops.ts', [[5, 3, 4, 0]])],
      baseSide: b,
      headSide: side(
        [ops, view, test, baseAdd, render],
        base.snapshot.edges.filter((e) => e.target !== sub.id)
      )
    })
    expect(r.symbols.removed.map((n) => n.name)).toEqual(['sub', 'lonely'])
    // sub – ops.ts – add – render – view.ts – lonely
    expect([r.reach, r.parts]).toEqual([5, 1])
    expect(r.tests).toEqual([])
  })

  it('takes P2 module membership through moduleOf', () => {
    const r = computeChangeStructure({
      base: 'b',
      head: 'h',
      files,
      baseSide: base,
      headSide: head,
      moduleOf: () => ({ module: 'arithmetic', label: 'Arithmetic' })
    })
    expect(r.modules).toEqual([{ module: 'arithmetic', label: 'Arithmetic', added: 1, removed: 1, modified: 1 }])
  })
})

describe('testEdgeFilter', () => {
  const test = fileNode('src/a.test.ts')
  const other = fileNode('src/b.test.ts')
  const add = sym('function', 'add', 'src/math.ts')
  const byName = { metadata: { confidence: 0.9, resolvedBy: 'exact-match' } }
  const keep = testEdgeFilter({ nodes: [test, other, add], edges: [link(test, add, 'imports')] })

  it('follows a common name bound by name only where the file imports that symbol', () => {
    expect(keep(link(test, add, 'calls', byName), test, add)).toBe(true)
    expect(keep(link(other, add, 'calls', byName), other, add)).toBe(false)
  })

  it('follows any other name at any confidence', () => {
    const parse = sym('function', 'parseConfig', 'src/config.ts')
    const guess = { metadata: { confidence: 0.4, resolvedBy: 'exact-match' } }
    expect(keep(link(other, parse, 'calls', guess), other, parse)).toBe(true)
  })
})
