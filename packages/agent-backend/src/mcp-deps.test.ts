import { describe, expect, it, vi } from 'vitest'
import { buildSovereignMcpDeps, type SubagentDefaults } from './mcp-deps.js'

function setup(defaults: () => SubagentDefaults) {
  const spawnSubagent = vi.fn(async () => 'child-1')
  const backend = { spawnSubagent }
  const deps = buildSovereignMcpDeps({
    routing: { forSession: () => backend, forKind: () => backend },
    subagentDefaults: defaults
  } as any)
  return { deps, spawnSubagent }
}

describe('agents.spawn', () => {
  it('reads the subagent defaults at each spawn, so a config change applies to the next subagent', async () => {
    let current: SubagentDefaults = { model: 'model-a', timeoutMinutes: 240 }
    const { deps, spawnSubagent } = setup(() => current)

    await deps.agents!.spawn('parent', { task: 't' })
    expect(spawnSubagent).toHaveBeenLastCalledWith(
      'parent',
      expect.objectContaining({ model: { provider: '', model: 'model-a' }, timeoutMs: 240 * 60_000 })
    )

    current = { model: 'model-b', timeoutMinutes: 30 }
    await deps.agents!.spawn('parent', { task: 't' })
    expect(spawnSubagent).toHaveBeenLastCalledWith(
      'parent',
      expect.objectContaining({ model: { provider: '', model: 'model-b' }, timeoutMs: 30 * 60_000 })
    )
  })

  it('leaves the timeout to the backend default when config sets none', async () => {
    const { deps, spawnSubagent } = setup(() => ({}))
    await deps.agents!.spawn('parent', { task: 't' })
    expect((spawnSubagent.mock.calls[0] as any[])[1]).not.toHaveProperty('timeoutMs')
  })
})
