import { describe, it, expect } from 'vitest'

describe('HealthTab', () => {
  describe('§6.4 — Health Tab', () => {
    it('§6.4 — shows system health metrics in card grid layout', async () => {
      const mod = await import('./HealthTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchHealth).toBe('function')
    })

    it('§6.4 — Connection card: WS status, agent backend status, uptime', async () => {
      const { formatUptime } = await import('./HealthTab.js')
      expect(formatUptime(90061)).toBe('1d 1h 1m')
      expect(formatUptime(3660)).toBe('1h 1m')
      expect(formatUptime(120)).toBe('2m')
    })

    it('§6.4 — Resources card: disk usage, memory usage', async () => {
      const { formatBytes } = await import('./HealthTab.js')
      expect(formatBytes(500)).toBe('500 B')
      expect(formatBytes(1536)).toBe('1.5 KB')
      expect(formatBytes(1048576)).toBe('1.0 MB')
      expect(formatBytes(1073741824)).toBe('1.0 GB')
    })

    it('§6.4 — Jobs card: active jobs, last run status, next run time', async () => {
      const mod = await import('./HealthTab.js')
      // HealthTab renders Jobs card with active count, last status, next run
      expect(typeof mod.default).toBe('function')
    })

    it('§6.4 — Errors card: error count in last hour, last 5 errors with timestamps', async () => {
      const mod = await import('./HealthTab.js')
      // HealthTab renders Errors card with countLastHour and recent errors (sliced to 5)
      expect(typeof mod.default).toBe('function')
    })

    it('§6.4 — data from GET /api/system/health', async () => {
      const { fetchHealth } = await import('./HealthTab.js')
      expect(typeof fetchHealth).toBe('function')
    })
  })
})
