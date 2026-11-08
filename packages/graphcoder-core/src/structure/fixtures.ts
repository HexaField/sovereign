// Test fixtures for the structure tests (not exported from the package).
import type { GraphEdge, GraphNode } from '../graph.js'
import type { ChangedFile, Hunk } from '../ports.js'

/** A node with its id derived from file, kind and name (pass `extra.id` when two would collide) */
export function sym(
  kind: GraphNode['kind'],
  name: string,
  filePath: string,
  lines: [number, number] = [1, 1],
  extra: Partial<GraphNode> = {}
): GraphNode {
  return {
    id: `${filePath}#${kind}:${name}@${lines[0]}`,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: filePath.endsWith('.rs') ? 'rust' : 'typescript',
    startLine: lines[0],
    endLine: lines[1],
    startColumn: 0,
    endColumn: 0,
    ...extra
  }
}

export function fileNode(path: string, lines = 100): GraphNode {
  return sym('file', path.split('/').pop()!, path, [1, lines], { id: `file:${path}`, qualifiedName: path })
}

export function link(
  source: GraphNode,
  target: GraphNode,
  kind: GraphEdge['kind'] = 'calls',
  extra: Partial<GraphEdge> = {}
): GraphEdge {
  return {
    source: source.id,
    target: target.id,
    kind,
    metadata: kind === 'contains' ? {} : { confidence: 0.95, resolvedBy: 'import' },
    ...extra
  }
}

/** `[baseStart, baseLines, headStart, headLines]` per hunk */
export function changed(
  path: string,
  hunks: Array<[number, number, number, number]>,
  extra: Partial<ChangedFile> = {}
): ChangedFile {
  return {
    path,
    status: 'modified',
    hunks: hunks.map(
      ([baseStart, baseLines, headStart, headLines]): Hunk => ({
        baseStart,
        baseLines,
        headStart,
        headLines
      })
    ),
    ...extra
  }
}
