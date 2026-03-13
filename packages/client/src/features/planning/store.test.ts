import { describe, it, expect, beforeEach } from 'vitest'

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => {
    store[key] = val
  },
  removeItem: (key: string) => {
    delete store[key]
  },
  clear: () => Object.keys(store).forEach((k) => delete store[k])
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import {
  viewMode,
  setViewMode,
  _setViewMode,
  filters,
  setFilters,
  setFilter,
  clearFilters,
  removeFilterValue,
  searchQuery,
  setSearchQuery,
  _resetPlanningStore,
  type PlanningViewMode
} from './store'

beforeEach(() => {
  localStorageMock.clear()
  _resetPlanningStore()
})

describe('Planning Store', () => {
  describe('§5.3 — View State', () => {
    it('§5.3 — exposes viewMode signal defaulting to dag', () => {
      expect(viewMode()).toBe('dag')
    })

    it('§5.3 — viewMode accepts dag, kanban, list, tree', () => {
      const modes: PlanningViewMode[] = ['dag', 'kanban', 'list', 'tree']
      for (const mode of modes) {
        setViewMode(mode)
        expect(viewMode()).toBe(mode)
      }
    })

    it('§5.5 — exposes filters signal as Record<string, string[]>', () => {
      expect(filters()).toEqual({})
      setFilter('workspace', ['org-1', 'org-2'])
      expect(filters().workspace).toEqual(['org-1', 'org-2'])
    })

    it('§5.5 — exposes searchQuery signal', () => {
      expect(searchQuery()).toBe('')
      setSearchQuery('fix bug')
      expect(searchQuery()).toBe('fix bug')
    })
  })

  describe('filter operations', () => {
    it('setFilter adds a filter key with values', () => {
      setFilter('status', ['open', 'blocked'])
      expect(filters().status).toEqual(['open', 'blocked'])
    })

    it('setFilter removes key when values is empty array', () => {
      setFilter('status', ['open'])
      setFilter('status', [])
      expect(filters().status).toBeUndefined()
    })

    it('removeFilterValue removes a single value from a filter', () => {
      setFilter('workspace', ['a', 'b', 'c'])
      removeFilterValue('workspace', 'b')
      expect(filters().workspace).toEqual(['a', 'c'])
    })

    it('removeFilterValue removes key when last value is removed', () => {
      setFilter('priority', ['high'])
      removeFilterValue('priority', 'high')
      expect(filters().priority).toBeUndefined()
    })

    it('clearFilters resets filters and searchQuery', () => {
      setFilter('workspace', ['org-1'])
      setSearchQuery('test')
      clearFilters()
      expect(filters()).toEqual({})
      expect(searchQuery()).toBe('')
    })
  })

  describe('localStorage persistence', () => {
    it('setViewMode persists to localStorage', () => {
      setViewMode('kanban')
      expect(store['sovereign:planning-view-mode']).toBe('kanban')
    })

    it('setFilters persists to localStorage', () => {
      setFilter('workspace', ['org-1'])
      const parsed = JSON.parse(store['sovereign:planning-filters'])
      expect(parsed.workspace).toEqual(['org-1'])
    })
  })
})
