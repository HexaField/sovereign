// The structure of a change: what a pull request does to the code, from the
// index of its merge base and of its head.

import type { ChangeStructure, ModuleTouch, SymbolRef } from '../contract.js'
import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph.js'
import { createEdgeHygiene, isTestPath, nameNoise, type PackageInfo, type TestRanges } from '../hygiene.js'
import { nodeSemanticId } from '../identity.js'
import { byCodeUnit } from '../diff/compute.js'
import type { ChangedFile } from '../ports.js'
import { changedSymbols } from './changes.js'
import { directoryModules, type ModuleOf } from './modules.js'
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
  /** Module membership; default `directoryModules` over both sides' packages (P2's module map plugs in here) */
  moduleOf?: ModuleOf
}

export function symbolRef(n: GraphNode): SymbolRef {
  return { id: nodeSemanticId(n), kind: n.kind, name: n.name, qualifiedName: n.qualifiedName, filePath: n.filePath }
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
 * test reaching code by a 0.7 match is still worth running). Rules
 * (`violations`) arrive with constraints (P3).
 */
export function computeChangeStructure(input: ChangeStructureInput): ChangeStructure {
  const { baseSide, headSide, files } = input
  const changes = changedSymbols(baseSide.snapshot.nodes, headSide.snapshot.nodes, files)
  const headChanged = [...changes.added, ...changes.modified.map((p) => p.head)]

  const packages = new Map([...baseSide.packages, ...headSide.packages])
  const moduleOf = input.moduleOf ?? directoryModules(packages)
  const touches = new Map<string, ModuleTouch>()
  const touch = (n: GraphNode, field: 'added' | 'removed' | 'modified') => {
    const { module, label } = moduleOf(n.filePath)
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
  const tests = testsReaching(
    headSide.snapshot.nodes,
    headSide.snapshot.edges,
    headSide.testFiles,
    headChanged.map((n) => n.id),
    { isTestCode: headTest, keep: testEdgeFilter(headSide.snapshot), changedLines }
  )

  return {
    base: input.base,
    head: input.head,
    modules,
    symbols: {
      added: changes.added.map(symbolRef),
      removed: changes.removed.map(symbolRef),
      modified: changes.modified.map((p) => symbolRef(p.head))
    },
    reach,
    parts,
    tests,
    violations: []
  }
}
