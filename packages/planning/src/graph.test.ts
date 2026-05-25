import { describe, it, expect } from 'vitest'
import { createGraph } from './graph.js'
import type { IssueSnapshot, DependencyEdge, EntityRef } from './types.js'

function makeRef(id: string, project = 'proj', org = 'org', remote = 'github'): EntityRef {
  return { orgId: org, projectId: project, remote, issueId: id }
}

function makeSnapshot(id: string, state: 'open' | 'closed' = 'open', opts: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    ref: makeRef(id),
    state,
    labels: opts.labels ?? [],
    milestone: opts.milestone,
    assignees: opts.assignees ?? [],
    body: opts.body ?? '',
    bodyHash: opts.bodyHash ?? 'hash'
  }
}

function makeEdge(fromId: string, toId: string, type: 'depends_on' | 'blocks' = 'depends_on'): DependencyEdge {
  return { from: makeRef(fromId), to: makeRef(toId), type, source: 'body' }
}

describe('Graph Engine', () => {
  describe('1.2 Graph Construction', () => {
    it('MUST build a directed acyclic graph from issues and dependency edges', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('2', '1'), makeEdge('3', '2')]
      const { graph, errors } = createGraph(issues, edges)
      expect(errors).toHaveLength(0)
      const topo = graph.topologicalOrder()
      expect(topo).toHaveLength(3)
    })

    it('MUST reference provider issues by EntityRef without duplicating issue data', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2')]
      const edges = [makeEdge('2', '1')]
      const { graph } = createGraph(issues, edges)
      const topo = graph.topologicalOrder()
      expect(topo[0]).toHaveProperty('orgId')
      expect(topo[0]).toHaveProperty('issueId')
    })

    it('MUST detect cycles and report them as errors with the cycle path', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2')]
      const edges = [makeEdge('1', '2'), makeEdge('2', '1')]
      const { errors } = createGraph(issues, edges)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]!.cycle.length).toBeGreaterThanOrEqual(2)
      expect(errors[0]!.message).toBeTruthy()
    })

    it('MUST NOT silently ignore cycles', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('1', '2'), makeEdge('2', '3'), makeEdge('3', '1')]
      const { errors } = createGraph(issues, edges)
      expect(errors.length).toBeGreaterThan(0)
    })

    it('MUST support incremental updates — reparse single issue without full rebuild', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('2', '1')]
      const { graph } = createGraph(issues, edges)

      // Update: issue 3 now depends on issue 2
      graph.update(makeRef('3'), [makeEdge('3', '2')])
      const topo = graph.topologicalOrder()
      expect(topo).toHaveLength(3)
      // 1 first, then 2, then 3
      const ids = topo.map((r) => r.issueId)
      expect(ids.indexOf('1')).toBeLessThan(ids.indexOf('2'))
      expect(ids.indexOf('2')).toBeLessThan(ids.indexOf('3'))
    })

    it('MUST be a pure computation module — no I/O, no bus, no persistence', () => {
      // createGraph is a pure function taking data and returning computed results
      const { graph } = createGraph([], [])
      expect(typeof graph.topologicalOrder).toBe('function')
      expect(typeof graph.blocked).toBe('function')
      expect(typeof graph.ready).toBe('function')
    })
  })

  describe('1.3 Graph Queries', () => {
    it('MUST compute topological order respecting all dependencies', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      // 3 depends on 2, 2 depends on 1
      const edges = [makeEdge('3', '2'), makeEdge('2', '1')]
      const { graph } = createGraph(issues, edges)
      const topo = graph.topologicalOrder()
      const ids = topo.map((r) => r.issueId)
      expect(ids.indexOf('1')).toBeLessThan(ids.indexOf('2'))
      expect(ids.indexOf('2')).toBeLessThan(ids.indexOf('3'))
    })

    it('MUST compute critical path — longest dependency chain to target node', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3'), makeSnapshot('4')]
      // 3→2→1 (length 3), 4→1 (length 2)
      const edges = [makeEdge('3', '2'), makeEdge('2', '1'), makeEdge('4', '1')]
      const { graph } = createGraph(issues, edges)
      const cp = graph.criticalPath(makeRef('3'))
      expect(cp.length).toBe(3)
      expect(cp.path.map((r) => r.issueId)).toEqual(['1', '2', '3'])
    })

    it('MUST compute critical path to any leaf node if no target specified', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('3', '2'), makeEdge('2', '1')]
      const { graph } = createGraph(issues, edges)
      const cp = graph.criticalPath()
      expect(cp.length).toBe(3)
    })

    it('MUST define critical path by number of nodes, not effort estimation', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2')]
      const edges = [makeEdge('2', '1')]
      const { graph } = createGraph(issues, edges)
      const cp = graph.criticalPath()
      expect(cp.length).toBe(2) // 2 nodes
    })

    it('MUST compute blocked nodes — nodes with at least one open dependency', () => {
      const issues = [makeSnapshot('1', 'open'), makeSnapshot('2', 'open')]
      const edges = [makeEdge('2', '1')] // 2 depends on 1
      const { graph } = createGraph(issues, edges)
      const blocked = graph.blocked()
      expect(blocked.map((r) => r.issueId)).toContain('2')
      expect(blocked.map((r) => r.issueId)).not.toContain('1')
    })

    it('MUST compute ready nodes — open nodes with all dependencies resolved', () => {
      const issues = [makeSnapshot('1', 'closed'), makeSnapshot('2', 'open'), makeSnapshot('3', 'open')]
      const edges = [makeEdge('2', '1'), makeEdge('3', '2')] // 2→1, 3→2
      const { graph } = createGraph(issues, edges)
      const ready = graph.ready()
      const readyIds = ready.map((r) => r.issueId)
      expect(readyIds).toContain('2') // dep 1 is closed
      expect(readyIds).not.toContain('3') // dep 2 is open
    })

    it('MUST compute parallel sets — groups with no inter-dependencies', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3'), makeSnapshot('4')]
      // 3→1, 4→2 — 3 and 4 are parallel, 1 and 2 are parallel
      const edges = [makeEdge('3', '1'), makeEdge('4', '2')]
      const { graph } = createGraph(issues, edges)
      const sets = graph.parallelSets()
      expect(sets.length).toBe(2)
      // Level 0: 1 and 2, Level 1: 3 and 4
      expect(sets[0]!.length).toBe(2)
      expect(sets[1]!.length).toBe(2)
    })

    it('MUST compute impact analysis — all transitive dependents of a node', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('2', '1'), makeEdge('3', '2')]
      const { graph } = createGraph(issues, edges)
      const impacted = graph.impact(makeRef('1'))
      const ids = impacted.map((r) => r.issueId)
      expect(ids).toContain('2')
      expect(ids).toContain('3')
    })

    it('MUST compute ancestors — all transitive dependencies of a node', () => {
      const issues = [makeSnapshot('1'), makeSnapshot('2'), makeSnapshot('3')]
      const edges = [makeEdge('2', '1'), makeEdge('3', '2')]
      const { graph } = createGraph(issues, edges)
      const anc = graph.ancestors(makeRef('3'))
      const ids = anc.map((r) => r.issueId)
      expect(ids).toContain('2')
      expect(ids).toContain('1')
    })

    it('MUST support subgraph extraction with filter criteria (project, label, milestone, assignee)', () => {
      const issues = [
        makeSnapshot('1', 'open', { labels: ['bug'], milestone: 'v1' }),
        makeSnapshot('2', 'open', { labels: ['feature'], milestone: 'v2' }),
        makeSnapshot('3', 'open', { labels: ['bug'], milestone: 'v1' })
      ]
      const edges = [makeEdge('3', '1')]
      const { graph } = createGraph(issues, edges)
      const sub = graph.subgraph({ label: 'bug' })
      expect(sub.nodes).toHaveLength(2)
      expect(sub.edges).toHaveLength(1)
    })

    it('MUST support cross-project graphs spanning multiple projects within an org', () => {
      const i1: IssueSnapshot = {
        ref: makeRef('1', 'projA'),
        state: 'open',
        labels: [],
        assignees: [],
        body: '',
        bodyHash: 'h'
      }
      const i2: IssueSnapshot = {
        ref: makeRef('2', 'projB'),
        state: 'open',
        labels: [],
        assignees: [],
        body: '',
        bodyHash: 'h'
      }
      const edge: DependencyEdge = {
        from: makeRef('2', 'projB'),
        to: makeRef('1', 'projA'),
        type: 'depends_on',
        source: 'body'
      }
      const { graph, errors } = createGraph([i1, i2], [edge])
      expect(errors).toHaveLength(0)
      const topo = graph.topologicalOrder()
      expect(topo).toHaveLength(2)
    })

    it('SHOULD compute completion percentage — ratio of closed to total in a subgraph', () => {
      const issues = [makeSnapshot('1', 'closed'), makeSnapshot('2', 'open'), makeSnapshot('3', 'closed')]
      const { graph } = createGraph(issues, [])
      const rate = graph.completionRate()
      expect(rate.total).toBe(3)
      expect(rate.closed).toBe(2)
      expect(rate.percentage).toBe(67)
    })
  })
})
