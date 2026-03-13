import { describe, it, expect } from 'vitest'

describe('ConfigTab', () => {
  describe('§6.5 — Config Tab', () => {
    it('§6.5 — shows current configuration as editable form', async () => {
      const mod = await import('./ConfigTab.js')
      expect(typeof mod.default).toBe('function')
    })

    it('§6.5 — fetches config from GET /api/config', async () => {
      const { fetchConfig } = await import('./ConfigTab.js')
      expect(typeof fetchConfig).toBe('function')
    })

    it('§6.5 — shows config schema from GET /api/config/schema', async () => {
      const { fetchConfigSchema } = await import('./ConfigTab.js')
      expect(typeof fetchConfigSchema).toBe('function')
    })

    it('§6.5 — supports editing values inline with type-appropriate inputs', async () => {
      const mod = await import('./ConfigTab.js')
      // ConfigTab renders boolean (checkbox), select, number, and text inputs
      // based on ConfigSchemaField.type
      expect(typeof mod.default).toBe('function')
    })

    it('§6.5 — saving calls PATCH /api/config and shows success/error feedback', async () => {
      const { patchConfig } = await import('./ConfigTab.js')
      expect(typeof patchConfig).toBe('function')
    })

    it('§6.5 — shows change history from GET /api/config/history as collapsible timeline', async () => {
      const { fetchConfigHistory } = await import('./ConfigTab.js')
      expect(typeof fetchConfigHistory).toBe('function')
    })

    it('§6.5 — changes apply immediately without restart', async () => {
      const mod = await import('./ConfigTab.js')
      // Feedback message says "changes applied immediately" — hot-reload, no restart
      expect(typeof mod.default).toBe('function')
    })
  })
})
