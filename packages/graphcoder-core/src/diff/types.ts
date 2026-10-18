// ArchDiff v2: a structural change between two graph snapshots as an ordered,
// content-addressed list of operations. Nodes are named by semantic id, so a
// move is one `move_node`, not a remove and an add.

import type { EdgeKind, NodeKind } from '../graph.js'

export interface ArchDiff {
  version: 2
  /** `snapshotHash` of the snapshot the diff applies to */
  base: string
  /** `snapshotHash` of the snapshot it produces */
  target: string
  /** sha256 of the canonical JSON of the diff without this field */
  diffHash: string
  /** In canonical order: see `sortOps` */
  operations: ArchOp[]
}

export type ArchOp =
  | { op: 'add_node'; node: NodeSnapshot }
  /** Carries the removed node in full, so the diff can be inverted and composed */
  | { op: 'remove_node'; id: string; node: NodeSnapshot }
  | { op: 'modify_node'; id: string; prev: Partial<NodeProps>; next: Partial<NodeProps> }
  | { op: 'move_node'; id: string; from: { filePath: string }; to: { filePath: string; hint?: LocationHint } }
  | { op: 'add_edge'; edge: EdgeTuple }
  | { op: 'remove_edge'; edge: EdgeTuple }

export interface NodeSnapshot {
  /** Semantic id */
  id: string
  kind: NodeKind
  name: string
  qualifiedName: string
  filePath: string
  language: string
  signature?: string
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  isExported?: boolean
  isAsync?: boolean
  isStatic?: boolean
  isAbstract?: boolean
  returnType?: string
  decorators?: string[]
  typeParameters?: string[]
  /** Advisory facts, e.g. `renameOf`: the semantic id of the removed node this one probably renames */
  properties?: Record<string, string | number | boolean>
}

/** The fields that can change without changing identity. A change to kind, name or signature is a remove + add. */
export type NodeProps = Omit<NodeSnapshot, 'id' | 'kind' | 'name' | 'signature'>

/** An edge is its triple; a change to any part is a different edge (there is no `modify_edge`). */
export interface EdgeTuple {
  /** Semantic id */
  source: string
  /** Semantic id */
  target: string
  kind: EdgeKind
  /**
   * How the indexer resolved the edge (`confidence`, `resolvedBy`, `refName`; maybe empty): set on every edge an
   * observed diff (`computeArchDiff`) adds. Absent on a planned edge, whose author names both ends by semantic id.
   */
  metadata?: Record<string, unknown>
  /** Source line of the edge in the target snapshot, when known */
  line?: number
}

export interface LocationHint {
  after?: string
  before?: string
  container?: string
}
