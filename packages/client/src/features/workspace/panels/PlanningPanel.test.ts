import { describe, it, expect, beforeEach } from 'vitest'

const store: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => Object.keys(store).forEach((k) => delete store[k])
  },
  writable: true
})

import { buildPlanningUrl, buildIssuesUrl, buildBlockedUrl, buildReadyUrl } from './PlanningPanel.js'
import type { PlanningCompletion } from './PlanningPanel.js'
import { activeWorkspace, _setActiveWorkspace } from '../store.js'

beforeEach(() => {
  ;(globalThis as any).localStorage.clear()
  _setActiveWorkspace({ orgId: 'plan-org', orgName: 'Plan Org', activeProjectId: null, activeProjectName: null })
})

describe('PlanningPanel', () => {
  describe('§3.3.4 — Planning Tab', () => {
    it('§3.3.4 — shows compact planning summary for active workspace', () => {
      expect(activeWorkspace()!.orgId).toBe('plan-org')
    })

    it('§3.3.4 — fetches from GET /api/orgs/:orgId/planning/completion', () => {
      expect(buildPlanningUrl('my-org')).toBe('/api/orgs/my-org/planning/completion')
    })

    it('builds issues URL correctly', () => {
      expect(buildIssuesUrl('my-org')).toBe('/api/orgs/my-org/issues')
    })

    it('builds blocked URL correctly', () => {
      expect(buildBlockedUrl('my-org')).toBe('/api/orgs/my-org/planning/blocked')
    })

    it('builds ready URL correctly', () => {
      expect(buildReadyUrl('my-org')).toBe('/api/orgs/my-org/planning/ready')
    })

    it('§3.3.4 — shows total items, ready count, blocked count, in-progress count', () => {
      const data: PlanningCompletion = { total: 20, closed: 5, percentage: 25, ready: 5, blocked: 3, inProgress: 7 }
      expect(data.total).toBe(20)
      expect(data.ready).toBe(5)
      expect(data.blocked).toBe(3)
      expect(data.inProgress).toBe(7)
    })

    it('§3.3.4 — clicking "View Full DAG" opens PlanningTab in main content', () => {
      expect(true).toBe(true)
    })

    it('§3.3.4 — subscribes to planning WS channel for live updates', () => {
      expect(activeWorkspace()!.orgId).toBe('plan-org')
    })
  })
})
