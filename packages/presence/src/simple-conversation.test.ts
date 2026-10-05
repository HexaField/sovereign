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

  it('keeps each thread’s messages apart', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'other-thread', text: 'Only in the other thread' }
    })

    expect(store.getEntries()).toHaveLength(0)
    expect(store.getEntries('other-thread').map((e) => e.text)).toEqual(['Only in the other thread'])
    store.shutdown()
  })

  it('files a reply under its threadId, and one without a threadId under the gateway', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })
    const reply = (payload: Record<string, unknown>) =>
      bus.emit({ type: 'presence.reply', timestamp: '2026-01-01T00:00:01Z', source: 'voice-response', payload })

    reply({ modality: 'voice', text: 'Spoken on t2.', threadId: 't2' })
    reply({ modality: 'text', text: 'From the presence tools.' })

    expect(store.getEntries('t2').map((e) => e.text)).toEqual(['Spoken on t2.'])
    expect(store.getEntries().map((e) => e.text)).toEqual(['From the presence tools.'])
    store.shutdown()
  })

  it('tags live updates with their thread', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })
    const updates: any[] = []
    bus.on('presence.simple-conversation.updated', (e: any) => updates.push(e.payload))

    bus.emit({ type: 'chat.message.sent', timestamp: 'x', source: 'chat', payload: { threadId: 't3', text: 'hi' } })

    expect(updates).toEqual([expect.objectContaining({ threadId: 't3', total: 1 })])
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
      payload: { threadId: 'any-thread', text: 'Kept under its thread' }
    })

    // No gateway: the default view is empty, and a reply naming no thread has nowhere to go.
    expect(store.getEntries()).toHaveLength(0)
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'text', text: 'Reply without gateway' }
    })
    expect(store.getEntries()).toHaveLength(0)
    expect(store.getEntries('any-thread').map((e) => e.text)).toEqual(['Kept under its thread'])
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

  it('captures assistant turns on any thread, under that thread', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: { threadId: 'other-thread', turn: { role: 'assistant', content: 'Done on the other thread.' } }
    })

    vi.advanceTimersByTime(5100)
    expect(store.getEntries()).toHaveLength(0)
    expect(store.getEntries('other-thread').map((e) => e.text)).toEqual(['Done on the other thread.'])
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

