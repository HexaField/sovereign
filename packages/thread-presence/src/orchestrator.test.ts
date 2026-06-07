import { describe, it, expect } from 'vitest'
import type { EventBus, BusEvent } from '@sovereign/core'
import {
  handleTurnCompleted,
  handleThreadIteration,
  pushTagForThread,
  wirePresenceOrchestrator,
  type OrchestratorDeps
} from './orchestrator.js'

function fakeBus(): EventBus & { _fire: (e: BusEvent) => void } {
  const listeners = new Map<string, Array<(e: BusEvent) => void>>()
  return {
    emit(event: BusEvent) {
      for (const fn of listeners.get(event.type) ?? []) fn(event)
    },
    on(type: string, fn: (e: BusEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type)!.push(fn)
      return () => {
        const arr = listeners.get(type)
        if (arr)
          listeners.set(
            type,
            arr.filter((x) => x !== fn)
          )
      }
    },
    _fire(event: BusEvent) {
      for (const fn of listeners.get(event.type) ?? []) fn(event)
    }
  } as any
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps & {
  threads: Map<string, { id: string; label: string; unreadCount: number }>
  pushCalls: unknown[]
  focused: Set<string>
  muted: Set<string>
} {
  const threads = new Map<string, { id: string; label: string; unreadCount: number }>()
  const pushCalls: unknown[] = []
  const focused = new Set<string>()
  const muted = new Set<string>()
  const bus = fakeBus()
  return {
    bus,
    threads,
    pushCalls,
    focused,
    muted,
    presence: { isThreadFocused: (id) => focused.has(id) },
    muteStore: { isMuted: (id) => muted.has(id) },
    threadManager: {
      get: (id) => threads.get(id),
      markUnreadIncrement: (id) => {
        const t = threads.get(id)
        if (!t) return undefined
        t.unreadCount += 1
        return t.unreadCount
      },
      clearUnread: (id) => {
        const t = threads.get(id)
        if (!t || t.unreadCount === 0) return false
        t.unreadCount = 0
        return true
      }
    },
    push: {
      sendAll: async (payload: unknown) => {
        pushCalls.push(payload)
      }
    },
    ...overrides
  }
}

describe('pushTagForThread', () => {
  it('uses a thread- prefix so tags are scoped per thread', () => {
    expect(pushTagForThread('abc')).toBe('thread-abc')
  })
})

describe('handleTurnCompleted', () => {
  it('sends a push and bumps unread when not focused and not muted', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    const result = await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'assistant', content: 'Hello world' }
    })
    expect(result).toEqual({ pushed: true, bumped: true })
    expect(deps.threads.get('t1')?.unreadCount).toBe(1)
    expect(deps.pushCalls.length).toBe(1)
    const payload = deps.pushCalls[0] as Record<string, unknown>
    expect(payload).toMatchObject({
      type: 'thread.turn',
      threadId: 't1',
      title: 'Test',
      body: 'Hello world',
      tag: 'thread-t1',
      unreadCount: 1
    })
  })

  it('suppresses when the thread is focused on any device', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    deps.focused.add('t1')
    const result = await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'assistant', content: 'still working' }
    })
    expect(result).toEqual({ pushed: false, bumped: false, reason: 'focused' })
    expect(deps.threads.get('t1')?.unreadCount).toBe(0)
    expect(deps.pushCalls.length).toBe(0)
  })

  it('suppresses when the thread is muted', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    deps.muted.add('t1')
    const result = await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'assistant', content: 'noise' }
    })
    expect(result).toEqual({ pushed: false, bumped: false, reason: 'muted' })
    expect(deps.threads.get('t1')?.unreadCount).toBe(0)
    expect(deps.pushCalls.length).toBe(0)
  })

  it('ignores non-assistant turns (user echo)', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    const result = await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'user', content: 'my own message' }
    })
    expect(result).toEqual({ pushed: false, bumped: false, reason: 'non-assistant-turn' })
    expect(deps.pushCalls.length).toBe(0)
  })

  it('falls back to defaultBody when turn text is empty', async () => {
    const deps = makeDeps({ defaultBody: 'Custom fallback' })
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    await handleTurnCompleted(deps, { threadId: 't1', turn: { role: 'assistant' } })
    const payload = deps.pushCalls[0] as Record<string, unknown>
    expect(payload.body).toBe('Custom fallback')
  })

  it('truncates long bodies', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    const longText = 'a'.repeat(500)
    await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'assistant', content: longText }
    })
    const payload = deps.pushCalls[0] as Record<string, unknown>
    expect((payload.body as string).length).toBeLessThanOrEqual(140)
    expect((payload.body as string).endsWith('…')).toBe(true)
  })

  it('reads text from block-style content arrays', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    await handleTurnCompleted(deps, {
      threadId: 't1',
      turn: { role: 'assistant', content: [{ type: 'text', text: 'hello block' }] }
    })
    const payload = deps.pushCalls[0] as Record<string, unknown>
    expect(payload.body).toBe('hello block')
  })

  it('returns unknown-thread when the id is not in the manager', async () => {
    const deps = makeDeps()
    const result = await handleTurnCompleted(deps, {
      threadId: 'ghost',
      turn: { role: 'assistant', content: 'x' }
    })
    expect(result).toEqual({ pushed: false, bumped: false, reason: 'unknown-thread' })
  })
})

