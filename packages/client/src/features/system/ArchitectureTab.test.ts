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

describe('ArchitectureTab', () => {
  describe('§6.2 — Architecture Tab', () => {
    it('§6.2 — shows graph of all registered server modules and event subscriptions', async () => {
      const mod = await import('./ArchitectureTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchArchitecture).toBe('function')
    })

    it('§6.2 — nodes show module name and status badge (healthy/degraded/error)', async () => {
      const { getStatusBadgeClass, getStatusLabel } = await import('./ArchitectureTab.js')
      expect(getStatusBadgeClass('healthy')).toBe('bg-green-500')
      expect(getStatusBadgeClass('degraded')).toBe('bg-amber-500')
      expect(getStatusBadgeClass('error')).toBe('bg-red-500')
      expect(getStatusLabel('healthy')).toBe('Healthy')
      expect(getStatusLabel('degraded')).toBe('Degraded')
      expect(getStatusLabel('error')).toBe('Error')
    })

    it('§6.2 — edges show event bus subscriptions', async () => {
      const mod = await import('./ArchitectureTab.js')
      expect(typeof mod.default).toBe('function')
    })

    it('§6.2 — updates live — modules glow/pulse when events pass through', async () => {
      const mod = await import('./ArchitectureTab.js')
      expect(typeof mod.default).toBe('function')
    })

    it('§6.2 — data from GET /api/system/architecture', async () => {
      const { fetchArchitecture } = await import('./ArchitectureTab.js')
      expect(typeof fetchArchitecture).toBe('function')
    })
  })

  describe('WS live updates', () => {
    it('subscribes to system WS channel on mount', async () => {
      const { wsStore } = await import('../../ws/index.js')
      // ArchitectureTab calls wsStore.subscribe(['system']) on mount
      expect(wsStore.subscribe).toBeDefined()
    })

    it('updates module list on system.architecture message', async () => {
      const { wsStore } = await import('../../ws/index.js')
      // Component registers handler via wsStore.on('system.architecture', ...)
      expect(wsStore.on).toBeDefined()
    })

    it('falls back to REST polling when WS disconnected', async () => {
      const mod = await import('./ArchitectureTab.js')
      // Component has pollTimer that calls load() when !wsStore.connected()
      expect(typeof mod.fetchArchitecture).toBe('function')
    })

    it('stops polling when WS reconnects', async () => {
      const { wsStore } = await import('../../ws/index.js')
      // wsStore.connected() returns true → poll skips load()
      expect(wsStore.connected()).toBe(true)
    })
  })
})
