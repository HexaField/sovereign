import { describe, it } from 'vitest'

describe('Graph Engine', () => {
  describe('1.2 Graph Construction', () => {
    it.todo('MUST build a directed acyclic graph from issues and dependency edges')
    it.todo('MUST reference provider issues by EntityRef without duplicating issue data')
    it.todo('MUST detect cycles and report them as errors with the cycle path')
    it.todo('MUST NOT silently ignore cycles')
    it.todo('MUST support incremental updates — reparse single issue without full rebuild')
    it.todo('MUST be a pure computation module — no I/O, no bus, no persistence')
  })

  describe('1.3 Graph Queries', () => {
    it.todo('MUST compute topological order respecting all dependencies')
    it.todo('MUST compute critical path — longest dependency chain to target node')
    it.todo('MUST compute critical path to any leaf node if no target specified')
    it.todo('MUST define critical path by number of nodes, not effort estimation')
    it.todo('MUST compute blocked nodes — nodes with at least one open dependency')
    it.todo('MUST compute ready nodes — open nodes with all dependencies resolved')
    it.todo('MUST compute parallel sets — groups with no inter-dependencies')
    it.todo('MUST compute impact analysis — all transitive dependents of a node')
    it.todo('MUST compute ancestors — all transitive dependencies of a node')
    it.todo('MUST support subgraph extraction with filter criteria (project, label, milestone, assignee)')
    it.todo('MUST support cross-project graphs spanning multiple projects within an org')
    it.todo('SHOULD compute completion percentage — ratio of closed to total in a subgraph')
  })
})
