// ── Forest types ────────────────────────────────────────────────────

export interface Vec3 {
  x: number
  y: number
  z: number
}

// ── Data ────────────────────────────────────────────────────────────

export interface ForestNode {
  iri: string
  kind: 'entity' | 'note'
  name: string
  entityType: string
  tags: string[]
  content: string
  timestamp: number
  embedding: number[]
}

export interface ForestLink {
  source: string
  target: string
  predicate: string
}

/** Pre-computed index returned by /api/forest/index */
export interface ForestIndex {
  nodes: ForestNode[]
  links: ForestLink[]
  /** N×embeddingDim basis vectors for semantic projection (row-major) */
  pcaBasis: number[][] | null
  /** Embedding-dim mean vector for centering */
  pcaMean: number[] | null
  /** Embedding dimensionality */
  embeddingDim: number
  /** Timestamp when the index got built */
  buildTime: number
}

// ── Projection ──────────────────────────────────────────────────────

export interface ProjectionContext {
  pcaBasis: number[][] | null
  pcaMean: number[] | null
  dimensions: [number, number, number]
  allNodes: ForestNode[]
}

export interface ProjectionStrategy {
  id: string
  label: string
  project(node: ForestNode, context: ProjectionContext): Vec3
  axes?: { x: string; y: string; z: string }
  /** How many high-dim axes the strategy exposes (for dim selector) */
  dimensionCount?: number
}

// ── Settings ────────────────────────────────────────────────────────

export type EasingId = 'linear' | 'easeOut' | 'easeInOut' | 'spring'
export type SizeMapping = 'uniform' | 'byLinks' | 'byAge' | 'byType'
export type ColorMapping = 'byType' | 'byTag' | 'byAge' | 'byCluster'
export type NodeShape = 'sphere' | 'octahedron'
export type LabelVisibility = 'always' | 'hover' | 'selected' | 'never'
export type LinkVisibility = 'all' | 'selected-neighborhood' | 'hover' | 'none'
export type LinkStyle = 'line' | 'arc'
export type LinkColorMapping = 'byPredicate' | 'uniform'

export interface ForestSettings {
  transition: {
    duration: number
    easing: EasingId
  }
  node: {
    size: number
    sizeMapping: SizeMapping
    shape: NodeShape
    colorMapping: ColorMapping
    opacity: number
    labelVisibility: LabelVisibility
  }
  link: {
    visibility: LinkVisibility
    style: LinkStyle
    colorMapping: LinkColorMapping
    opacity: number
    width: number
  }
  projection: {
    strategy: 'semantic' | 'ontological' | 'hash'
    dimensions: [number, number, number]
  }
  styles: {
    graph: boolean
    cloud: boolean
  }
}

export interface ForestFilter {
  types: string[]
  tags: string[]
  search: string
  predicates: string[]
  timeRange: [number, number] | null
}
