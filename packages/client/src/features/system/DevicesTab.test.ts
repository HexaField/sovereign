import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DevicesTab', () => {
  describe('§6.6 — Devices Tab', () => {
    it('exports the component and fetch helper', async () => {
      const mod = await import('./DevicesTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchDevices).toBe('function')
    })

    it('fetchDevices GETs /api/system/devices and returns the parsed body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ devices: [{ deviceId: 'd1', isCurrent: true, connectionStatus: 'connected' }] })
      })
      vi.stubGlobal('fetch', fetchMock)

      const { fetchDevices } = await import('./DevicesTab.js')
      const data = await fetchDevices()

      expect(fetchMock).toHaveBeenCalledWith('/api/system/devices')
      expect(data.devices).toHaveLength(1)
      expect(data.devices[0].deviceId).toBe('d1')
    })

    it('fetchDevices throws on non-OK response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
      const { fetchDevices } = await import('./DevicesTab.js')
      await expect(fetchDevices()).rejects.toThrow('HTTP 503')
    })
  })
})
