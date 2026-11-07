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

describe('agents.list', () => {
  it('lists only live subagents, not the finished ones left idle', async () => {
    const listSubagents = vi.fn(async () => [
      { sessionKey: 'a', label: 'working one', status: 'working' },
      { sessionKey: 'b', label: 'finished one', status: 'idle' }
    ])
    const deps = buildSovereignMcpDeps({ routing: { all: () => [{ backend: { listSubagents } }] } } as any)
    expect(await deps.agents!.list('parent')).toEqual([{ sessionKey: 'a', label: 'working one', status: 'working' }])
    expect(listSubagents).toHaveBeenCalledWith('parent')
  })
})

describe('executor devin', () => {
  function devinSetup() {
    const spawnSubagent = vi.fn(async () => 'child-1')
    const stopSubagent = vi.fn(async () => {})
    const listSubagents = vi.fn(async () => [{ sessionKey: 'claude-child', label: 'c', status: 'working' }])
    const backend = { spawnSubagent, stopSubagent, listSubagents }
    const devin = {
      spawn: vi.fn(async () => 'devin-1'),
      list: vi.fn(() => [
        { sessionKey: 'devin-1', parentKey: 'parent', label: 'd', status: 'working' as const, task: 't' }
      ]),
      has: vi.fn((key: string) => key === 'devin-1'),
      stop: vi.fn(async () => {})
    }
    const deps = buildSovereignMcpDeps({
      routing: { forSession: () => backend, forKind: () => backend, all: () => [{ backend }] },
      subagentDefaults: () => ({ model: 'claude-model', timeoutMinutes: 30 }),
      devin
    } as any)
    return { deps, devin, spawnSubagent, stopSubagent }
  }

  it('spawns on devin with the model asked for and the configured time limit, not the Claude model', async () => {
    const { deps, devin, spawnSubagent } = devinSetup()
    const result = await deps.agents!.spawn('parent', {
      task: 't',
      cwd: '~/workspaces/coasys/ad4m',
      label: 'l',
      executor: 'devin',
      model: 'swe-2-medium'
    })
    expect(result).toEqual({ sessionKey: 'devin-1' })
    expect(devin.spawn).toHaveBeenCalledWith('parent', {
      task: 't',
      cwd: '~/workspaces/coasys/ad4m',
      label: 'l',
      model: 'swe-2-medium',
      timeoutMs: 30 * 60_000
    })
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it('keeps executor claude (the default) on the backend', async () => {
    const { deps, devin, spawnSubagent } = devinSetup()
    await deps.agents!.spawn('parent', { task: 't', executor: 'claude' })
    await deps.agents!.spawn('parent', { task: 't' })
    expect(spawnSubagent).toHaveBeenCalledTimes(2)
    expect(devin.spawn).not.toHaveBeenCalled()
  })

  it('refuses executor devin when the devin executor is not wired', async () => {
    const deps = buildSovereignMcpDeps({ routing: { forSession: () => ({}) } } as any)
    await expect(deps.agents!.spawn('parent', { task: 't', executor: 'devin' })).rejects.toThrow(/devin/)
  })

  it('lists devin runs beside the backend subagents, and stops them through the executor', async () => {
    const { deps, devin, stopSubagent } = devinSetup()
    expect(await deps.agents!.list('parent')).toEqual([
      { sessionKey: 'claude-child', label: 'c', status: 'working' },
      { sessionKey: 'devin-1', label: 'd', status: 'working', task: 't' }
    ])
    expect(devin.list).toHaveBeenCalledWith('parent')
    await deps.agents!.stop('devin-1')
    expect(devin.stop).toHaveBeenCalledWith('devin-1')
    expect(stopSubagent).not.toHaveBeenCalled()
    await deps.agents!.stop('claude-child')
    expect(stopSubagent).toHaveBeenCalledWith('claude-child')
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

  it("tells the bus, so the session's next turn reads as started by another thread", async () => {
    const sendMessage = vi.fn(async () => {})
    const emitted: Array<{ type: string; payload: unknown }> = []
    const deps = buildSovereignMcpDeps({
      bus: { emit: (e: { type: string; payload: unknown }) => void emitted.push(e) },
      routing: {
        forSession: () => ({ sendMessage }),
        registry: { getByThread: () => undefined, getBySession: () => undefined }
      }
    } as any)
    await deps.sessions!.send(T, 'Please review the gear PR')
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'chat.message.injected',
        payload: { sessionKey: T, via: 'agent', preview: 'Please review the gear PR' }
      })
    ])
    // Emitted before the send, so a busy status the send causes finds it.
    expect(sendMessage).toHaveBeenCalledWith(T, 'Please review the gear PR')
  })

  it('uses the registry binding when the thread has one', async () => {
    const { deps, sendMessage } = sendSetup({ [T]: 'local-llm:abc' })
    await deps.sessions!.send(`agent:main:thread:${T}`, 'hi')
    expect(sendMessage).toHaveBeenCalledWith('local-llm:abc', 'hi')
  })
})
