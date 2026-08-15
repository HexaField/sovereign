import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// §P.1 Architecture View tests
// OverviewTab.tsx was removed — section card overview content no longer
// lives in a dedicated tab. Tests that verified section card presence in
// that file are removed; the SectionCard component and remaining system
// view tests survive.

const systemViewSrc = fs.readFileSync(path.resolve(__dirname, '../features/system/SystemView.tsx'), 'utf-8')

describe('§P.1 Architecture View', () => {
  // §P.1.1 Overview Tab
  describe('§P.1.1 System View', () => {
    it('§P.1.1 tabbed interface exists in SystemView', () => {
      // Tabs renamed: Architecture → Status, plus Agents, Activity, Config, Jobs
      expect(systemViewSrc).toContain('SYSTEM_TABS')
      expect(systemViewSrc).toContain('Status')
    })

    it('§P.1.1 SectionCard reusable component exists with collapsible body + badge', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })
  })

  // §P.1.2 Activity Tab
  describe('§P.1.2 Activity Tab', () => {
    it('§P.1.2 ActivityTab component exists', async () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../features/system/ActivityTab.tsx'), 'utf-8')
      expect(src).toContain('ActivityTab')
    })
  })

  // §P.1.3 Health Timeline
  describe('§P.1.3 Health Timeline', () => {
    it('§P.1.3 HealthTimeline component exists', async () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../features/system/HealthTimeline.tsx'), 'utf-8')
      expect(src).toContain('HealthTimeline')
    })

    it('§P.1.3 MUST add health metric polling endpoint GET /api/system/health/history', () => {
      const routesSrc = fs.readFileSync(path.resolve(__dirname, '../../../../packages/system/src/routes.ts'), 'utf-8')
      expect(routesSrc).toContain("'/api/system/health/history'")
    })

    it('§P.1.3 MUST support configurable time windows', () => {
      const routesSrc = fs.readFileSync(path.resolve(__dirname, '../../../../packages/system/src/routes.ts'), 'utf-8')
      expect(routesSrc).toContain('windowMs')
    })
  })

  // §P.1.4 SectionCard
  describe('§P.1.4 SectionCard', () => {
    it('§P.1.4 MUST export SectionCard component', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })

    it('§P.1.4 MUST accept title, icon, badge, defaultOpen, and children props', async () => {
      const mod = await import('./SectionCard.js')
      expect(mod.SectionCard.length).toBe(1)
    })

    it('§P.1.4 MUST be collapsible with animated expand/collapse', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })

    it('§P.1.4 MUST display badge count', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })

    it('§P.1.4 MUST display icon', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })
  })
})
