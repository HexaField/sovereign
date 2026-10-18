// Test fixtures for the diff tests (not exported from the package).
import type { GraphEdge, GraphNode } from '../graph.js'

export function makeNode(
  id: string,
  name: string,
  kind: GraphNode['kind'] = 'function',
  filePath = 'src/a.ts',
  extra: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...extra
  }
}

export function makeEdge(source: string, target: string, kind: GraphEdge['kind'] = 'calls'): GraphEdge {
  return { source, target, kind }
}
