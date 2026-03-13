// Planning Module — Graph Engine

import type {
  IssueSnapshot,
  DependencyEdge,
  GraphBuildResult,
  GraphEngine,
  EntityRef,
  CriticalPath,
  GraphQueryResult,
  GraphFilter,
  GraphNode,
  CycleError
} from './types.js'

function refKey(ref: EntityRef): string {
  return `${ref.remote}:${ref.orgId}/${ref.projectId}#${ref.issueId}`
}

export function createGraph(issues: IssueSnapshot[], edges: DependencyEdge[]): GraphBuildResult {
  // Internal state
  let nodes = new Map<string, GraphNode>()
  let allEdges: DependencyEdge[] = []

  function buildInternal(iss: IssueSnapshot[], edg: DependencyEdge[]): CycleError[] {
    nodes = new Map()
    allEdges = [...edg]

    // Create nodes from issues
    for (const issue of iss) {
      const key = refKey(issue.ref)
      nodes.set(key, {
        ref: issue.ref,
        state: issue.state,
        labels: issue.labels,
        milestone: issue.milestone,
        assignees: issue.assignees,
        dependencies: [],
        dependents: []
      })
    }

    // Build adjacency from edges
    // Edge semantics: depends_on means from depends on to; blocks means from depends on to (already normalized by parser)
    for (const edge of allEdges) {
      let fromKey: string, toKey: string
      if (edge.type === 'depends_on') {
        // from depends on to → from has dependency on to, to has dependent from
        fromKey = refKey(edge.from)
        toKey = refKey(edge.to)
      } else {
        // blocks: from depends on to (parser sets from=referenced, to=this)
        // Actually re-read parser: blocks → from=referenced issue, to=this issue context
        // "This blocks #8" → from=#8, to=this → #8 depends on this
        // So from depends on to
        fromKey = refKey(edge.from)
        toKey = refKey(edge.to)
      }

      const fromNode = nodes.get(fromKey)
      const toNode = nodes.get(toKey)
      if (fromNode && toNode) {
        fromNode.dependencies.push(toNode.ref)
        toNode.dependents.push(fromNode.ref)
      }
    }

    return detectCycles()
  }

  function detectCycles(): CycleError[] {
    const cycles: CycleError[] = []
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2
    const color = new Map<string, number>()
    const parent = new Map<string, string | null>()

    for (const key of nodes.keys()) {
      color.set(key, WHITE)
    }

    function dfs(key: string): void {
      color.set(key, GRAY)
      const node = nodes.get(key)!
      // Follow dependency direction: node depends on these
      for (const dep of node.dependencies) {
        const depKey = refKey(dep)
        const c = color.get(depKey)
        if (c === GRAY) {
          // Found cycle - trace back
          const cycle: EntityRef[] = [dep]
          let cur = key
          while (cur !== depKey) {
            cycle.push(nodes.get(cur)!.ref)
            cur = parent.get(cur) ?? depKey
          }
          cycle.reverse()
          cycles.push({
            cycle,
            message: `Cycle detected: ${cycle.map((r) => `${r.projectId}#${r.issueId}`).join(' → ')}`
          })
        } else if (c === WHITE) {
          parent.set(depKey, key)
          dfs(depKey)
        }
      }
      color.set(key, BLACK)
    }

    for (const key of nodes.keys()) {
      if (color.get(key) === WHITE) {
        parent.set(key, null)
        dfs(key)
      }
    }

    return cycles
  }

  const engine: GraphEngine = {
    build(iss: IssueSnapshot[], edg: DependencyEdge[]): GraphBuildResult {
      const errors = buildInternal(iss, edg)
      return { graph: engine, errors }
    },

    update(issueRef: EntityRef, newEdges: DependencyEdge[]): void {
      const key = refKey(issueRef)
      // Remove old edges involving this issue as source
      allEdges = allEdges.filter((e) => {
        if (e.type === 'depends_on') return refKey(e.from) !== key
        return refKey(e.from) !== key && refKey(e.to) !== key
      })
      allEdges.push(...newEdges)

      // Rebuild adjacency
      for (const [, node] of nodes) {
        node.dependencies = []
        node.dependents = []
      }
      for (const edge of allEdges) {
        const fromKey = refKey(edge.from)
        const toKey = refKey(edge.to)
        const fromNode = nodes.get(fromKey)
        const toNode = nodes.get(toKey)
        if (fromNode && toNode) {
          fromNode.dependencies.push(toNode.ref)
          toNode.dependents.push(fromNode.ref)
        }
      }
    },

    topologicalOrder(): EntityRef[] {
      // Kahn's algorithm
      const inDegree = new Map<string, number>()
      for (const key of nodes.keys()) inDegree.set(key, 0)

      for (const [key, node] of nodes) {
        inDegree.set(key, node.dependencies.length)
      }

      const queue: string[] = []
      for (const [key, deg] of inDegree) {
        if (deg === 0) queue.push(key)
      }

      const result: EntityRef[] = []
      while (queue.length > 0) {
        const key = queue.shift()!
        const node = nodes.get(key)!
        result.push(node.ref)

        // For each node that depends on this one
        for (const dependent of node.dependents) {
          const depKey = refKey(dependent)
          const newDeg = (inDegree.get(depKey) ?? 0) - 1
          inDegree.set(depKey, newDeg)
          if (newDeg === 0) queue.push(depKey)
        }
      }

      return result
    },

    criticalPath(target?: EntityRef): CriticalPath {
      // Longest path in DAG by node count
      const topo = engine.topologicalOrder()
      if (topo.length === 0) return { path: [], length: 0 }

      const dist = new Map<string, number>()
      const prev = new Map<string, string | null>()

      for (const ref of topo) {
        dist.set(refKey(ref), 1)
        prev.set(refKey(ref), null)
      }

      // Process in topo order
      for (const ref of topo) {
        const key = refKey(ref)
        const node = nodes.get(key)!
        const curDist = dist.get(key)!

        for (const dependent of node.dependents) {
          const depKey = refKey(dependent)
          if (curDist + 1 > (dist.get(depKey) ?? 0)) {
            dist.set(depKey, curDist + 1)
            prev.set(depKey, key)
          }
        }
      }

      let endKey: string
      if (target) {
        endKey = refKey(target)
      } else {
        // Find node with longest distance
        let maxDist = 0
        endKey = refKey(topo[0]!)
        for (const [key, d] of dist) {
          if (d > maxDist) {
            maxDist = d
            endKey = key
          }
        }
      }

      // Trace back
      const path: EntityRef[] = []
      let cur: string | null = endKey
      while (cur !== null) {
        path.push(nodes.get(cur)!.ref)
        cur = prev.get(cur) ?? null
      }
      path.reverse()

      return { path, length: path.length }
    },

    blocked(): EntityRef[] {
      const result: EntityRef[] = []
      for (const [, node] of nodes) {
        if (node.state !== 'open') continue
        const hasOpenDep = node.dependencies.some((dep) => {
          const depNode = nodes.get(refKey(dep))
          return depNode && depNode.state === 'open'
        })
        if (hasOpenDep) result.push(node.ref)
      }
      return result
    },

    ready(): EntityRef[] {
      const result: EntityRef[] = []
      for (const [, node] of nodes) {
        if (node.state !== 'open') continue
        const allDepsClosed = node.dependencies.every((dep) => {
          const depNode = nodes.get(refKey(dep))
          return depNode && depNode.state === 'closed'
        })
        // Also consider nodes with no dependencies as ready
        if (allDepsClosed) result.push(node.ref)
      }
      return result
    },

    parallelSets(): EntityRef[][] {
      // Group by topological level
      const level = new Map<string, number>()
      const topo = engine.topologicalOrder()

      for (const ref of topo) {
        const key = refKey(ref)
        const node = nodes.get(key)!
        let maxDepLevel = -1
        for (const dep of node.dependencies) {
          const depLevel = level.get(refKey(dep)) ?? 0
          if (depLevel > maxDepLevel) maxDepLevel = depLevel
        }
        level.set(key, maxDepLevel + 1)
      }

      const groups = new Map<number, EntityRef[]>()
      for (const ref of topo) {
        const l = level.get(refKey(ref)) ?? 0
        if (!groups.has(l)) groups.set(l, [])
        groups.get(l)!.push(ref)
      }

      return Array.from(groups.entries())
        .sort(([a], [b]) => a - b)
        .map(([, refs]) => refs)
    },

    impact(node: EntityRef): EntityRef[] {
      // All transitive dependents (downstream)
      const visited = new Set<string>()
      const result: EntityRef[] = []

      function dfs(key: string): void {
        const n = nodes.get(key)
        if (!n) return
        for (const dep of n.dependents) {
          const dk = refKey(dep)
          if (!visited.has(dk)) {
            visited.add(dk)
            result.push(dep)
            dfs(dk)
          }
        }
      }

      dfs(refKey(node))
      return result
    },

    ancestors(node: EntityRef): EntityRef[] {
      // All transitive dependencies (upstream)
      const visited = new Set<string>()
      const result: EntityRef[] = []

      function dfs(key: string): void {
        const n = nodes.get(key)
        if (!n) return
        for (const dep of n.dependencies) {
          const dk = refKey(dep)
          if (!visited.has(dk)) {
            visited.add(dk)
            result.push(dep)
            dfs(dk)
          }
        }
      }

      dfs(refKey(node))
      return result
    },

    subgraph(filter: GraphFilter): GraphQueryResult {
      const filteredNodes: GraphNode[] = []
      const filteredKeys = new Set<string>()

      for (const [key, node] of nodes) {
        let include = true
        if (filter.projectId && node.ref.projectId !== filter.projectId) include = false
        if (filter.remote && node.ref.remote !== filter.remote) include = false
        if (filter.label && !node.labels.includes(filter.label)) include = false
        if (filter.milestone && node.milestone !== filter.milestone) include = false
        if (filter.assignee && !node.assignees.includes(filter.assignee)) include = false
        if (include) {
          filteredNodes.push(node)
          filteredKeys.add(key)
        }
      }

      const filteredEdges = allEdges.filter((e) => {
        const fk = refKey(e.from)
        const tk = refKey(e.to)
        return filteredKeys.has(fk) && filteredKeys.has(tk)
      })

      return { nodes: filteredNodes, edges: filteredEdges }
    },

    completionRate(filter?: GraphFilter) {
      let targetNodes: GraphNode[]
      if (filter) {
        targetNodes = engine.subgraph(filter).nodes
      } else {
        targetNodes = Array.from(nodes.values())
      }
      const total = targetNodes.length
      const closed = targetNodes.filter((n) => n.state === 'closed').length
      return {
        total,
        closed,
        percentage: total === 0 ? 0 : Math.round((closed / total) * 100)
      }
    }
  }

  const errors = buildInternal(issues, edges)
  return { graph: engine, errors }
}
