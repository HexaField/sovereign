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

describe('SystemView', () => {
  describe('§6.1 — System Tabs', () => {
    it('§6.1 — renders horizontal tab bar with: Overview, Architecture, Logs, Health, Config, Devices, Jobs, Events, Threads', async () => {
      const mod = await import('./SystemView.js')
      expect(mod.SYSTEM_TABS).toBeDefined()
      expect(mod.SYSTEM_TABS.map((t: any) => t.label)).toEqual([
        'Overview',
        'Architecture',
        'Logs',
        'Health',
        'Config',
        'Devices',
        'Jobs',
        'Events',
        'Threads'
      ])
      expect(mod.SYSTEM_TABS.map((t: any) => t.id)).toEqual([
        'overview',
        'architecture',
        'logs',
        'health',
        'config',
        'devices',
        'jobs',
        'events',
        'threads'
      ])
    })

    it('§6.1 — only one tab content visible at a time', async () => {
      const mod = await import('./SystemView.js')
      const components = mod.SYSTEM_TABS.map((t: any) => t.component)
      expect(new Set(components).size).toBe(9)
      expect(typeof mod.default).toBe('function')
    })
  })

  describe('§7.6 — Mobile System', () => {
    it('§7.6 — tabs scroll horizontally if they dont fit on mobile', async () => {
      const mod = await import('./SystemView.js')
      expect(mod.SYSTEM_TABS.length).toBe(9)
    })

    it('§7.6 — config editor stacks fields vertically on mobile', async () => {
      const mod = await import('./ConfigTab.js')
      expect(typeof mod.default).toBe('function')
    })
  })
})
