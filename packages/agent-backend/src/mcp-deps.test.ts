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

describe('sessions.send', () => {
  // A thread's session key is its bare id: the chat module and the UI use that key.
  function sendSetup(registry: Record<string, string> = {}) {
    const sendMessage = vi.fn(async () => {})
    const deps = buildSovereignMcpDeps({
      routing: {
        forSession: () => ({ sendMessage }),
        registry: {
          getByThread: (id: string) => (registry[id] ? { sessionKey: registry[id] } : undefined),
          getBySession: () => undefined
        }
      }
    } as any)
    return { deps, sendMessage }
  }
  const T = '657e7ee2-e551-40bc-93fd-b7dbb55dad5b'

  it('sends to the bare thread id for a thread with no session yet (not a hidden legacy key)', async () => {
    const { deps, sendMessage } = sendSetup()
    await deps.sessions!.send(T, 'hi')
    expect(sendMessage).toHaveBeenCalledWith(T, 'hi')
  })

  it('treats the legacy agent:main:thread: form as the same thread', async () => {
    const { deps, sendMessage } = sendSetup()
    await deps.sessions!.send(`agent:main:thread:${T}`, 'hi')
    expect(sendMessage).toHaveBeenCalledWith(T, 'hi')
  })

  it('ignores a stale registry record that still names the legacy key', async () => {
    const { deps, sendMessage } = sendSetup({ [T]: `agent:main:thread:${T}` })
    await deps.sessions!.send(T, 'hi')
    expect(sendMessage).toHaveBeenCalledWith(T, 'hi')
  })

  it('uses the registry binding when the thread has one', async () => {
    const { deps, sendMessage } = sendSetup({ [T]: 'local-llm:abc' })
    await deps.sessions!.send(`agent:main:thread:${T}`, 'hi')
    expect(sendMessage).toHaveBeenCalledWith('local-llm:abc', 'hi')
  })
})
