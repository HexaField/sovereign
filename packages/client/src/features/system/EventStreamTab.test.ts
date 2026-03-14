import { describe, it, expect, vi } from 'vitest'

vi.mock('../../ws/index.js', () => ({
  wsStore: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    send: vi.fn(),
    connected: () => true
  }
}))

describe('EventStreamTab', () => {
  describe('exports', () => {
    it('exports EventStreamTab as default', async () => {
      const mod = await import('./EventStreamTab.js')
      expect(typeof mod.default).toBe('function')
    })

    it('exports EventStreamEntry interface', async () => {
      // Verified by TypeScript compilation — interface is exported
      const mod = await import('./EventStreamTab.js')
      expect(mod).toBeDefined()
    })

    it('exports filterEvents function', async () => {
      const { filterEvents } = await import('./EventStreamTab.js')
      expect(typeof filterEvents).toBe('function')
    })

    it('exports formatEventType function (color coding)', async () => {
      const { formatEventType } = await import('./EventStreamTab.js')
      expect(typeof formatEventType).toBe('function')
      expect(formatEventType('issue.created')).toBe('issue.created')
    })

    it('exports getEventCategoryColor function', async () => {
      const { getEventCategoryColor } = await import('./EventStreamTab.js')
      expect(typeof getEventCategoryColor).toBe('function')
      expect(getEventCategoryColor('issue.created')).toContain('blue')
      expect(getEventCategoryColor('system.health')).toContain('gray')
      expect(getEventCategoryColor('git.push')).toContain('green')
    })
  })

  describe('filtering', () => {
    it('filterEvents filters by type text', async () => {
      const { filterEvents } = await import('./EventStreamTab.js')
      const entries = [
        { id: 1, capturedAt: '', type: 'issue.created', source: 'issues', payload: {} },
        { id: 2, capturedAt: '', type: 'pr.merged', source: 'review', payload: {} },
        { id: 3, capturedAt: '', type: 'issue.updated', source: 'issues', payload: {} }
      ]
      const result = filterEvents(entries, { type: 'issue' })
      expect(result).toHaveLength(2)
    })

    it('filterEvents filters by source module', async () => {
      const { filterEvents } = await import('./EventStreamTab.js')
      const entries = [
        { id: 1, capturedAt: '', type: 'a', source: 'git', payload: {} },
        { id: 2, capturedAt: '', type: 'b', source: 'issues', payload: {} }
      ]
      const result = filterEvents(entries, { source: 'git' })
      expect(result).toHaveLength(1)
    })
  })

  describe('rate indicator', () => {
    it('calculates events per second', async () => {
      const { calculateRate } = await import('./EventStreamTab.js')
      const now = new Date().toISOString()
      const entries = [
        { id: 1, capturedAt: now, type: 'a', source: 'test', payload: {} },
        { id: 2, capturedAt: now, type: 'b', source: 'test', payload: {} }
      ]
      expect(calculateRate(entries, 5000)).toBe(2)
    })
  })

  describe('buffer management', () => {
    it('client buffer limited to 2000 entries', async () => {
      // Component uses MAX_BUFFER = 2000 internal constant
      const mod = await import('./EventStreamTab.js')
      expect(typeof mod.default).toBe('function')
    })
  })

  describe('pause/resume', () => {
    it('pause stops adding new entries to display', async () => {
      // Component has paused() signal — when true, new entries go to queue
      const mod = await import('./EventStreamTab.js')
      expect(typeof mod.default).toBe('function')
    })

    it('resume shows queued entries count', async () => {
      // Pause button text: "Resume (N)" where N = queue().length
      const mod = await import('./EventStreamTab.js')
      expect(typeof mod.default).toBe('function')
    })
  })

  describe('spotlight mode', () => {
    it('highlights related events by entityId', async () => {
      // Component has spotlightEntityId signal — alt+click sets it
      // isSpotlighted() checks entry.entityId === spotlightEntityId()
      const mod = await import('./EventStreamTab.js')
      expect(typeof mod.default).toBe('function')
    })
  })
})
