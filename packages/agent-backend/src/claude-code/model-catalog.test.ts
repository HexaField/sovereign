import { describe, it, expect } from 'vitest'
import { createClaudeCodeBackend } from './claude-code.js'

/**
 * Guards model-id entries against API-rejected ids. Every id in the catalog
 * must match what the Anthropic models endpoint accepts. The 5.5-series
 * reintroduced minor suffixes (`claude-opus-5-5`); the bare 5-series
 * (`claude-opus-5`) also remains valid.
 */
describe('model catalog ids', () => {
  const backend = createClaudeCodeBackend({
    dataDir: '/tmp/model-catalog-test',
    cwd: '/tmp/model-catalog-test',
    agentDir: '/tmp/model-catalog-test/.claude'
  })

  async function ids(): Promise<string[]> {
    const { models } = await backend.listAvailableModels!()
    return models.map((m) => (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m))
  }

  it('lists Opus 5.5 and the bare 5-series', async () => {
    const list = await ids()
    expect(list).toContain('claude-opus-5-5')
    expect(list).toContain('claude-opus-5')
    expect(list).toContain('claude-sonnet-5')
  })

  it('lists Fable 5.1', async () => {
    const list = await ids()
    expect(list).toContain('claude-fable-5-1')
    expect(list).toContain('claude-fable-5')
  })

  it('still pins the 4-series with a minor', async () => {
    const list = await ids()
    expect(list).toContain('claude-opus-4-6')
    expect(list.some((id) => id === 'claude-opus-4')).toBe(false)
  })
})
