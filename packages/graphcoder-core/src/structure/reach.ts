// Reach: how far a change spreads through the code (the design's "diameter").

import type { GraphEdge, GraphNode } from '../graph.js'
import type { EdgeHygiene } from '../hygiene.js'

export interface ChangeReach {
  /** The widest piece's diameter; 0 for one symbol or none */
  reach: number
  /** Connected pieces the changed symbols fall into; 0 for none */
  parts: number
}

/**
 * The diameter of a set of changed symbols: the longest of the shortest paths between two of them.
 *
 * The graph is undirected, over every node of the snapshot, with two kinds of link: containment (`contains`: a file
 * holds its symbols, a class its methods) and the dependency edges edge hygiene trusts (`calls`, `instantiates`,
 * `references`, … that are no guess, no test code, no undeclared package), except `imports`: an import statement is
 * a file-level link whose real dependency is already a call or reference, and a barrel that re-exports a package
 * would put every pair of its symbols 2 apart. One hop per link. So two functions in one
 * file are 2 apart (through the file), a caller and its callee 1, and code in two packages as far apart as the
 * shortest chain of real dependencies between them.
 *
 * Changed symbols with no path between them fall into separate parts; `reach` is then the largest diameter of a
 * part and `parts` says how many there are. A change to one symbol, or to symbols that share no path, has reach 0.
 */
export function changeReach(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  hygiene: EdgeHygiene,
  changed: readonly string[]
): ChangeReach {
  const ids = new Map<string, number>()
  nodes.forEach((n, i) => ids.set(n.id, i))
  const adjacency: number[][] = nodes.map(() => [])
  const join = (e: GraphEdge) => {
    const a = ids.get(e.source)
    const b = ids.get(e.target)
    if (a === undefined || b === undefined || a === b) return
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  for (const e of edges) if (e.kind === 'contains') join(e)
  for (const e of hygiene.trusted(edges)) if (e.kind !== 'imports') join(e)

  const targets = [...new Set(changed.map((id) => ids.get(id)).filter((i): i is number => i !== undefined))]
  if (targets.length === 0) return { reach: 0, parts: 0 }
  const isTarget = new Set(targets)
  const part = new Map<number, number>()
  const partSize: number[] = []
  const dist = new Int32Array(nodes.length)
  let reach = 0

  for (const from of targets) {
    // Targets found so far in this part tell when a later search can stop early
    const known = part.get(from)
    const want = known === undefined ? Infinity : partSize[known] - 1
    dist.fill(-1)
    dist[from] = 0
    const queue = [from]
    let found = 0
    let far = 0
    for (let head = 0; head < queue.length && found < want; head++) {
      const u = queue[head]
      for (const v of adjacency[u]) {
        if (dist[v] !== -1) continue
        dist[v] = dist[u] + 1
        queue.push(v)
        if (isTarget.has(v)) {
          found++
          far = dist[v]
        }
      }
    }
    if (known === undefined) {
      const id = partSize.length
      partSize.push(found + 1)
      part.set(from, id)
      for (const t of targets) if (dist[t] > 0) part.set(t, id)
    }
    reach = Math.max(reach, far)
  }
  return { reach, parts: partSize.length }
}