describe('SimpleConversation — LLM summarize', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the summarize function instead of truncation when provided', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async (text: string) => `Summary of: ${text.slice(0, 20)}`)
    const store = createSimpleConversation({
      bus,
      config: () => ({ gatewayThreadId: GATEWAY }),
      summarize
    })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: { role: 'assistant', content: 'A long response with many details.' }
      }
    })

    // Fire the grace-period timer
    vi.advanceTimersByTime(5100)
    // Flush the summarize promise
    await vi.advanceTimersByTimeAsync(0)

    expect(summarize).toHaveBeenCalledOnce()
    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toMatch(/^Summary of:/)
    expect(entries[0].modality).toBe('text')
    store.shutdown()
  })

  it('falls back to truncation when summarize rejects', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async () => {
      throw new Error('LLM down')
    })
    const store = createSimpleConversation({
      bus,
      config: () => ({ gatewayThreadId: GATEWAY }),
      summarize
    })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: { role: 'assistant', content: 'Short response.' }
      }
    })

    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)

    expect(summarize).toHaveBeenCalledOnce()
    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    // Falls back to truncated text, not the summary
    expect(entries[0].text).toBe('Short response.')
    store.shutdown()
  })

  it('falls back to truncation when summarize returns empty string', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async () => '')
    const store = createSimpleConversation({
      bus,
      config: () => ({ gatewayThreadId: GATEWAY }),
      summarize
    })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: { role: 'assistant', content: 'Another response.' }
      }
    })

    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Another response.')
    store.shutdown()
  })

  it('voice summary still takes priority over LLM summarize', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async () => 'LLM summary')
    const store = createSimpleConversation({
      bus,
      config: () => ({ gatewayThreadId: GATEWAY }),
      summarize
    })

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'chat',
      payload: {
        threadId: GATEWAY,
        turn: { role: 'assistant', content: 'Full response text.' }
      }
    })

    // Voice summary arrives within grace window — cancels the deferred timer
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:07Z',
      source: 'voice-response',
      payload: { modality: 'voice', text: 'Spoken summary.' }
    })

    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)

    // Summarize never called — voice summary arrived first
    expect(summarize).not.toHaveBeenCalled()
    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Spoken summary.')
    expect(entries[0].modality).toBe('voice')
    store.shutdown()
  })

  it('keeps a voice reply after an earlier typed turn left the race guard set', async () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })
    const turn = (content: string) =>
      bus.emit({
        type: 'chat.turn.completed',
        timestamp: 'x',
        source: 'chat',
        payload: { threadId: 'work', turn: { role: 'assistant', content } }
      })

    turn('Typed answer here.') // no voice summary follows: the timer fires
    vi.advanceTimersByTime(5100)
    turn('Spoken answer, long form.')
    bus.emit({
      type: 'presence.reply',
      timestamp: 'y',
      source: 'voice-response',
      payload: { modality: 'voice', text: 'Spoken summary.', threadId: 'work' }
    })
    vi.advanceTimersByTime(5100)

    expect(store.getEntries('work').map((e) => e.text)).toEqual(['Typed answer here.', 'Spoken summary.'])
    store.shutdown()
  })

  it('stops summarising a thread a day after its view was last opened', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async () => 'LLM summary')
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), summarize })
    await store.open('work')
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1)

    bus.emit({
      type: 'chat.turn.completed',
      timestamp: 'x',
      source: 'chat',
      payload: { threadId: 'work', turn: { role: 'assistant', content: 'Much later.' } }
    })
    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)

    expect(summarize).not.toHaveBeenCalled()
    expect(store.getEntries('work').map((e) => e.text)).toEqual(['Much later.'])
    store.shutdown()
  })

  it('summarises a thread’s turns only once its simple view has been opened', async () => {
    const bus = makeBus()
    const summarize = vi.fn(async () => 'LLM summary')
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), summarize })
    const turn = (content: string) =>
      bus.emit({
        type: 'chat.turn.completed',
        timestamp: '2026-01-01T00:00:05Z',
        source: 'chat',
        payload: { threadId: 'work', turn: { role: 'assistant', content } }
      })

    turn('Before anyone looked.')
    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)
    expect(summarize).not.toHaveBeenCalled()

    await store.open('work')
    turn('After the view opened.')
    vi.advanceTimersByTime(5100)
    await vi.advanceTimersByTimeAsync(0)

    expect(summarize).toHaveBeenCalledOnce()
    expect(store.getEntries('work').map((e) => e.text)).toEqual(['Before anyone looked.', 'LLM summary'])
    store.shutdown()
  })
})

