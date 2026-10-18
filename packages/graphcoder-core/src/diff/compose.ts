// Composition: diff(A→B) then diff(B→C) gives diff(A→C). Diffs form a monoid
// (the empty diff is the identity, composition is associative); operations on
// one node or one edge fold into one, or cancel.

import { computeDiffHash } from './hash.js'
import { diffNodeProps, propChangeOp, propEqual, sortOps } from './compute.js'
import type { ArchDiff, ArchOp, NodeProps } from './types.js'

type NodeOp = Extract<ArchOp, { op: 'add_node' | 'remove_node' | 'modify_node' | 'move_node' }>
type PropOp = Extract<ArchOp, { op: 'modify_node' | 'move_node' }>

function opKey(op: ArchOp): string {
  switch (op.op) {
    case 'add_node':
      return `node:${op.node.id}`
    case 'remove_node':
    case 'modify_node':
    case 'move_node':
      return `node:${op.id}`
    case 'add_edge':
    case 'remove_edge':
      return `edge:${op.edge.source}|${op.edge.target}|${op.edge.kind}`
  }
}

/** A modify or move as before/after values. */
function asChange(op: PropOp): { prev: Partial<NodeProps>; next: Partial<NodeProps> } {
  return op.op === 'move_node'
    ? { prev: { filePath: op.from.filePath }, next: { filePath: op.to.filePath } }
    : { prev: op.prev, next: op.next }
}

/** Two prop changes in sequence; null when the second undoes the first. */
function foldChanges(first: PropOp, second: PropOp): ArchOp | null {
  const a = asChange(first)
  const b = asChange(second)
  const prev: Record<string, unknown> = { ...b.prev, ...a.prev }
  const next: Record<string, unknown> = { ...a.next, ...b.next }
  for (const f of Object.keys(prev) as (keyof NodeProps)[]) {
    if (propEqual(f, prev[f], next[f])) {
      delete prev[f]
      delete next[f]
    }
  }
  if (Object.keys(prev).length === 0) return null
  const folded = propChangeOp(first.id, prev as Partial<NodeProps>, next as Partial<NodeProps>)
  if (folded.op === 'move_node' && second.op === 'move_node' && second.to.hint) folded.to.hint = second.to.hint
  return folded
}

function invalid(first: ArchOp, second: ArchOp): never {
  throw new Error(`Cannot compose: ${first.op} then ${second.op} on ${opKey(first)} is not a valid chain`)
}

function foldNode(first: NodeOp, second: NodeOp): ArchOp | null {
  if (first.op === 'add_node') {
    if (second.op === 'remove_node') return null
    if (second.op === 'modify_node') return { op: 'add_node', node: { ...first.node, ...second.next } }
    if (second.op === 'move_node') return { op: 'add_node', node: { ...first.node, filePath: second.to.filePath } }
    return invalid(first, second)
  }
  if (first.op === 'remove_node') {
    // The same identity back: only its mutable fields can differ
    if (second.op !== 'add_node') return invalid(first, second)
    const change = diffNodeProps(first.node, second.node)
    return change ? propChangeOp(first.id, change.prev, change.next) : null
  }
  if (second.op === 'add_node') return invalid(first, second)
  if (second.op === 'remove_node') {
    // Removing a node first changed: the removed content is as A had it
    return { op: 'remove_node', id: second.id, node: { ...second.node, ...asChange(first).prev } }
  }
  return foldChanges(first, second)
}

function fold(first: ArchOp, second: ArchOp): ArchOp | null {
  if (first.op === 'add_edge' || first.op === 'remove_edge') {
    // An edge added then removed, or removed then added back, is no change
    if (second.op === first.op) return invalid(first, second)
    return null
  }
  return foldNode(first, second as NodeOp)
}

export function compose(abDiff: ArchDiff, bcDiff: ArchDiff): ArchDiff {
  if (abDiff.target !== bcDiff.base) {
    throw new Error(`Cannot compose: diff_AB.target (${abDiff.target}) !== diff_BC.base (${bcDiff.base})`)
  }
  const opsByKey = new Map<string, ArchOp>()
  for (const op of abDiff.operations) opsByKey.set(opKey(op), op)
  for (const op of bcDiff.operations) {
    const key = opKey(op)
    const earlier = opsByKey.get(key)
    if (!earlier) {
      opsByKey.set(key, op)
      continue
    }
    const folded = fold(earlier, op)
    if (folded) opsByKey.set(key, folded)
    else opsByKey.delete(key)
  }
  const partial = {
    version: 2 as const,
    base: abDiff.base,
    target: bcDiff.target,
    operations: sortOps([...opsByKey.values()])
  }
  return { ...partial, diffHash: computeDiffHash(partial) }
}
