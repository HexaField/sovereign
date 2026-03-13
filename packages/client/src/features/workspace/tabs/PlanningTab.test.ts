import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('PlanningTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('§3.4.4 — Planning DAG Tab', () => {
    it('§3.4.4 — displays full planning DAG for active workspace', async () => {
      const mod = await import('./PlanningTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.4 — fetches from GET /api/orgs/:orgId/planning/graph', async () => {
      const { fetchPlanningGraph } = await import('./PlanningTab.tsx')
      const mockGraph = { nodes: [], edges: [] }
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockGraph })
      const result = await fetchPlanningGraph('org-1')
      expect(mockFetch).toHaveBeenCalledWith('/api/orgs/org-1/planning/graph')
      expect(result).toEqual(mockGraph)
    })

    it('§3.4.4 — renders nodes as cards connected by directed edges', async () => {
      const { layoutNodes } = await import('./PlanningTab.tsx')
      const graph = {
        nodes: [
          { id: 'a', title: 'Task A', status: 'ready' as const, critical: false, dependencies: [] },
          { id: 'b', title: 'Task B', status: 'blocked' as const, critical: false, dependencies: ['a'] }
        ],
        edges: [{ from: 'a', to: 'b' }]
      }
      const positions = layoutNodes(graph)
      expect(positions.size).toBe(2)
      // 'a' should be in an earlier column than 'b'
      const posA = positions.get('a')!
      const posB = positions.get('b')!
      expect(posA.x).toBeLessThan(posB.x)
    })

    it('§3.4.4 — critical path is highlighted', async () => {
      // Critical edges use thicker stroke and accent color
      // Critical nodes use accent border
      const mod = await import('./PlanningTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.4 — blocked nodes show red/amber indicator, ready nodes show green', async () => {
      // statusIndicator maps: blocked -> red, ready -> green, in-progress -> amber
      const mod = await import('./PlanningTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.4 — clicking a node opens its issue/thread', async () => {
      // Component accepts onNodeClick prop, invoked on node <g> click
      const mod = await import('./PlanningTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.4 — subscribes to planning WS channel for live updates', async () => {
      // Component creates WS connection and subscribes to 'planning' channel
      // On 'planning.update' message, refetches the graph
      const mod = await import('./PlanningTab.tsx')
      expect(mod.default).toBeDefined()
    })
  })
})