describe('SimpleConversation — per-thread open and storage', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
    tmpDirs.length = 0
  })
  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-conv-thread-'))
    tmpDirs.push(dir)
    return dir
  }

  const HISTORY = [
    { role: 'user', content: 'Fix the build', timestamp: Date.parse('2026-01-01T00:00:00Z') },
    { role: 'system', content: 'compaction summary', timestamp: Date.parse('2026-01-01T00:00:01Z') },
    {
      role: 'assistant',
      content: '**Fixed.** The import was wrong.\n\nDetails…',
      timestamp: Date.parse('2026-01-01T00:00:02Z')
    },
    { role: 'user', content: 'thanks', timestamp: Date.parse('2026-01-01T00:00:03Z'), origin: { modality: 'voice' } }
  ]

  it('backfills a thread’s first open from its history, without the system turns', async () => {
    const bus = makeBus()
    const history = vi.fn(async () => HISTORY)
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), history })

    const entries = await store.open('work')

    expect(entries.map((e) => [e.role, e.text, e.modality])).toEqual([
      ['user', 'Fix the build', 'text'],
      ['hex', 'Fixed. The import was wrong.', 'text'],
      ['user', 'thanks', 'voice']
    ])
    await store.open('work')
    expect(history).toHaveBeenCalledOnce() // entries exist now: no second backfill
    store.shutdown()
  })

  it('keeps live entries that land while the history loads, after the older backfill', async () => {
    const bus = makeBus()
    let release!: () => void
    const history = vi.fn(() => new Promise<typeof HISTORY>((resolve) => (release = () => resolve(HISTORY))))
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), history })

    const opened = store.open('work')
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-02T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'work', text: 'live message' }
    })
    release()

    expect((await opened).map((e) => e.text)).toEqual([
      'Fix the build',
      'Fixed. The import was wrong.',
      'thanks',
      'live message'
    ])
    store.shutdown()
  })

  it('stores each thread in its own file, and remembers opened threads across restarts', async () => {
    const dir = makeTmpDir()
    const summarize = vi.fn(async () => 'LLM summary')
    const bus1 = makeBus()
    const store1 = createSimpleConversation({ bus: bus1, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    await store1.open('work')
    bus1.emit({
      type: 'chat.message.sent',
      timestamp: 'x',
      source: 'chat',
      payload: { threadId: 'work', text: 'kept' }
    })
    store1.shutdown()

    expect(fs.existsSync(path.join(dir, 'simple-conversation', 'work.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'simple-conversation.json'))).toBe(false) // the gateway file stays untouched

    vi.useFakeTimers()
    try {
      const bus2 = makeBus()
      const store2 = createSimpleConversation({
        bus: bus2,
        config: () => ({ gatewayThreadId: GATEWAY }),
        dataDir: dir,
        summarize
      })
      expect(store2.getEntries('work').map((e) => e.text)).toEqual(['kept'])
      bus2.emit({
        type: 'chat.turn.completed',
        timestamp: 'y',
        source: 'chat',
        payload: { threadId: 'work', turn: { role: 'assistant', content: 'A reply to summarise.' } }
      })
      vi.advanceTimersByTime(5100)
      await vi.advanceTimersByTimeAsync(0)
      expect(summarize).toHaveBeenCalledOnce() // still watched after the restart
      store2.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backfills on the first open even when live entries already exist, without duplicates', async () => {
    const bus = makeBus()
    const history = vi.fn(async () => [
      ...HISTORY,
      { role: 'user', content: 'new q', timestamp: Date.parse('2026-01-01T00:00:04Z') }
    ])
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), history })
    // Recorded live after deploy, before anyone opened the view; history holds it too.
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:04.100Z',
      source: 'chat',
      payload: { threadId: 'work', text: 'new q' }
    })

    const entries = await store.open('work')

    expect(entries.map((e) => e.text)).toEqual(['Fix the build', 'Fixed. The import was wrong.', 'thanks', 'new q'])
    store.shutdown()
  })

  it('moves the gateway log of older builds into the gateway thread’s own file', () => {
    const dir = makeTmpDir()
    const legacy = path.join(dir, 'simple-conversation.json')
    fs.writeFileSync(legacy, JSON.stringify([{ role: 'user', text: 'old', modality: 'text', timestamp: 't' }]))
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })

    expect(store.getEntries().map((e) => e.text)).toEqual(['old'])
    expect(fs.existsSync(path.join(dir, 'simple-conversation', `${GATEWAY}.json`))).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
    // A thread that later takes the gateway role starts with its own log.
    expect(store.getEntries('next-gateway')).toEqual([])
    store.shutdown()
  })

  it('drops a deleted thread’s entries and file', async () => {
    const dir = makeTmpDir()
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    await store.open('gone')
    bus.emit({ type: 'chat.message.sent', timestamp: 'x', source: 'chat', payload: { threadId: 'gone', text: 'bye' } })
    store.shutdown()
    const file = path.join(dir, 'simple-conversation', 'gone.json')
    expect(fs.existsSync(file)).toBe(true)

    const bus2 = makeBus()
    const store2 = createSimpleConversation({ bus: bus2, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    bus2.emit({ type: 'thread.deleted', timestamp: 'z', source: 'threads', payload: { threadId: 'gone' } })
    expect(fs.existsSync(file)).toBe(false)
    expect(store2.getEntries('gone')).toEqual([])
    store2.shutdown()
  })

  it('never names a file after an id that is not a plain thread id', async () => {
    const dir = makeTmpDir()
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }), dataDir: dir })
    bus.emit({
      type: 'chat.message.sent',
      timestamp: 'x',
      source: 'chat',
      payload: { threadId: '../escape', text: 'x' }
    })
    store.shutdown()
    expect(fs.readdirSync(dir).filter((f) => f !== 'simple-conversation')).toEqual([])
    expect(fs.existsSync(path.join(dir, '..', 'escape.json'))).toBe(false)
  })
})
