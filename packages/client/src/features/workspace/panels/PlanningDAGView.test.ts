import { describe, it, expect } from 'vitest'
import { buildGraphUrl, layoutGraph } from './PlanningDAGView.js'

describe('PlanningDAGView', () => {
  it('exports default component', async () => {
    const mod = await import('./PlanningDAGView.js')
    expect(mod.default).toBeDefined()
  })

  it('builds graph URL correctly', () => {
    expect(buildGraphUrl('org1')).toBe('/api/orgs/org1/planning/graph')
  })

  it('lays out nodes in topological layers', () => {
    const graph = {
      nodes: [
        {
          ref: { orgId: 'o', projectId: 'p', remote: 'r', issueId: '1' },
          state: 'open' as const,
          labels: [],
          assignees: [],
          dependencies: [],
          dependents: []
        },
        {
          ref: { orgId: 'o', projectId: 'p', remote: 'r', issueId: '2' },
          state: 'open' as const,
          labels: [],
          assignees: [],
          dependencies: [],
          dependents: []
        }
      ],
      edges: [
        {
          from: { orgId: 'o', projectId: 'p', remote: 'r', issueId: '1' },
          to: { orgId: 'o', projectId: 'p', remote: 'r', issueId: '2' },
          type: 'depends_on' as const
        }
      ]
    }
    const result = layoutGraph(graph, new Map(), new Set(), new Set())
    expect(result.positions.size).toBe(2)
    const pos1 = result.positions.get('o:p:r:1')!
    const pos2 = result.positions.get('o:p:r:2')!
    expect(pos1.x).toBeLessThan(pos2.x)
  })
})
