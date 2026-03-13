// Planning Module — Graph Engine

import type {
  IssueSnapshot,
  DependencyEdge,
  GraphBuildResult,
  GraphEngine,
  EntityRef,
  CriticalPath,
  GraphQueryResult
} from './types.js'

export function createGraph(_issues: IssueSnapshot[], _edges: DependencyEdge[]): GraphBuildResult {
  const engine: GraphEngine = {
    build(_issues, _edges) {
      return { graph: engine, errors: [] }
    },
    update(_issueId, _newEdges) {},
    topologicalOrder() {
      return []
    },
    criticalPath(_target?: EntityRef): CriticalPath {
      return { path: [], length: 0 }
    },
    blocked() {
      return []
    },
    ready() {
      return []
    },
    parallelSets() {
      return []
    },
    impact(_node) {
      return []
    },
    ancestors(_node) {
      return []
    },
    subgraph(_filter): GraphQueryResult {
      return { nodes: [], edges: [] }
    },
    completionRate(_filter?) {
      return { total: 0, closed: 0, percentage: 0 }
    }
  }

  return { graph: engine, errors: [] }
}
