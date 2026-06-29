import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { createPresenceDigest, summariseAssistantContent } from './digest.js'
import { createWatchStore } from './watch-store.js'

function makeBus() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  const bus = {
    emit(event: { type: string; payload: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    off(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.off(type, handler)
    }
  }
  return bus as any
}

describe('summariseAssistantContent', () => {
  it('strips thinking blocks and code blocks', () => {
    const raw = '<antThinking>scratch</antThinking>Hi. Done.'
    expect(summariseAssistantContent(raw)).toBe('Hi.')
  })

  it('truncates long content to 120 chars with ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = summariseAssistantContent(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('...')).toBe(true)
  })

  it('handles markdown by stripping leading symbols', () => {
    expect(summariseAssistantContent('## Title\n- one\n- two')).toBe('Title one two')
  })

  it('returns empty for empty input', () => {
    expect(summariseAssistantContent('')).toBe('')
  })
})

describe('PresenceDigest', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-digest-'))
  })

  it('only accumulates assistant turns from watched threads', () => {
    const bus = makeBus()
    const watch = createWatchStore(dir)
    watch.add('watched-thread')
    const digest = createPresenceDigest({
      bus,
      watchStore: watch,
      resolveLabel: () => 'watched'
    })
    bus.emit({
      type: 'chat.turn.completed',
      payload: { threadId: 'unrelated-thread', turn: { role: 'assistant', content: 'noise' } }
    })
    bus.emit({
      type: 'chat.turn.completed',
      payload: { threadId: 'watched-thread', turn: { role: 'user', content: 'user msg' } }
    })
    bus.emit({
      type: 'chat.turn.completed',
      payload: { threadId: 'watched-thread', turn: { role: 'assistant', content: 'Done a thing.' } }
    })
    expect(digest.peek()).toHaveLength(1)
    expect(digest.peek()[0].threadId).toBe('watched-thread')
  })

  it('take() returns formatted block and clears buffer', () => {
    const bus = makeBus()
    const watch = createWatchStore(dir)
    watch.add('t1')
    const digest = createPresenceDigest({
      bus,
      watchStore: watch,
      resolveLabel: (id) => `label-${id}`
    })
    bus.emit({
      type: 'chat.turn.completed',
      payload: { threadId: 't1', turn: { role: 'assistant', content: 'First thing.' } }
    })
    const out = digest.take()
    expect(out).toContain('Thread activity since last interaction')
    expect(out).toContain('label-t1')
    expect(out).toContain('First thing')
    expect(digest.peek()).toHaveLength(0)
    // Second take is null
    expect(digest.take()).toBeNull()
  })

  it('caps the buffer at maxEntries (oldest evicted)', () => {
    const bus = makeBus()
    const watch = createWatchStore(dir)
    watch.add('t1')
    const digest = createPresenceDigest({
      bus,
      watchStore: watch,
      resolveLabel: () => 't1',
      maxEntries: 3
    })
    for (let i = 0; i < 5; i++) {
      bus.emit({
        type: 'chat.turn.completed',
        payload: { threadId: 't1', turn: { role: 'assistant', content: `Turn ${i}.` } }
      })
    }
    expect(digest.peek()).toHaveLength(3)
    // Oldest evicted — first remaining is Turn 2
    expect(digest.peek()[0].summary).toContain('Turn 2')
  })

  it('persists buffer across instances', () => {
    const bus = makeBus()
    const watch = createWatchStore(dir)
    watch.add('t1')
    const persistFile = path.join(dir, 'digest.json')
    const first = createPresenceDigest({
      bus,
      watchStore: watch,
      resolveLabel: () => 't1',
      persistFile
    })
    bus.emit({
      type: 'chat.turn.completed',
      payload: { threadId: 't1', turn: { role: 'assistant', content: 'Persisted.' } }
    })
    first.dispose()
    const bus2 = makeBus()
    const second = createPresenceDigest({
      bus: bus2,
      watchStore: watch,
      resolveLabel: () => 't1',
      persistFile
    })
    expect(second.peek()).toHaveLength(1)
    expect(second.peek()[0].summary).toContain('Persisted')
  })
})
