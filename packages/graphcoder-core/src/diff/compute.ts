import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph.js'
import { nodeSemanticId } from '../identity.js'
import { computeDiffHash, snapshotHash } from './hash.js'
import type { ArchDiff, ArchOp, EdgeTuple, NodeProps, NodeSnapshot } from './types.js'

/** Canonical order: removes before modifies before adds, so applying in order never meets a transient conflict. */
const OP_ORDER: Record<ArchOp['op'], number> = {
  remove_edge: 0,
  remove_node: 1,
  modify_node: 2,
  move_node: 3,
  add_node: 4,
  add_edge: 5
}

/** Code-unit order: the same on every machine, unlike `localeCompare`. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function edgeKey(e: Pick<EdgeTuple, 'source' | 'target' | 'kind'>): string {
  return `${e.source}|${e.target}|${e.kind}`
}

function opSortKey(op: ArchOp): string {
  if (op.op === 'add_node') return op.node.id
  if (op.op === 'remove_node' || op.op === 'modify_node' || op.op === 'move_node') return op.id
  return edgeKey(op.edge)
}

/** Sort into canonical order: by kind of operation, then node id or edge triple. */
export function sortOps(ops: ArchOp[]): ArchOp[] {
  return [...ops].sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op] || byCodeUnit(opSortKey(a), opSortKey(b)))
}

export function toNodeSnapshot(node: GraphNode, semId: string): NodeSnapshot {
  return {
    id: semId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    signature: node.signature,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
    returnType: node.returnType,
    decorators: node.decorators,
    typeParameters: node.typeParameters
  }
}

/** The mutable fields a diff tracks, in a fixed order. */
export const NODE_PROP_FIELDS: readonly (keyof NodeProps)[] = [
  'qualifiedName',
  'filePath',
  'language',
  'visibility',
  'isExported',
  'isAsync',
  'isStatic',
  'isAbstract',
  'returnType',
  'decorators',
  'typeParameters'
]

const ARRAY_FIELDS: ReadonlySet<keyof NodeProps> = new Set(['decorators', 'typeParameters'])

export function propEqual(field: keyof NodeProps, a: unknown, b: unknown): boolean {
  return ARRAY_FIELDS.has(field) ? JSON.stringify(a) === JSON.stringify(b) : a === b
}

/** The fields that differ, old and new values; null when none do. */
export function diffNodeProps(
  base: Partial<NodeProps>,
  target: Partial<NodeProps>
): { prev: Partial<NodeProps>; next: Partial<NodeProps> } | null {
  const prev: Record<string, unknown> = {}
  const next: Record<string, unknown> = {}
  let changed = false
  for (const f of NODE_PROP_FIELDS) {
    if (propEqual(f, base[f], target[f])) continue
    prev[f] = base[f]
    next[f] = target[f]
    changed = true
  }
  return changed ? { prev: prev as Partial<NodeProps>, next: next as Partial<NodeProps> } : null
}

/** A prop change as one operation: a move when only the file changed, else a modify. */
export function propChangeOp(id: string, prev: Partial<NodeProps>, next: Partial<NodeProps>): ArchOp {
  const fields = Object.keys(prev)
  if (fields.length === 1 && fields[0] === 'filePath') {
    return { op: 'move_node', id, from: { filePath: prev.filePath! }, to: { filePath: next.filePath! } }
  }
  return { op: 'modify_node', id, prev, next }
}

const confidenceOf = (e: GraphEdge): number => {
  const c = e.metadata?.['confidence']
  return typeof c === 'number' ? c : -1
}

/** Higher resolver confidence first, then the earlier line */
function betterResolved(a: GraphEdge, b: GraphEdge): boolean {
  const byConfidence = confidenceOf(a) - confidenceOf(b)
  if (byConfidence !== 0) return byConfidence > 0
  return (a.line ?? Infinity) < (b.line ?? Infinity)
}

/** Lines within which a removed and an added node of one kind in one file count as a probable rename */
const RENAME_LINE_WINDOW = 5