describe('handleThreadIteration', () => {
  it('clears unread and sends a thread.clear push when there was something to clear', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 3 })
    const result = await handleThreadIteration(deps, 't1')
    expect(result).toEqual({ cleared: true, dismissed: true })
    expect(deps.threads.get('t1')?.unreadCount).toBe(0)
    expect(deps.pushCalls.length).toBe(1)
    const payload = deps.pushCalls[0] as Record<string, unknown>
    expect(payload).toMatchObject({ type: 'thread.clear', threadId: 't1', tag: 'thread-t1' })
  })

  it('is a no-op when the thread is already read', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    const result = await handleThreadIteration(deps, 't1')
    expect(result.dismissed).toBe(false)
    expect(deps.pushCalls.length).toBe(0)
  })

  it('is a no-op for an unknown thread', async () => {
    const deps = makeDeps()
    await expect(handleThreadIteration(deps, 'ghost')).resolves.toEqual({ cleared: false, dismissed: false })
  })
})

describe('wirePresenceOrchestrator', () => {
  it('subscribes to chat.turn.completed', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    wirePresenceOrchestrator(deps)
    deps.bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2024-01-01',
      source: 'chat',
      payload: { threadId: 't1', turn: { role: 'assistant', content: 'done' } }
    })
    // Allow microtask to drain (handler is async)
    await Promise.resolve()
    expect(deps.pushCalls.length).toBe(1)
  })

  it('subscribes to thread.focused', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 2 })
    wirePresenceOrchestrator(deps)
    deps.bus.emit({
      type: 'thread.focused',
      timestamp: '2024-01-01',
      source: 'presence',
      payload: { threadId: 't1' }
    })
    await Promise.resolve()
    expect(deps.threads.get('t1')?.unreadCount).toBe(0)
    expect(deps.pushCalls.length).toBe(1)
  })

  it('subscribes to chat.message.sent', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 1 })
    wirePresenceOrchestrator(deps)
    deps.bus.emit({
      type: 'chat.message.sent',
      timestamp: '2024-01-01',
      source: 'chat',
      payload: { threadId: 't1' }
    })
    await Promise.resolve()
    expect(deps.threads.get('t1')?.unreadCount).toBe(0)
    expect(deps.pushCalls.length).toBe(1)
  })

  it('destroy() cancels subscriptions', async () => {
    const deps = makeDeps()
    deps.threads.set('t1', { id: 't1', label: 'Test', unreadCount: 0 })
    const wire = wirePresenceOrchestrator(deps)
    wire.destroy()
    deps.bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2024-01-01',
      source: 'chat',
      payload: { threadId: 't1', turn: { role: 'assistant', content: 'done' } }
    })
    await Promise.resolve()
    expect(deps.pushCalls.length).toBe(0)
  })
})
