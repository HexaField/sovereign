// The structure of a change: what a pull request does to the code, from the
// index of its merge base and of its head.

import type { ChangeStructure, ModuleTouch, SymbolRef } from '../contract.js'
import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph.js'
import { createEdgeHygiene, isTestPath, nameNoise, type PackageInfo, type TestRanges } from '../hygiene.js'
import { nodeSemanticId } from '../identity.js'
import { byCodeUnit } from '../diff/compute.js'
import type { ChangedFile } from '../ports.js'
import { changedSymbols } from './changes.js'
import { directoryModules } from './modules.js'
import { conceptImpact } from '../concepts/impact.js'
import type { ConceptMap } from '../concepts/map.js'
import { breadcrumb } from '../concepts/tree.js'
import { changeReach } from './reach.js'
import { testsReaching, type TestFile } from './test-reach.js'
import { hunkLines } from './unified-diff.js'

/** One side of a change (its merge base or its head) as the host read it */
export interface StructureSide {
  snapshot: GraphSnapshot
  /** Test files, with their cases where the host could parse them */
  testFiles: TestFile[]
  /** Inline test code per file (Rust `#[cfg(test)]` modules) */
  testRanges: TestRanges
  /** Each file's nearest manifest (`readPackages`) */
  packages: Map<string, PackageInfo>
  /** The code → concept map, when this side has a concept tree */
  concepts?: ConceptMap
}

export interface ChangeStructureInput {
  /** Merge-base sha */
  base: string
  /** Head sha */
  head: string
  /** What `head` changes since `base` (`GitPort.diffRefs`) */
  files: ChangedFile[]
  baseSide: StructureSide
  headSide: StructureSide
}

export function symbolRef(n: GraphNode, concept?: string): SymbolRef {
  const ref: SymbolRef = {
    id: nodeSemanticId(n),
    kind: n.kind,
    name: n.name,
    qualifiedName: n.qualifiedName,
    filePath: n.filePath
  }
  return concept === undefined ? ref : { ...ref, concept }
}

/** Test code: a test file, or inside an inline test range */
export function testCodeOf(ranges: TestRanges): (n: GraphNode) => boolean {
  return (n) =>
    isTestPath(n.filePath) || (ranges.get(n.filePath) ?? []).some(([a, b]) => n.startLine >= a && n.startLine <= b)
}

/**
 * The edges test reach follows: hygiene's name-noise rules, except that a common name counts when the calling file
 * imports that very symbol (`import { add } from './math'` and then `add(1, 2)`: the index binds the call by name,
 * its import edge says which `add`).
 */
export function testEdgeFilter(
  snapshot: GraphSnapshot
): (edge: GraphEdge, source: GraphNode, target: GraphNode) => boolean {
  const fileOf = new Map(snapshot.nodes.map((n) => [n.id, n.filePath]))
  const imported = new Set(
    snapshot.edges.filter((e) => e.kind === 'imports').map((e) => `${fileOf.get(e.source)}\u0000${e.target}`)
  )
  return (edge, source, target) => {
    const noise = nameNoise(edge, target)
    return noise === null || (noise === 'common-name' && imported.has(`${source.filePath}\u0000${target.id}`))
  }
}

/**
 * The structure of a change: the symbols it adds, removes and modifies (`changedSymbols`), the modules they sit in,
 * its reach (`changeReach` over the head's changed non-test symbols; over the removed ones when it only removes),
 * and the tests that reach its head symbols (`testsReaching` over `testEdgeFilter`: at any confidence, since a
 * test reaching code by a 0.7 match is still worth running). Where a side has a concept tree, its map places each
 * symbol on a page (`SymbolRef.concept`, the module) and `concepts` says what the change does to the tree
 * (`conceptImpact`). Rules (`violations`) arrive with constraints (P3).
 */
export function computeChangeStructure(input: ChangeStructureInput): ChangeStructure {
  const { baseSide, headSide, files } = input
  const changes = changedSymbols(baseSide.snapshot.nodes, headSide.snapshot.nodes, files)
  const headChanged = [...changes.added, ...changes.modified.map((p) => p.head)]

  // A symbol's module: its concept page on its own side (head's; base's for a removed symbol), else its directory
  const directoryOf = directoryModules(new Map([...baseSide.packages, ...headSide.packages]))
  const labels = new Map<string, string>()
  const conceptOf = (n: GraphNode, side: StructureSide) => side.concepts?.pageOf(n)
  const moduleOf = (n: GraphNode, side: StructureSide) => {
    const map = side.concepts
    const page = conceptOf(n, side)
    if (!map || page === undefined) return directoryOf(n.filePath)
    const file = map.page(page)!.file
    if (!labels.has(file)) labels.set(file, breadcrumb(map.tree, page))
    return { module: file, label: labels.get(file)! }
  }
  const touches = new Map<string, ModuleTouch>()
  const touch = (n: GraphNode, field: 'added' | 'removed' | 'modified') => {
    const { module, label } = moduleOf(n, field === 'removed' ? baseSide : headSide)
    let t = touches.get(module)
    if (!t) touches.set(module, (t = { module, label, added: 0, removed: 0, modified: 0 }))
    t[field]++
  }
  for (const n of changes.added) touch(n, 'added')
  for (const n of changes.removed) touch(n, 'removed')
  for (const p of changes.modified) touch(p.head, 'modified')
  const size = (t: ModuleTouch) => t.added + t.removed + t.modified
  const modules = [...touches.values()].sort((a, b) => size(b) - size(a) || byCodeUnit(a.module, b.module))

  const headTest = testCodeOf(headSide.testRanges)
  const baseTest = testCodeOf(baseSide.testRanges)
  const hygieneOf = (side: StructureSide) =>
    createEdgeHygiene(side.snapshot.nodes, { packages: side.packages, testRanges: side.testRanges })
  const headCode = headChanged.filter((n) => !headTest(n))
  const { reach, parts } =
    headCode.length > 0 || changes.removed.length === 0
      ? changeReach(
          headSide.snapshot.nodes,
          headSide.snapshot.edges,
          hygieneOf(headSide),
          headCode.map((n) => n.id)
        )
      : changeReach(
          baseSide.snapshot.nodes,
          baseSide.snapshot.edges,
          hygieneOf(baseSide),
          changes.removed.filter((n) => !baseTest(n)).map((n) => n.id)
        )

  const changedLines = new Map<string, Array<[number, number]>>()
  for (const f of files) {
    const ranges = f.hunks.map((h) => hunkLines(h.headStart, h.headLines)).filter((r): r is [number, number] => !!r)
    if (f.status !== 'deleted' && ranges.length > 0) changedLines.set(f.path, ranges)
  }
  const reachOptions = { isTestCode: headTest, keep: testEdgeFilter(headSide.snapshot), changedLines }
  const testsOf = (ids: string[]) =>
    testsReaching(headSide.snapshot.nodes, headSide.snapshot.edges, headSide.testFiles, ids, reachOptions)
  const tests = testsOf(headChanged.map((n) => n.id))
  const concepts = conceptImpact({
    files,
    base: baseSide.concepts,
    head: headSide.concepts,
    changes,
    testsReaching: testsOf
  })

  return {
    base: input.base,
    head: input.head,
    modules,
    symbols: {
      added: changes.added.map((n) => symbolRef(n, conceptOf(n, headSide))),
      removed: changes.removed.map((n) => symbolRef(n, conceptOf(n, baseSide))),
      modified: changes.modified.map((p) => symbolRef(p.head, conceptOf(p.head, headSide)))
    },
    reach,
    parts,
    tests,
    violations: [],
    ...(concepts ? { concepts } : {})
  }
}
