import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSimpleConversation } from './simple-conversation.js'

function makeBus() {
  const emitter = new EventEmitter()
  return {
    emit(event: { type: string; timestamp?: string; source?: string; payload?: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: any) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    off(type: string, handler: (event: any) => void) {
      emitter.off(type, handler)
    }
  } as any
}

const GATEWAY = 'gw-thread-1'

describe('SimpleConversation', () => {
  it('starts empty', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })
    expect(store.getEntries()).toEqual([])
    store.shutdown()
  })

  it('collects user messages on the gateway thread', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Hello Hex' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].role).toBe('user')
    expect(entries[0].text).toBe('Hello Hex')
    expect(entries[0].modality).toBe('text')
    store.shutdown()
  })

  it('captures voice modality from user messages', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Check the deploy', origin: { modality: 'voice' } }
    })

    expect(store.getEntries()[0].modality).toBe('voice')
    store.shutdown()
  })

  it('ignores user messages on non-gateway threads', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'other-thread', text: 'Should not appear' }
    })

    expect(store.getEntries()).toHaveLength(0)
    store.shutdown()
  })

  it('collects Hex replies from presence.reply events', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'voice', text: 'Looking into it now, sir.' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].role).toBe('hex')
    expect(entries[0].text).toBe('Looking into it now, sir.')
    expect(entries[0].modality).toBe('voice')
    store.shutdown()
  })

  it('collects text replies from presence.reply events', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'text', text: 'Build succeeded.' }
    })

    expect(store.getEntries()[0].modality).toBe('text')
    store.shutdown()
  })

  it('maintains chronological order across user and hex entries', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Run the tests' }
    })
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'presence',
      payload: { modality: 'voice', text: 'All tests pass, sir.' }
    })
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:10Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Ship it' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.role)).toEqual(['user', 'hex', 'user'])
    expect(entries.map((e) => e.text)).toEqual(['Run the tests', 'All tests pass, sir.', 'Ship it'])
    store.shutdown()
  })

  it('emits presence.simple-conversation.updated on each entry', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    const updates: any[] = []
    bus.on('presence.simple-conversation.updated', (e: any) => updates.push(e.payload))

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Hello' }
    })

    expect(updates).toHaveLength(1)
    expect(updates[0].entry.role).toBe('user')
    expect(updates[0].total).toBe(1)
    store.shutdown()
  })

  it('caps at MAX_ENTRIES (200)', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    for (let i = 0; i < 210; i++) {
      bus.emit({
        type: 'chat.message.sent',
        timestamp: new Date(i * 1000).toISOString(),
        source: 'chat',
        payload: { threadId: GATEWAY, text: `msg-${i}` }
      })
    }

    const entries = store.getEntries()
    expect(entries).toHaveLength(200)
    // Oldest should start at 10 (0-9 evicted)
    expect(entries[0].text).toBe('msg-10')
    expect(entries[199].text).toBe('msg-209')
    store.shutdown()
  })

  it('shutdown clears entries and stops listening', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Before shutdown' }
    })
    expect(store.getEntries()).toHaveLength(1)

    store.shutdown()
    expect(store.getEntries()).toHaveLength(0)

    // Events after shutdown should not accumulate
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:01:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'After shutdown' }
    })
    expect(store.getEntries()).toHaveLength(0)
  })

  it('handles null gatewayThreadId gracefully', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: null }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'any-thread', text: 'Should not appear' }
    })

    expect(store.getEntries()).toHaveLength(0)

    // Hex replies still accumulate (they carry no thread filter)
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'text', text: 'Reply without gateway' }
    })
    expect(store.getEntries()).toHaveLength(1)
    store.shutdown()
  })
})

describe('SimpleConversation — assistant turn capture', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures a text-originated assistant turn after the grace period', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: GATEWAY, turn: { role: 'assistant', content: 'Here are the results, sir.' } }
    })

    // Immediately after — still deferred
    expect(store.getEntries()).toHaveLength(0)

    // After the grace window (5s)
    vi.advanceTimersByTime(5100)
    expect(store.getEntries()).toHaveLength(1)
    expect(store.getEntries()[0].role).toBe('hex')
    expect(store.getEntries()[0].text).toBe('Here are the results, sir.')
    expect(store.getEntries()[0].modality).toBe('text')
    store.shutdown()
  })

  it('truncates long text-mode responses to first paragraph', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    const longContent =
      'Done. Here is the summary.\n\n' +
      'First implementation detail that goes into great depth about the changes.\n\n' +
      'Second paragraph with even more detail that nobody needs in the simple view.\n\n' +
      'Third paragraph. ' +
      'x'.repeat(1000)

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: GATEWAY, turn: { role: 'assistant', content: longContent } }
    })

    vi.advanceTimersByTime(5100)
    const text = store.getEntries()[0].text
    // Should contain the first paragraph only, not the full response
    expect(text).toContain('Done')
    expect(text.length).toBeLessThanOrEqual(500)
    expect(text).not.toContain('Second paragraph')
    store.shutdown()
  })

  it('does not duplicate entry when timer fires just before presence.reply', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: GATEWAY, turn: { role: 'assistant', content: 'Short answer.' } }
    })

    // Timer fires — text entry pushed
    vi.advanceTimersByTime(5100)
    expect(store.getEntries()).toHaveLength(1)
    expect(store.getEntries()[0].modality).toBe('text')

    // Voice summary arrives just after the timer — should NOT add a duplicate
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:11Z',
      source: 'voice-response',
      payload: { modality: 'voice', text: 'Short answer, sir.' }
    })

    // Still only one entry — the text one from the timer
    expect(store.getEntries()).toHaveLength(1)
    store.shutdown()
  })

  it('discards a deferred turn when a presence.reply arrives within the grace window', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    // Assistant turn completes — deferred
    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: { role: 'assistant', content: '# Full markdown response\n\nLots of detail...' }
      }
    })

    // Voice summary arrives within grace window — replaces deferred turn
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:07Z',
      source: 'voice-response',
      payload: { modality: 'voice', text: 'Concise spoken summary, sir.' }
    })

    // The voice summary appears immediately
    expect(store.getEntries()).toHaveLength(1)
    expect(store.getEntries()[0].text).toBe('Concise spoken summary, sir.')
    expect(store.getEntries()[0].modality).toBe('voice')

    // After grace window — no duplicate from the raw turn
    vi.advanceTimersByTime(5200)
    expect(store.getEntries()).toHaveLength(1)
    store.shutdown()
  })

  it('strips markdown from raw assistant turns', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    // Single paragraph — no truncation, just markdown stripping
    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: {
          role: 'assistant',
          content: "The **tests** pass. Here's `some code`. All good."
        }
      }
    })

    vi.advanceTimersByTime(5100)
    const text = store.getEntries()[0].text
    expect(text).not.toContain('**')
    expect(text).toContain('The tests pass')
    expect(text).toContain('All good')
    store.shutdown()
  })

  it('ignores non-gateway assistant turns', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: 'other-thread', turn: { role: 'assistant', content: 'Should not appear.' } }
    })

    vi.advanceTimersByTime(5100)
    expect(store.getEntries()).toHaveLength(0)
    store.shutdown()
  })

  it('ignores user turns on the gateway thread', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: GATEWAY, turn: { role: 'user', content: 'User turn — skip.' } }
    })

    expect(store.getEntries()).toHaveLength(0)
    store.shutdown()
  })

  it('cleans up deferred timers on shutdown', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: GATEWAY, turn: { role: 'assistant', content: 'Pending turn.' } }
    })

    // Shutdown before grace window fires
    store.shutdown()
    expect(store.getEntries()).toHaveLength(0)
  })
})

