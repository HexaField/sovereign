import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { createTaskDigest } from './task-digest.js'
import type { TaskEventPayload } from './types.js'

function makeBus() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  const bus = {
    emit(event: { type: string; timestamp?: string; source?: string; payload: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: any) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    once(type: string, handler: (event: any) => void) {
      emitter.once(type, handler)
      return () => emitter.off(type, handler)
    },
    async *replay() {
      yield* []
    },
    history() {
      return []
    }
  }
  return bus as any
}

function emitTaskEvent(bus: any, type: string, payload: Partial<TaskEventPayload>) {
  bus.emit({
    type,
    timestamp: new Date().toISOString(),
    source: 'tasks',
    payload: {
      taskId: 'task://test',
      taskName: 'Test Task',
      threadId: null,
      sourceThreadId: 'thread-1',
      ...payload
    }
  })
}

// ── T3: TaskDigest ───────────────────────────────────────────────────

describe('TaskDigest', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-digest-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // T3.1: Formats task.created events
  it('formats task.created events', () => {
    const bus = makeBus()
    const digest = createTaskDigest({
      bus,
      resolveLabel: () => 'main'
    })

    emitTaskEvent(bus, 'task.created', {
      taskName: 'Build auth',
      sourceThreadId: 'thread-1',
      threadId: 'thread-2'
    })

    const entries = digest.peek()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toContain('"Build auth"')
    expect(entries[0].summary).toContain('created')
    expect(entries[0].summary).toContain('assigned to main')

    digest.dispose()
  })

  // T3.2: Formats task.state_changed events
  it('formats task.state_changed events', () => {
    const bus = makeBus()
    const digest = createTaskDigest({
      bus,
      resolveLabel: () => 'subagent-3'
    })

    emitTaskEvent(bus, 'task.state_changed', {
      taskName: 'Implement handler',
      oldState: 'pending',
      newState: 'in_progress'
    })

    const entries = digest.peek()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe('"Implement handler": pending → in_progress')

    digest.dispose()
  })

  // T3.3: Formats task.reassigned events
  it('formats task.reassigned events', () => {
    const bus = makeBus()
    const labels: Record<string, string> = {
      'thread-1': 'main',
      'thread-3': 'subagent-4'
    }
    const digest = createTaskDigest({
      bus,
      resolveLabel: (id) => labels[id]
    })

    emitTaskEvent(bus, 'task.reassigned', {
      taskName: 'Write tests',
      sourceThreadId: 'thread-1',
      newThreadId: 'thread-3'
    })

    const entries = digest.peek()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toContain('"Write tests" → assigned to subagent-4')

    digest.dispose()
  })

  // T3.4: Formats task.transient_updated events
  it('formats task.transient_updated events', () => {
    const bus = makeBus()
    const digest = createTaskDigest({
      bus,
      resolveLabel: () => 'worker'
    })

    emitTaskEvent(bus, 'task.transient_updated', {
      taskName: 'Run CI',
      transientState: 'running tests (4/7 passing)'
    })

    const entries = digest.peek()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe('"Run CI": running tests (4/7 passing)')

    digest.dispose()
  })

  // T3.5: take() returns formatted block and clears
  it('take() returns formatted block and clears buffer', () => {
    const bus = makeBus()
    const digest = createTaskDigest({
      bus,
      resolveLabel: () => 'main'
    })

    emitTaskEvent(bus, 'task.state_changed', {
      taskName: 'Build',
      oldState: 'pending',
      newState: 'in_progress'
    })

    const block = digest.take()
    expect(block).toBeTruthy()
    expect(block).toContain('[Task activity since last interaction]')
    expect(block).toContain('"Build": pending → in_progress')
    expect(block).toContain('[End task activity]')

    // Buffer should now empty
    expect(digest.take()).toBeNull()

    digest.dispose()
  })

  // T3.6: take() returns null when empty
  it('take() returns null when no events', () => {
    const bus = makeBus()
    const digest = createTaskDigest({ bus, resolveLabel: () => 'x' })
    expect(digest.take()).toBeNull()
    digest.dispose()
  })

  // T3.7: Buffer caps at maxEntries
  it('caps buffer at maxEntries', () => {
    const bus = makeBus()
    const digest = createTaskDigest({
      bus,
      resolveLabel: () => 'x',
      maxEntries: 3
    })

    for (let i = 0; i < 5; i++) {
      emitTaskEvent(bus, 'task.state_changed', {
        taskName: `Task ${i}`,
        oldState: 'pending',
        newState: 'in_progress'
      })
    }

    expect(digest.peek()).toHaveLength(3)
    // Oldest evicted — first remaining starts at Task 2
    expect(digest.peek()[0].summary).toContain('Task 2')

    digest.dispose()
  })

  // T3.8: Persists buffer across instances
  it('persists buffer across instances', () => {
    const bus1 = makeBus()
    const persistFile = path.join(dir, 'task-digest.json')

    const first = createTaskDigest({
      bus: bus1,
      resolveLabel: () => 'main',
      persistFile
    })

    emitTaskEvent(bus1, 'task.created', { taskName: 'Persisted task' })
    first.dispose()

    // Allow flush
    const bus2 = makeBus()
    const second = createTaskDigest({
      bus: bus2,
      resolveLabel: () => 'main',
      persistFile
    })

    expect(second.peek()).toHaveLength(1)
    expect(second.peek()[0].summary).toContain('Persisted task')

    second.dispose()
  })

  // T3.9: dispose() stops listening
  it('dispose() stops listening to bus events', () => {
    const bus = makeBus()
    const digest = createTaskDigest({ bus, resolveLabel: () => 'x' })
    digest.dispose()

    emitTaskEvent(bus, 'task.created', { taskName: 'After dispose' })
    expect(digest.peek()).toHaveLength(0)
  })

  // T3.10: Ignores transient_updated with no transientState
  it('ignores transient_updated events with empty transientState', () => {
    const bus = makeBus()
    const digest = createTaskDigest({ bus, resolveLabel: () => 'x' })

    emitTaskEvent(bus, 'task.transient_updated', {
      taskName: 'No state',
      transientState: undefined
    })

    expect(digest.peek()).toHaveLength(0)
    digest.dispose()
  })
})
