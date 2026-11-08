import { describe, expect, it, vi } from 'vitest'
import { buildSovereignMcpDeps, type SubagentDefaults } from './mcp-deps.js'

function setup(defaults: () => SubagentDefaults) {
  const spawnSubagent = vi.fn(async () => 'child-1')
  const backend = { spawnSubagent }
  const deps = buildSovereignMcpDeps({
    routing: { forSession: () => backend, forKind: () => backend, all: () => [] },
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

describe('harnesses', () => {
  function harnessSetup(defaults: SubagentDefaults = { model: 'claude-model', timeoutMinutes: 30 }) {
    const spawnSubagent = vi.fn(async () => 'child-1')
    const stopSubagent = vi.fn(async () => {})
    const listSubagents = vi.fn(async () => [{ sessionKey: 'claude-child', label: 'c', status: 'working' }])
    const backend = { spawnSubagent, stopSubagent, listSubagents }
    const runner = {
      spawn: vi.fn(async () => 'harness-1'),
      list: vi.fn(() => [
        { sessionKey: 'harness-1', parentKey: 'parent', label: 'd', status: 'working' as const, task: 't' }
      ]),
      has: vi.fn((key: string) => key === 'harness-1'),
      stop: vi.fn(async () => {}),
      describe: vi.fn(() => ['claude: Claude Code', 'devin: devin'])
    }
    const profiles = {
      claude: { adapter: 'claude' as const },
      opus: { adapter: 'claude' as const, model: 'claude-opus-x' },
      devin: { adapter: 'devin' as const, model: 'swe-2-high' }
    }
    const deps = buildSovereignMcpDeps({
      routing: { forSession: () => backend, forKind: () => backend, all: () => [{ backend }] },
      subagentDefaults: () => defaults,
      harnesses: { runner, profiles: () => profiles }
    } as any)
    return { deps, runner, spawnSubagent, stopSubagent, listSubagents }
  }

  it('runs a non-claude profile on the runner with the model asked for and the configured time limit', async () => {
    const { deps, runner, spawnSubagent } = harnessSetup()
    const result = await deps.agents!.spawn('parent', {
      task: 't',
      cwd: '~/workspaces/coasys/ad4m',
      label: 'l',
      harness: 'devin',
      model: 'swe-2-medium'
    })
    expect(result).toEqual({ sessionKey: 'harness-1' })
    expect(runner.spawn).toHaveBeenCalledWith('parent', {
      harness: 'devin',
      task: 't',
      cwd: '~/workspaces/coasys/ad4m',
      label: 'l',
      model: 'swe-2-medium',
      timeoutMs: 30 * 60_000
    })
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it('takes subagentDefaults.harness when the call names none, else claude', async () => {
    const { deps, runner, spawnSubagent } = harnessSetup({ harness: 'devin' })
    await deps.agents!.spawn('parent', { task: 't', cwd: '/w' })
    expect(runner.spawn).toHaveBeenCalledWith('parent', expect.objectContaining({ harness: 'devin' }))
    await deps.agents!.spawn('parent', { task: 't', harness: 'claude' })
    expect(spawnSubagent).toHaveBeenCalledTimes(1)
    const plain = harnessSetup({})
    await plain.deps.agents!.spawn('parent', { task: 't' })
    expect(plain.spawnSubagent).toHaveBeenCalledTimes(1)
    expect(plain.runner.spawn).not.toHaveBeenCalled()
  })

  it('keeps claude profiles on the backend: thread and global model first, then the call, then the profile', async () => {
    const { deps, spawnSubagent } = harnessSetup({})
    await deps.agents!.spawn('parent', { task: 't', harness: 'opus' })
    expect(spawnSubagent).toHaveBeenLastCalledWith(
      'parent',
      expect.objectContaining({ model: { provider: '', model: 'claude-opus-x' } })
    )
    await deps.agents!.spawn('parent', { task: 't', harness: 'opus', model: 'claude-sonnet-y' })
    expect(spawnSubagent).toHaveBeenLastCalledWith(
      'parent',
      expect.objectContaining({ model: { provider: '', model: 'claude-sonnet-y' } })
    )
    const global = harnessSetup({ model: 'claude-global' })
    await global.deps.agents!.spawn('parent', { task: 't', harness: 'opus', model: 'claude-sonnet-y' })
    expect(global.spawnSubagent).toHaveBeenLastCalledWith(
      'parent',
      expect.objectContaining({ model: { provider: '', model: 'claude-global' } })
    )
  })

  it('refuses an unknown profile, and a non-claude one when no runner is wired', async () => {
    const { deps } = harnessSetup()
    await expect(deps.agents!.spawn('parent', { task: 't', harness: 'nope' })).rejects.toThrow(/unknown harness nope/)
    const bare = buildSovereignMcpDeps({ routing: { forSession: () => ({}), all: () => [] } } as any)
    await expect(bare.agents!.spawn('parent', { task: 't', harness: 'devin' })).rejects.toThrow(/harness devin/)
  })

  it('caps running subagents per parent across every harness', async () => {
    const { deps, runner, listSubagents } = harnessSetup()
    listSubagents.mockResolvedValue([
      { sessionKey: 'c1', label: 'c', status: 'working' },
      { sessionKey: 'c2', label: 'c', status: 'working' },
      { sessionKey: 'c3', label: 'c', status: 'working' }
    ])
    // 3 Claude children plus 1 harness run: the fifth is refused, on either side.
    await expect(deps.agents!.spawn('parent', { task: 't', harness: 'devin', cwd: '/w' })).rejects.toThrow(/max 4/)
    await expect(deps.agents!.spawn('parent', { task: 't' })).rejects.toThrow(/max 4/)
    expect(runner.spawn).not.toHaveBeenCalled()
  })

  it('lists harness runs beside the backend subagents, stops them on the runner, and describes the profiles', async () => {
    const { deps, runner, stopSubagent } = harnessSetup()
    expect(await deps.agents!.list('parent')).toEqual([
      { sessionKey: 'claude-child', label: 'c', status: 'working' },
      { sessionKey: 'harness-1', label: 'd', status: 'working', task: 't' }
    ])
    expect(runner.list).toHaveBeenCalledWith('parent')
    await deps.agents!.stop('harness-1')
    expect(runner.stop).toHaveBeenCalledWith('harness-1')
    expect(stopSubagent).not.toHaveBeenCalled()
    await deps.agents!.stop('claude-child')
    expect(stopSubagent).toHaveBeenCalledWith('claude-child')
    expect(deps.agents!.harnesses!()).toEqual(['claude: Claude Code', 'devin: devin'])
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
