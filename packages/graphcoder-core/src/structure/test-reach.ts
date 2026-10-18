// Static test reach: which tests can reach a changed symbol through the code
// graph. Ported from Graphcoder's feat/test-reach, turned around: the original
// searched forward from every test to every function (a project report); a
// change needs only the tests that reach its own symbols, so one backward
// search from the changed set answers it.

import type { EdgeKind, GraphEdge, GraphNode } from '../graph.js'
import { byCodeUnit } from '../diff/compute.js'
import type { TestRef } from '../contract.js'

/**
 * `references` counts: a function passed as a value (`patterns.map(compilePattern)`) is a `references` edge in
 * CodeGraph, not `calls`. Measured on Graphcoder's core, `calls` + `instantiates` alone missed 7.7% of the
 * (symbol, test) pairs a mutation sweep found; with `references` the miss rate dropped to 0.2%.
 */
export const REACH_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(['calls', 'instantiates', 'references'])

/** One test in a test file */
export interface TestCase {
  /** `<file>::<full name>`: enclosing `describe` titles and the test title joined with spaces, as vitest names it */
  id: string
  file: string
  name: string
  /** 1-based line range: the test callback, or the whole test function */
  start: number
  end: number
  /** Line ranges of the enclosing `describe` callbacks, outermost first */
  scopes: Array<[number, number]>
  /**
   * The test is a function the index holds (Rust `#[test] fn`), so its reach starts at that node. Otherwise it is a
   * callback (`it('…', () => …)`), whose calls the index attributes to the file node, with their lines.
   */
  callable?: boolean
}

/** A test file and its cases. `cases: null`: no per-case attribution, the file counts as one test. */
export interface TestFile {
  file: string
  cases: TestCase[] | null
}

/**
 * Does an edge at `line` of the test file run as part of `test`? Yes when the line sits inside the test's callback,
 * or outside every test callback and inside only `describe` bodies that enclose this test (collection-time setup,
 * `beforeEach`, module-level code).
 */
export function seedBelongsTo(line: number | undefined, test: TestCase, all: readonly TestCase[]): boolean {
  if (line === undefined) return true
  if (test.start <= line && line <= test.end) return true
  if (all.some((o) => o.start <= line && line <= o.end)) return false
  const own = new Set(test.scopes.map(([s, e]) => `${s}:${e}`))
  return all.every((o) => o.scopes.every(([s, e]) => !(s <= line && line <= e) || own.has(`${s}:${e}`)))
}

export interface TestReachOptions {
  /** Test code: hops through it cost nothing (a helper in a test file belongs to the test) */
  isTestCode: (node: GraphNode) => boolean
  /** Edges to follow, among `REACH_EDGE_KINDS`; default all */
  keep?: (edge: GraphEdge, source: GraphNode, target: GraphNode) => boolean
  /** Changed 1-based line ranges per file: a test whose own lines changed reaches the change at depth 0 */
  changedLines?: ReadonlyMap<string, ReadonlyArray<[number, number]>>
}

const overlaps = (ranges: ReadonlyArray<[number, number]> | undefined, from: number, to: number) =>
  ranges?.some(([a, b]) => a <= to && b >= from) ?? false

/**
 * The tests that reach any of `targets` (node ids), each at its smallest depth: the hops into non-test code from the
 * test to a target, the target included, so 1 = the test calls a changed symbol itself. Edges are `REACH_EDGE_KINDS`
 * that `keep` passes. A callback test starts from the edges its file node has at lines inside it (or in setup that
 * runs for it: `seedBelongsTo`); a callable test from its own node; a file without cases, or whose edges carry no
 * lines, is one test that starts from all its file node's edges. A test whose lines `changedLines` touches has
 * depth 0. Nearest first, then by id.
 */
export function testsReaching(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  testFiles: readonly TestFile[],
  targets: readonly string[],
  options: TestReachOptions
): TestRef[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const cost = (id: string) => {
    const n = nodeById.get(id)
    return n && options.isTestCode(n) ? 0 : 1
  }

  const callers = new Map<string, string[]>()
  const fileSeeds = new Map<string, Array<{ line?: number; target: string }>>()
  const functionsByFile = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.kind !== 'function' && n.kind !== 'method') continue
    const list = functionsByFile.get(n.filePath)
    if (list) list.push(n)
    else functionsByFile.set(n.filePath, [n])
  }
  for (const e of edges) {
    if (!REACH_EDGE_KINDS.has(e.kind)) continue
    const s = nodeById.get(e.source)
    const t = nodeById.get(e.target)
    if (!s || !t || (options.keep && !options.keep(e, s, t))) continue
    const list = callers.get(e.target)
    if (list) list.push(e.source)
    else callers.set(e.target, [e.source])
    if (s.kind === 'file') {
      const seeds = fileSeeds.get(s.filePath) ?? []
      seeds.push({ line: e.line ?? undefined, target: e.target })
      fileSeeds.set(s.filePath, seeds)
    }
  }

  // Backward 0-1 search: distance(n) = the cost of every node on the cheapest path n → … → target, both ends included
  const distance = new Map<string, number>()
  const deque: string[] = []
  let head = 0
  const relax = (id: string, d: number) => {
    if (d >= (distance.get(id) ?? Infinity)) return
    distance.set(id, d)
    deque.push(id) // plain FIFO with re-relaxation: correct for 0/1 costs, and zero-cost hops are rare
  }
  for (const t of targets) if (nodeById.has(t)) relax(t, cost(t))
  while (head < deque.length) {
    const v = deque[head++]
    const dv = distance.get(v)!
    for (const u of callers.get(v) ?? []) relax(u, dv + cost(u))
  }

  const depthOf = (seeds: readonly string[]) => Math.min(...seeds.map((s) => distance.get(s) ?? Infinity))
  const found = new Map<string, TestRef>()
  const add = (id: string, file: string, depth: number) => {
    if (!Number.isFinite(depth)) return
    const held = found.get(id)
    if (!held || depth < held.depth) found.set(id, { id, file, depth })
  }
  const edited = options.changedLines

  for (const tf of testFiles) {
    const seeds = fileSeeds.get(tf.file) ?? []
    const cases = tf.cases
    const callbacks = (cases ?? []).filter((c) => !c.callable)
    // Callback tests are told apart by the lines of their file node's edges
    if (cases === null || (callbacks.length > 0 && seeds.length > 0 && seeds.every((s) => s.line === undefined))) {
      add(tf.file, tf.file, overlaps(edited?.get(tf.file), 1, Infinity) ? 0 : depthOf(seeds.map((s) => s.target)))
      continue
    }
    for (const tc of cases) {
      if (overlaps(edited?.get(tf.file), tc.start, tc.end)) {
        add(tc.id, tf.file, 0)
      } else if (tc.callable) {
        const name = tc.name.replace(/ #\d+$/, '')
        const fn = (functionsByFile.get(tf.file) ?? []).filter(
          (n) => n.name === name && n.startLine >= tc.start && n.startLine <= tc.end
        )
        add(tc.id, tf.file, depthOf(fn.map((n) => n.id)))
      } else {
        add(tc.id, tf.file, depthOf(seeds.filter((s) => seedBelongsTo(s.line, tc, callbacks)).map((s) => s.target)))
      }
    }
  }
  return [...found.values()].sort((a, b) => a.depth - b.depth || byCodeUnit(a.id, b.id))
}
