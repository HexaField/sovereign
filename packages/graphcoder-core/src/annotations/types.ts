/**
 * Annotation model, v3: human understanding of the code, committed to the repo
 * as `.graphcoder/annotations/<slug>.json`.
 *
 * Two orthogonal axes:
 *   - SHAPE: derived from `ordered` and the member count; drives rendering.
 *   - KIND:  free-form, user-defined; the registry only keeps its colour.
 *
 * Committed format: { kind, label, description, ordered, members: [{ id, ref, file, note }], module?,
 *   status?: 'proposed', author?: 'agent', reasoning? }
 * Runtime adds: id (the slug), shape, status.
 */

export type AnnotationShape = 'region' | 'polyline' | 'point'

/** `proposed` is committed (an agent's suggestion awaiting review); the rest are derived at runtime */
export type AnnotationStatus = 'active' | 'proposed' | 'stale' | 'dismissed'

export interface AnnotationKind {
  name: string
  color: string
  description: string
  createdAt: string
}

/** A member: the semantic id resolves it; ref and file keep the committed JSON readable in diffs */
export interface AnnotationMember {
  /** Semantic id */
  id: string
  /** Qualified name */
  ref: string
  /** Repo-relative file path when recorded; also settles semantic-id collisions */
  file: string
  /** The member's role in the annotation */
  note: string
}

/** A runtime link between modules that static analysis cannot see (network, IPC, FFI, dynamic dispatch) */
export interface ModuleDependency {
  /** Slug of the module depended on */
  module: string
  /** The channel, e.g. "GraphQL over WebSocket" */
  via: string
}

/** Present on annotations that act as a block in the module map */
export interface ModuleSpec {
  /** Path globs relative to the repo root; a leading `!` excludes */
  paths: string[]
  /** One lane id, or the first and last lane of a contiguous span */
  lanes: string[]
  /** Pinned layer when the map has no tiers; absent means computed from dependencies */
  layer?: number
  /** Tier id when the map has tiers; absent means placed with its highest dependency */
  tier?: string
  dependsOn: ModuleDependency[]
}

export interface Annotation {
  /** Slug: the file name stem; empty until saved */
  id: string
  shape: AnnotationShape
  kind: string
  status: AnnotationStatus
  label: string
  description: string
  /** True for paths and flows, where member order carries meaning */
  ordered: boolean
  members: AnnotationMember[]
  /** Set on an agent's proposal */
  author?: 'human' | 'agent'
  reasoning?: string | null
  module?: ModuleSpec
}

/** The rendering shape: ordered members draw a path, several a region, one a point */
export function deriveShape(ordered: boolean, memberCount: number): AnnotationShape {
  if (ordered) return 'polyline'
  if (memberCount > 1) return 'region'
  return 'point'
}
