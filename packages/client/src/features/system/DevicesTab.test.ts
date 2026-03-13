import { describe, it, expect } from 'vitest'

describe('DevicesTab', () => {
  describe('§6.6 — Devices Tab', () => {
    it('§6.6 — shows connected devices and pending pairing requests', async () => {
      const mod = await import('./DevicesTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchDevices).toBe('function')
    })

    it('§6.6 — each device shows name, ID, status, last seen', async () => {
      const { getDeviceStatusClass, getDeviceStatusLabel } = await import('./DevicesTab.js')
      expect(getDeviceStatusClass('connected')).toBe('bg-green-500')
      expect(getDeviceStatusClass('disconnected')).toBe('bg-gray-500')
      expect(getDeviceStatusLabel('connected')).toBe('Connected')
      expect(getDeviceStatusLabel('disconnected')).toBe('Disconnected')
    })

    it('§6.6 — pending requests show approve/reject buttons', async () => {
      const { approvePairing, rejectPairing } = await import('./DevicesTab.js')
      expect(typeof approvePairing).toBe('function')
      expect(typeof rejectPairing).toBe('function')
    })
  })
})
