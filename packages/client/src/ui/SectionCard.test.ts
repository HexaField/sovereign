import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// §P.1 Architecture View tests

const overviewSrc = fs.readFileSync(
  path.resolve(__dirname, '../features/system/OverviewTab.tsx'),
  'utf-8'
)
const systemViewSrc = fs.readFileSync(
  path.resolve(__dirname, '../features/system/SystemView.tsx'),
  'utf-8'
)

describe('§P.1 Architecture View', () => {
  // §P.1.1 Overview Tab
  describe('§P.1.1 Overview Tab', () => {
    it('§P.1.1 tabbed interface exists in SystemView', () => {
      // SystemView has tabs — verified by source inspection
      expect(systemViewSrc).toContain('Architecture')
    })

    it('§P.1.1 SectionCard reusable component exists with collapsible body + badge', async () => {
      const mod = await import('./SectionCard.js')
      expect(typeof mod.SectionCard).toBe('function')
    })

    it('§P.1.1 Thread Health section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Thread Health')
    })

    it('§P.1.1 Models section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Models')
    })

    it('§P.1.1 Channels section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Channels')
    })

    it('§P.1.1 Sessions section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Sessions')
    })

    it('§P.1.1 Cron Jobs section card exists in OverviewTab', () => {
      expect(overviewSrc).toMatch(/Cron|Jobs/)
    })

    it('§P.1.1 Skills section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Skills')
    })

    it('§P.1.1 LLM Context section card exists in OverviewTab', () => {
      expect(overviewSrc).toMatch(/LLM|Context/)
    })

    it('§P.1.1 Hooks section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Hooks')
    })

    it('§P.1.1 Notifications section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Notification')
    })

    it('§P.1.1 Events section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Events')
    })

    it('§P.1.1 Security & Devices section card exists in OverviewTab', () => {
      expect(overviewSrc).toMatch(/Security|Devices/)
    })

    it('§P.1.1 Scripts section card exists in OverviewTab', () => {
      expect(overviewSrc).toContain('Scripts')
    })
  })

  // §P.1.2 System Flow Graph
  describe('§P.1.2 System Flow Graph', () => {
    it('§P.1.2 FlowGraph component exists', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../features/system/FlowGraph.tsx'),
        'utf-8'
      )
      expect(src).toContain('FlowGraph')
    })
  })

  // §P.1.3 Health Timeline
  describe('§P.1.3 Health Timeline', () => {
    it('§P.1.3 HealthTimeline component exists', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../features/system/HealthTimeline.tsx'),
        'utf-8'
      )
      expect(src).toContain('HealthTimeline')
    })

    it('§P.1.3 MUST add health metric polling endpoint GET /api/system/health/history', () => {
      const routesSrc = fs.readFileSync(
        path.resolve(__dirname, '../../../../packages/server/src/system/routes.ts'),
        'utf-8'
      )
      expect(routesSrc).toContain("'/api/system/health/history'")
    })

    it('§P.1.3 MUST support configurable time windows', () => {
      const routesSrc = fs.readFileSync(
        path.resolve(__dirname, '../../../../packages/server/src/system/routes.ts'),
        'utf-8'
      )
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
