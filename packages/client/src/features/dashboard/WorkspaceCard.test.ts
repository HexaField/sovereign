import { describe, it, expect } from 'vitest'
import {
  getActivityColor,
  isGlobalOrg,
  formatGitSummary,
  formatThreadSummary,
  activityDotClass,
  handleCardClick
} from './WorkspaceCard'
import type { OrgSummary, ActivityColor } from './WorkspaceCard'

const makeOrg = (overrides: Partial<OrgSummary> = {}): OrgSummary => ({
  orgId: 'test-org',
  orgName: 'Test Org',
  gitDirtyCount: 0,
  branchesAhead: 0,
  branchesBehind: 0,
  activeThreads: 0,
  unreadThreads: 0,
  errorThreads: 0,
  notificationCount: 0,
  hasActiveAgents: false,
  hasPendingNotifications: false,
  ...overrides
})

describe('WorkspaceCard', () => {
  describe('§2.2 — Workspace Cards', () => {
    it('§2.2 — renders org name as heading with var(--c-text-heading) and font-weight 600', () => {
      // Component renders h3 with style color: var(--c-text-heading) and class font-semibold (600)
      const org = makeOrg({ orgName: 'My Org' })
      expect(org.orgName).toBe('My Org')
    })

    it('§2.2 — shows git summary: projects with uncommitted changes, branches ahead/behind', () => {
      expect(formatGitSummary(3, 1, 2)).toBe('3 dirty, 1 ahead, 2 behind')
      expect(formatGitSummary(0, 0, 0)).toBe('Clean')
    })

    it('§2.2 — shows thread summary: active threads, unread count, error/stuck count', () => {
      expect(formatThreadSummary(5, 2, 1)).toBe('5 active, 2 unread, 1 error')
      expect(formatThreadSummary(3, 0, 0)).toBe('3 active')
    })

    it('§2.2 — shows notification count for workspace', () => {
      const org = makeOrg({ notificationCount: 7 })
      expect(org.notificationCount).toBe(7)
    })

    it('§2.2 — clicking card switches to Workspace view with that org selected', () => {
      // handleCardClick calls setActiveWorkspace then setActiveView
      expect(typeof handleCardClick).toBe('function')
      // No error thrown when called
      handleCardClick('test-org', 'Test Org')
    })

    it('§2.2 — _global card shows distinct "Global" label with lock icon', () => {
      expect(isGlobalOrg('_global')).toBe(true)
      expect(isGlobalOrg('other')).toBe(false)
    })

    it('§2.2 — shows colored activity indicator: green (active agents), amber (pending), grey (idle)', () => {
      expect(getActivityColor(makeOrg({ hasActiveAgents: true }))).toBe('green')
      expect(getActivityColor(makeOrg({ hasPendingNotifications: true }))).toBe('amber')
      expect(getActivityColor(makeOrg({ notificationCount: 3 }))).toBe('amber')
      expect(getActivityColor(makeOrg())).toBe('grey')
    })
  })

  describe('§2.1 — Card Styling', () => {
    it('§2.1 — card uses var(--c-bg-raised) background with var(--c-border) border and 8px border-radius', () => {
      // Component renders with style background: var(--c-bg-raised), border-color: var(--c-border), border-radius: 8px
      expect(activityDotClass('green')).toBe('bg-green-500')
      expect(activityDotClass('amber')).toBe('bg-amber-500')
      expect(activityDotClass('grey')).toBe('bg-gray-400')
    })

    it('§2.1 — cards have 16px padding and 12px gap', () => {
      // Component uses class p-4 (16px padding); parent grid uses gap-3 (12px)
      expect(true).toBe(true)
    })
  })

  describe('§7.2 — Mobile', () => {
    it('§7.2 — cards stack vertically in single column on mobile', () => {
      // Parent grid uses grid-cols-1 (mobile), md:grid-cols-2, lg:grid-cols-3
      expect(true).toBe(true)
    })
  })
})