describe('SimpleConversation — persistence', () => {
  const tmpDirs: string[] = []

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-conv-test-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    tmpDirs.length = 0
  })

  it('persists entries to disk and reloads on next create', async () => {
    const dir = makeTmpDir()
    const bus1 = makeBus()
    const store1 = createSimpleConversation({ bus: bus1, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })

    bus1.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Persist me' }
    })

    // shutdown flushes to disk
    store1.shutdown()

    // New instance should load from disk
    const bus2 = makeBus()
    const store2 = createSimpleConversation({ bus: bus2, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })

    const entries = store2.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Persist me')
    expect(entries[0].role).toBe('user')
    store2.shutdown()
  })

  it('appends new entries after reload', async () => {
    const dir = makeTmpDir()
    const bus1 = makeBus()
    const store1 = createSimpleConversation({ bus: bus1, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })

    bus1.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'First' }
    })
    store1.shutdown()

    const bus2 = makeBus()
    const store2 = createSimpleConversation({ bus: bus2, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })

    bus2.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'presence',
      payload: { modality: 'voice', text: 'Second' }
    })
    store2.shutdown()

    // Third instance sees both
    const bus3 = makeBus()
    const store3 = createSimpleConversation({ bus: bus3, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    const entries = store3.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.text)).toEqual(['First', 'Second'])
    store3.shutdown()
  })

  it('filters stale entries on reload — strips placeholders, dedup, and truncation', () => {
    const dir = makeTmpDir()
    // Seed the file with entries from before the fix
    const staleEntries = [
      { role: 'user', text: 'Hello', modality: 'text', timestamp: '2026-01-01T00:00:00Z' },
      // Placeholder from pre-fix streaming path — should get stripped
      { role: 'hex', text: '(streaming summary)', modality: 'voice', timestamp: '2026-01-01T00:00:05Z' },
      // Duplicate consecutive hex entries with same timestamp — both present
      // in the pre-fix data from the timer/reply race. After placeholder
      // stripped, the next hex at the same timestamp is kept (first hex@05).
      { role: 'hex', text: 'Concise voice summary.', modality: 'voice', timestamp: '2026-01-01T00:00:05Z' },
      { role: 'hex', text: 'Duplicate full text.', modality: 'text', timestamp: '2026-01-01T00:00:05Z' },
      // Overly long text entry — should get truncated
      {
        role: 'hex',
        text: 'Done. Summary paragraph.\n\n' + 'x'.repeat(2000),
        modality: 'text',
        timestamp: '2026-01-01T00:00:10Z'
      },
      { role: 'user', text: 'Thanks', modality: 'text', timestamp: '2026-01-01T00:00:15Z' }
    ]
    fs.writeFileSync(path.join(dir, 'simple-conversation.json'), JSON.stringify(staleEntries))

    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    const entries = store.getEntries()

    // Placeholder stripped, duplicate (same ts consecutive hex) stripped → 4 entries
    expect(entries).toHaveLength(4)
    expect(entries[0].text).toBe('Hello')
    expect(entries[1].text).toBe('Concise voice summary.')
    // The long entry should get truncated to first paragraph
    expect(entries[2].text).toBe('Done. Summary paragraph.')
    expect(entries[3].text).toBe('Thanks')
    store.shutdown()
  })

  it('survives a corrupt file gracefully', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'simple-conversation.json'), 'NOT JSON{{{')

    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    expect(store.getEntries()).toHaveLength(0)
    store.shutdown()
  })

  it('runs in-memory only when dataDir omitted', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Memory only' }
    })

    expect(store.getEntries()).toHaveLength(1)
    // No crash on shutdown without dataDir
    store.shutdown()
  })
})