/**
 * The structural change from `base` to `target`. Nodes match by semantic id; when several nodes share one (the
 * known collision), the last one in each snapshot stands for it. A removed and an added node of the same kind in the
 * same file within a few lines get a `renameOf` hint on the added node, advisory only.
 */
export function computeArchDiff(base: GraphSnapshot, target: GraphSnapshot): ArchDiff {
  const baseMap = new Map<string, GraphNode>()
  const targetMap = new Map<string, GraphNode>()
  const baseCgToSem = new Map<string, string>()
  const targetCgToSem = new Map<string, string>()
  for (const n of base.nodes) {
    const sid = nodeSemanticId(n)
    baseMap.set(sid, n)
    baseCgToSem.set(n.id, sid)
  }
  for (const n of target.nodes) {
    const sid = nodeSemanticId(n)
    targetMap.set(sid, n)
    targetCgToSem.set(n.id, sid)
  }

  const ops: ArchOp[] = []
  for (const [sid, baseNode] of baseMap) {
    const targetNode = targetMap.get(sid)
    if (!targetNode) continue
    const change = diffNodeProps(baseNode, targetNode)
    if (change) ops.push(propChangeOp(sid, change.prev, change.next))
  }

  const removedByKindFile = new Map<string, Array<{ sid: string; node: GraphNode }>>()
  for (const [sid, node] of baseMap) {
    if (targetMap.has(sid)) continue
    ops.push({ op: 'remove_node', id: sid, node: toNodeSnapshot(node, sid) })
    const bucket = `${node.kind}|${node.filePath}`
    removedByKindFile.set(bucket, [...(removedByKindFile.get(bucket) ?? []), { sid, node }])
  }
  for (const [sid, node] of targetMap) {
    if (baseMap.has(sid)) continue
    const snap = toNodeSnapshot(node, sid)
    const renamedFrom = removedByKindFile
      .get(`${node.kind}|${node.filePath}`)
      ?.find((r) => Math.abs(r.node.startLine - node.startLine) <= RENAME_LINE_WINDOW)
    if (renamedFrom) snap.properties = { ...snap.properties, renameOf: renamedFrom.sid }
    ops.push({ op: 'add_node', node: snap })
  }

  const baseEdges = new Map<string, EdgeTuple>()
  for (const e of base.edges) {
    const source = baseCgToSem.get(e.source)
    const targetSem = baseCgToSem.get(e.target)
    if (!source || !targetSem) continue
    const et: EdgeTuple = { source, target: targetSem, kind: e.kind }
    baseEdges.set(edgeKey(et), et)
  }
  // Several indexed edges can share one semantic key (two call sites); the added edge carries the best-resolved one
  const targetEdges = new Map<string, { tuple: EdgeTuple; instance: GraphEdge }>()
  for (const e of target.edges) {
    const source = targetCgToSem.get(e.source)
    const targetSem = targetCgToSem.get(e.target)
    if (!source || !targetSem) continue
    const tuple: EdgeTuple = { source, target: targetSem, kind: e.kind }
    const k = edgeKey(tuple)
    const held = targetEdges.get(k)
    if (!held || betterResolved(e, held.instance)) targetEdges.set(k, { tuple, instance: e })
  }
  for (const [k, edge] of baseEdges) if (!targetEdges.has(k)) ops.push({ op: 'remove_edge', edge })
  for (const [k, { tuple, instance }] of targetEdges) {
    if (baseEdges.has(k)) continue
    // An observed edge always carries metadata (maybe empty), which tells it apart from a planned one
    const edge: EdgeTuple = { ...tuple, metadata: instance.metadata ?? {} }
    if (typeof instance.line === 'number') edge.line = instance.line
    ops.push({ op: 'add_edge', edge })
  }

  const partial = {
    version: 2 as const,
    base: snapshotHash(base),
    target: snapshotHash(target),
    operations: sortOps(ops)
  }
  return { ...partial, diffHash: computeDiffHash(partial) }
}
