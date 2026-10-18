// The structural graph as the CodeGraph index stores it. These shapes mirror
// codegraph's own `Node` and `Edge` (1.5), so an index read hands them over
// without conversion; Graphcoder never needs codegraph at runtime to use them.

export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component'

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_of'
  | 'returns'
  | 'instantiates'
  | 'overrides'
  | 'decorates'

export interface GraphNode {
  /** CodeGraph id: derived from file and qualified name, so it changes on a move or rename */
  id: string
  kind: NodeKind
  name: string
  qualifiedName: string
  /** Repo-relative, `/`-separated */
  filePath: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  docstring?: string
  signature?: string
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  isExported?: boolean
  isAsync?: boolean
  isStatic?: boolean
  isAbstract?: boolean
  decorators?: string[]
  typeParameters?: string[]
  returnType?: string
  updatedAt?: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  /** Resolver detail: `confidence` (0–1), `resolvedBy` (`import`, `qualified-name`, `exact-match`, …), `refName` */
  metadata?: Record<string, unknown>
  line?: number
  column?: number
  /** `heuristic` marks an inferred edge (e.g. an HTTP bridge); everything else comes from extraction */
  provenance?: 'tree-sitter' | 'scip' | 'heuristic'
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  fileCount: number
  /** Node count per kind; kinds with no nodes are absent */
  nodesByKind: Record<string, number>
}
