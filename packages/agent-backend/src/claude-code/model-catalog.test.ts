import { describe, it, expect } from 'vitest'
import { createClaudeCodeBackend } from './claude-code.js'

/**
 * Guards the model-id naming trap: the 4-series pins a minor
 * (`claude-opus-4-6`), but the 5-series does NOT — the id is `claude-opus-5`.
 * A `claude-opus-5-0` entry (extrapolated from the 4-series pattern) is
 * rejected by the API with "It may not exist or you may not have access to
 * it", which surfaces to the user as a broken model picker.
 */
describe('model catalog ids', () => {
  const backend = createClaudeCodeBackend({ dataDir: '/tmp/model-catalog-test' })

  async function ids(): Promise<string[]> {
    const { models } = await backend.listAvailableModels!()
    // Catalog entries are `provider/model`; assert on the bare id.
    return models.map((m) => (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m))
  }

  it('lists the 5-series without a minor suffix', async () => {
    const list = await ids()
    expect(list).toContain('claude-opus-5')
    expect(list).toContain('claude-sonnet-5')
  })

  it('never lists a suffixed 5-series id', async () => {
    const list = await ids()
    const suffixed = list.filter((id) => /^claude-(opus|sonnet|haiku)-5-\d+$/.test(id))
    expect(suffixed).toEqual([])
  })

  it('still pins the 4-series with a minor', async () => {
    const list = await ids()
    expect(list).toContain('claude-opus-4-6')
    expect(list.some((id) => id === 'claude-opus-4')).toBe(false)
  })
})
