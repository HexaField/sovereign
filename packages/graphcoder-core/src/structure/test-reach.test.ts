import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '../graph.js'
import { isTestPath, nameNoise } from '../hygiene.js'
import { fileNode, link, sym } from './fixtures.js'
import { seedBelongsTo, testsReaching, type TestCase, type TestFile } from './test-reach.js'

const tc = (file: string, name: string, start: number, end: number, scopes: Array<[number, number]>): TestCase => ({
  id: `${file}::${name}`,
  file,
  name,
  start,
  end,
  scopes
})

/*
 * src/a.test.ts
 *   1      module level: helperFile()           → every test
 *   2-20   describe('suite')
 *   3        setup()  (describe body)            → t1, t2
 *   5-8      it('t1'): foo()                     → foo → bar; foo references baz
 *   10-12    it('t2'): helper()  (test-file fn)  → helper → deep
 *   22-30  describe('other')
 *   23       otherSetup() (describe body)        → t3 only
 *   25-27    it('t3'): qux()
 * src/b.test.ts — no parsed cases (file granularity): zed()
 * src/c.rs — a #[test] fn inside mod tests calling zed
 */
const A = 'src/a.test.ts'
const B = 'src/b.test.ts'
const C = 'src/c.rs'
const fileA = fileNode(A)
const fileB = fileNode(B)
const helper = sym('function', 'helper', A, [14, 16])
const fns = Object.fromEntries(
  ['foo', 'bar', 'baz', 'setup', 'deep', 'otherSetup', 'qux', 'helperFile', 'zed', 'orphan'].map((n, i) => [
    n,
    sym('function', n, 'src/lib.ts', [i * 10 + 1, i * 10 + 5])
  ])
)
const rustTest = sym('function', 'zeds_work', C, [41, 44])
const nodes: GraphNode[] = [fileA, fileB, helper, rustTest, ...Object.values(fns)]
const at = (line: number): Partial<GraphEdge> => ({ line })
const edges: GraphEdge[] = [
  link(fileA, fns.helperFile, 'calls', at(1)),
  link(fileA, fns.setup, 'calls', at(3)),
  link(fileA, fns.foo, 'calls', at(6)),
  link(fns.foo, fns.bar),
  link(fns.foo, fns.baz, 'references'),
  link(fileA, helper, 'calls', at(11)),
  link(helper, fns.deep),
  link(fileA, fns.otherSetup, 'calls', at(23)),
  link(fileA, fns.qux, 'calls', at(26)),
  link(fileB, fns.zed, 'calls', at(4)),
  link(fileA, fns.orphan, 'imports', at(1)), // imports do not count as reach
  link(rustTest, fns.zed)
]
const testFiles: TestFile[] = [
  {
    file: A,
    cases: [
      tc(A, 'suite t1', 5, 8, [[2, 20]]),
      tc(A, 'suite t2', 10, 12, [[2, 20]]),
      tc(A, 'other t3', 25, 27, [[22, 30]])
    ]
  },
  { file: B, cases: null },
  { file: C, cases: [{ ...tc(C, 'zeds_work', 40, 44, []), callable: true }] }
]
const isTestCode = (n: GraphNode) => isTestPath(n.filePath) || (n.filePath === C && n.startLine >= 38)
const reaching = (names: string[], extra: Partial<Parameters<typeof testsReaching>[4]> = {}) =>
  testsReaching(
    nodes,
    edges,
    testFiles,
    names.map((n) => fns[n].id),
    { isTestCode, ...extra }
  ).map((t) => `${t.id}@${t.depth}`)

describe('testsReaching', () => {
  it('attributes test-callback calls to their case, with depth', () => {
    expect(reaching(['foo'])).toEqual([`${A}::suite t1@1`])
    expect(reaching(['bar'])).toEqual([`${A}::suite t1@2`])
    expect(reaching(['qux'])).toEqual([`${A}::other t3@1`])
  })

  it('reaches functions passed as values through references edges', () => {
    expect(reaching(['baz'])).toEqual([`${A}::suite t1@2`])
  })

  it('gives describe-body setup to every test in that describe only', () => {
    expect(reaching(['setup'])).toEqual([`${A}::suite t1@1`, `${A}::suite t2@1`])
    expect(reaching(['otherSetup'])).toEqual([`${A}::other t3@1`])
  })

  it('gives module-level calls to every test in the file', () => {
    expect(reaching(['helperFile'])).toEqual([`${A}::other t3@1`, `${A}::suite t1@1`, `${A}::suite t2@1`])
  })

  it('walks test-file helpers at no depth cost', () => {
    expect(reaching(['deep'])).toEqual([`${A}::suite t2@1`])
  })

  it('falls back to file granularity when a file has no parsed cases, and starts a callable test at its node', () => {
    expect(reaching(['zed'])).toEqual([`${B}@1`, `${C}::zeds_work@1`])
  })

  it('keeps each test once, at its nearest depth over several targets', () => {
    expect(reaching(['foo', 'bar', 'qux'])).toEqual([`${A}::other t3@1`, `${A}::suite t1@1`])
  })

  it('finds no test for code none reaches, nor through imports', () => {
    expect(reaching(['orphan'])).toEqual([])
  })

  it('counts a test whose own lines changed at depth 0', () => {
    const changedLines = new Map<string, Array<[number, number]>>([
      [A, [[11, 11]]],
      [B, [[2, 2]]]
    ])
    expect(reaching(['foo'], { changedLines })).toEqual([`${A}::suite t2@0`, `${B}@0`, `${A}::suite t1@1`])
  })

  it('follows only the edges `keep` passes', () => {
    const named = { ...fns, get: sym('method', 'get', 'src/lib.ts', [200, 201]) }
    const viaName = link(fileA, named.get, 'calls', {
      line: 6,
      metadata: { confidence: 0.7, resolvedBy: 'exact-match' }
    })
    const all = testsReaching([...nodes, named.get], [...edges, viaName], testFiles, [named.get.id], {
      isTestCode,
      keep: (e, _s, t) => nameNoise(e, t) === null
    })
    expect(all).toEqual([])
  })
})

describe('seedBelongsTo', () => {
  const all = testFiles[0].cases!
  it('counts lines inside the callback, enclosing describe bodies, and module level', () => {
    expect(seedBelongsTo(6, all[0], all)).toBe(true)
    expect(seedBelongsTo(3, all[0], all)).toBe(true)
    expect(seedBelongsTo(1, all[2], all)).toBe(true)
    expect(seedBelongsTo(undefined, all[2], all)).toBe(true)
  })
  it('rejects other tests and describes that do not enclose the test', () => {
    expect(seedBelongsTo(11, all[0], all)).toBe(false)
    expect(seedBelongsTo(23, all[0], all)).toBe(false)
  })
})
