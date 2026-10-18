// Which symbols a change adds, removes and modifies.
//
// ArchDiff matches nodes by semantic id over the whole graph, which merges
// same-named symbols (every Rust `fn new() -> Self` is one id) and never sees
// an edit inside a body (no tracked field changes). A PR card needs both, so
// here symbols are matched per file, only in the files the change touches
// (every other file indexes the same on both sides), and an edit is a changed
// line inside the symbol's span.

import type { GraphNode, NodeKind } from '../graph.js'
import { nodeSemanticId } from '../identity.js'
import { byCodeUnit, diffNodeProps } from '../diff/compute.js'
import type { ChangedFile } from '../ports.js'
import { hunkLines } from './unified-diff.js'

/** Index nodes that are not symbols a reader would name as changed */
const NOT_SYMBOLS: ReadonlySet<NodeKind> = new Set(['file', 'import', 'export', 'parameter'])

export function isSymbol(n: Pick<GraphNode, 'kind'>): boolean {
  return !NOT_SYMBOLS.has(n.kind)
}

/** Kinds whose body holds statements: a value declared inside one belongs to it */
const BODY_KINDS: ReadonlySet<NodeKind> = new Set(['function', 'method', 'component', 'route'])
/** Kinds that a body can declare locally */
const LOCAL_KINDS: ReadonlySet<NodeKind> = new Set(['variable', 'constant', 'property', 'field'])

export interface SymbolChanges {
  /** Head nodes */
  added: GraphNode[]
  /** Base nodes */
  removed: GraphNode[]
  modified: Array<{ base: GraphNode; head: GraphNode }>
}

const within = (inner: GraphNode, outer: GraphNode) =>
  inner !== outer && inner.startLine >= outer.startLine && inner.endLine <= outer.endLine

/**
 * The symbols a changed line belongs to: the innermost ones whose span holds it. A local declared inside a function
 * body (a `const` the indexer lists) gives its line to the function, so editing a body modifies the function.
 */
export function symbolsOnLines(symbols: readonly GraphNode[], ranges: ReadonlyArray<[number, number]>): Set<GraphNode> {
  const hit = new Set<GraphNode>()
  for (const [from, to] of ranges) {
    const holding = symbols.filter((s) => s.startLine <= to && s.endLine >= from)
    for (let line = from; line <= to; line++) {
      const here = holding.filter((s) => s.startLine <= line && s.endLine >= line)
      const owners = here.filter(
        (s) => !(LOCAL_KINDS.has(s.kind) && here.some((b) => BODY_KINDS.has(b.kind) && within(s, b)))
      )
      if (owners.length === 0) continue
      const span = Math.min(...owners.map((s) => s.endLine - s.startLine))
      for (const s of owners) if (s.endLine - s.startLine === span) hit.add(s)
    }
  }
  return hit
}

const byLine = (a: GraphNode, b: GraphNode) => a.startLine - b.startLine || a.startColumn - b.startColumn

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const t of items) {
    const k = key(t)
    const list = out.get(k)
    if (list) list.push(t)
    else out.set(k, [t])
  }
  return out
}

/**
 * The symbols `files` change between two snapshots. Base and head symbols match by semantic id within a file (a
 * renamed file maps to its old path), several with one id pairing in line order; then leftovers by kind and
 * qualified name within a file (a new signature); then a symbol left over on both sides with an id no other
 * leftover has moved between files. A matched pair is modified when a field ArchDiff tracks
 * differs (a move included), or a changed line is its own (`symbolsOnLines`) on either side. Unmatched head symbols
 * are added, unmatched base symbols removed.
 */
export function changedSymbols(
  baseNodes: readonly GraphNode[],
  headNodes: readonly GraphNode[],
  files: readonly ChangedFile[]
): SymbolChanges {
  const basePathOf = new Map<string, string>()
  const baseFiles = new Set<string>()
  const headFiles = new Set<string>()
  for (const f of files) {
    if (f.status !== 'added') baseFiles.add(f.oldPath ?? f.path)
    if (f.status !== 'deleted') headFiles.add(f.path)
    basePathOf.set(f.path, f.oldPath ?? f.path)
  }
  const base = baseNodes.filter((n) => isSymbol(n) && baseFiles.has(n.filePath)).sort(byLine)
  const head = headNodes.filter((n) => isSymbol(n) && headFiles.has(n.filePath)).sort(byLine)

  const pairs: Array<{ base: GraphNode; head: GraphNode }> = []
  const leftBase = new Set(base)
  const leftHead = new Set(head)
  /** Pairs leftovers that share a key in line order; the key of a head node uses its base path */
  const pairBy = (key: (n: GraphNode, file: string) => string) => {
    const baseByKey = groupBy([...leftBase], (n) => key(n, n.filePath))
    for (const [k, heads] of groupBy([...leftHead], (n) => key(n, basePathOf.get(n.filePath) ?? n.filePath))) {
      const bases = baseByKey.get(k) ?? []
      for (let i = 0; i < Math.min(bases.length, heads.length); i++) {
        pairs.push({ base: bases[i], head: heads[i] })
        leftBase.delete(bases[i])
        leftHead.delete(heads[i])
      }
    }
  }
  pairBy((n, file) => `${nodeSemanticId(n)}\u0000${file}`)
  // A new signature is a new semantic id, but on a PR card the same function with new parameters is modified
  pairBy((n, file) => `${n.kind}\u0000${n.qualifiedName}\u0000${file}`)
  const movedBase = groupBy([...leftBase], nodeSemanticId)
  for (const [sem, heads] of groupBy([...leftHead], nodeSemanticId)) {
    const bases = movedBase.get(sem)
    if (heads.length !== 1 || bases?.length !== 1) continue
    pairs.push({ base: bases[0], head: heads[0] })
    leftBase.delete(bases[0])
    leftHead.delete(heads[0])
  }

  const touched = (nodes: GraphNode[], side: 'base' | 'head') => {
    const out = new Set<GraphNode>()
    const byFile = groupBy(nodes, (n) => n.filePath)
    for (const f of files) {
      const path = side === 'base' ? (f.oldPath ?? f.path) : f.path
      const symbols = byFile.get(path)
      if (!symbols) continue
      const ranges = f.hunks
        .map((h) => (side === 'base' ? hunkLines(h.baseStart, h.baseLines) : hunkLines(h.headStart, h.headLines)))
        .filter((r): r is [number, number] => r !== null)
      for (const s of symbolsOnLines(symbols, ranges)) out.add(s)
    }
    return out
  }
  const baseTouched = touched(base, 'base')
  const headTouched = touched(head, 'head')
  const modified = pairs
    .filter((p) => diffNodeProps(p.base, p.head) !== null || baseTouched.has(p.base) || headTouched.has(p.head))
    .sort((a, b) => byCodeUnit(a.head.filePath, b.head.filePath) || byLine(a.head, b.head))

  const ordered = (nodes: Iterable<GraphNode>) =>
    [...nodes].sort((a, b) => byCodeUnit(a.filePath, b.filePath) || byLine(a, b))
  return { added: ordered(leftHead), removed: ordered(leftBase), modified }
}
