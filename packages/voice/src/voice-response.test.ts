import { describe, it, expect, vi } from 'vitest'
import { createVoiceResponse } from './voice-response.js'
import type { VoiceResponseDeps, LlmCompleter, VoiceResponseConfig } from './voice-response.js'
import type { EventBus, BusEvent } from '@sovereign/core'

// --- Helpers ---

function createMockBus(): EventBus {
  const handlers = new Map<string, Array<(e: BusEvent) => void>>()
  return {
    emit: vi.fn((event: BusEvent) => {
      for (const [pattern, fns] of handlers) {
        if (event.type === pattern || pattern === '*') {
          for (const fn of fns) fn(event)
        }
      }
    }),
    on: vi.fn((pattern: string, handler: (e: BusEvent) => void) => {
      if (!handlers.has(pattern)) handlers.set(pattern, [])
      handlers.get(pattern)!.push(handler)
      return () => {
        const arr = handlers.get(pattern)
        if (arr) {
          const idx = arr.indexOf(handler)
          if (idx >= 0) arr.splice(idx, 1)
        }
      }
    }),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus
}

/** Drain the microtask queue across several macrotask ticks — enough for
 *  the ack/summary pipelines' chained awaits (getRecentTurns → llm.complete
 *  → synthesize) to settle before assertions run. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function createDeps(): {
  deps: VoiceResponseDeps
  bus: EventBus
  sendToDeviceName: ReturnType<typeof vi.fn>
  getDeviceName: ReturnType<typeof vi.fn>
} {
  const bus = createMockBus()
  const sendToDeviceName = vi.fn()
  const getDeviceName = vi.fn((_deviceId: string): string | undefined => undefined)
  const synthesize = vi.fn(async (_text: string) => ({ audio: Buffer.from('fake-audio'), durationMs: 10 }))
  const llm: LlmCompleter = {
    complete: vi.fn(async () => ({ choices: [{ message: { content: 'Spoken text.' } }] }))
  }
  const getRecentTurns = vi.fn(async () => [])
  const config = vi.fn((): VoiceResponseConfig => ({ autoTts: true, ttsUrl: 'http://tts.local', ackDelayMs: 0 }))

  const deps: VoiceResponseDeps = {
    bus,
    synthesize,
    llm,
    getRecentTurns,
    sendToDeviceName,
    getDeviceName,
    config
  }
  return { deps, bus, sendToDeviceName, getDeviceName }
}

function emitMessageSent(bus: EventBus, payload: Record<string, unknown>): void {
  bus.emit({ type: 'chat.message.sent', timestamp: new Date().toISOString(), source: 'chat', payload })
}

function emitTurnCompleted(bus: EventBus, payload: Record<string, unknown>): void {
  bus.emit({ type: 'chat.turn.completed', timestamp: new Date().toISOString(), source: 'chat', payload })
}

// --- Tests ---

describe('voice response — device-name routing', () => {
  it('routes the ack pipeline via sendToDeviceName using the live wsHandler-known name', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockImplementation((deviceId: string) => (deviceId === 'dev-1' ? 'Josh Phone' : undefined))
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'turn the lights on',
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    await flush()

    const pendingCall = sendToDeviceName.mock.calls.find(([, msg]: any[]) => msg.type === 'voice.ack.pending')
    const audioCall = sendToDeviceName.mock.calls.find(([, msg]: any[]) => msg.type === 'voice.tts.audio')
    expect(pendingCall?.[0]).toBe('Josh Phone')
    expect(audioCall?.[0]).toBe('Josh Phone')
    expect(audioCall?.[1]).toMatchObject({ kind: 'ack', threadId: 't1' })

    vr.shutdown()
  })

  it('falls back to origin.deviceName when the wsHandler carries no live name yet', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockReturnValue(undefined) // simulates the ws.device-name announcement racing behind the HTTP send
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'turn the lights on',
      origin: { modality: 'voice', deviceId: 'dev-1', deviceName: 'Josh Phone' }
    })
    await flush()

    const audioCall = sendToDeviceName.mock.calls.find(([, msg]: any[]) => msg.type === 'voice.tts.audio')
    expect(audioCall?.[0]).toBe('Josh Phone')

    vr.shutdown()
  })

  it('skips routing and logs a warning when no device name resolves from either source', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockReturnValue(undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'turn the lights on',
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    await flush()

    expect(sendToDeviceName).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no device name'))

    warnSpy.mockRestore()
    vr.shutdown()
  })

  it('ignores non-voice-originated messages entirely', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockReturnValue('Josh Phone')
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, { threadId: 't1', text: 'a typed message', origin: { modality: 'text', deviceId: 'dev-1' } })
    await flush()

    expect(sendToDeviceName).not.toHaveBeenCalled()
    vr.shutdown()
  })

  // The regression this whole feature fixes: a page refresh mints a fresh
  // deviceId, so the wsHandler forgets the old deviceId → name mapping by
  // the time the assistant turn completes. The summary pipeline must still
  // reach the tab because it routes off the deviceName captured when the
  // voice message entered — never re-resolved from the (now stale) deviceId.
  it('routes the summary pipeline to the deviceName captured at message time, surviving a mid-turn deviceId change', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockImplementation((deviceId: string) => (deviceId === 'dev-1' ? 'Josh Phone' : undefined))
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'turn the lights on',
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    await flush()
    sendToDeviceName.mockClear()

    // Simulate the refresh: the old connection drops, so its deviceId no
    // longer resolves to a name. A real refresh also mints a new deviceId
    // for the reconnecting tab, but the pending-voice origin never looks
    // that up again — it already holds the captured name.
    getDeviceName.mockReturnValue(undefined)

    emitTurnCompleted(bus, { threadId: 't1', turn: { role: 'assistant', content: 'Done — lights on.' } })
    await flush()

    const pendingCall = sendToDeviceName.mock.calls.find(([, msg]: any[]) => msg.type === 'voice.summary.pending')
    const audioCall = sendToDeviceName.mock.calls.find(([, msg]: any[]) => msg.type === 'voice.tts.audio')
    expect(pendingCall?.[0]).toBe('Josh Phone')
    expect(audioCall?.[0]).toBe('Josh Phone')
    expect(audioCall?.[1]).toMatchObject({ kind: 'summary', threadId: 't1' })

    vr.shutdown()
  })

  it('emits presence.reply with the summary text for the simple conversation log', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockReturnValue('Josh Phone')
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'check the deploy',
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    await flush()
    ;(bus.emit as ReturnType<typeof vi.fn>).mockClear()

    emitTurnCompleted(bus, { threadId: 't1', turn: { role: 'assistant', content: 'All services healthy.' } })
    await flush()

    const replyEvents = (bus.emit as ReturnType<typeof vi.fn>).mock.calls
      .map(([e]: any) => e)
      .filter((e: BusEvent) => e.type === 'presence.reply')
    expect(replyEvents).toHaveLength(1)
    expect(replyEvents[0].payload).toEqual({ modality: 'voice', text: 'Spoken text.' })
    expect(replyEvents[0].source).toBe('voice-response')

    vr.shutdown()
  })

  it('clears the pending voice origin after the summary fires (one-shot per message)', async () => {
    const { deps, bus, sendToDeviceName, getDeviceName } = createDeps()
    getDeviceName.mockReturnValue('Josh Phone')
    const vr = createVoiceResponse(deps)

    emitMessageSent(bus, {
      threadId: 't1',
      text: 'turn the lights on',
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    await flush()
    emitTurnCompleted(bus, { threadId: 't1', turn: { role: 'assistant', content: 'Done — lights on.' } })
    await flush()
    sendToDeviceName.mockClear()

    // A second completion for the same thread without a new voice message
    // finds no pending origin — the summary pipeline must not fire again.
    emitTurnCompleted(bus, { threadId: 't1', turn: { role: 'assistant', content: 'A follow-up turn.' } })
    await flush()

    expect(sendToDeviceName).not.toHaveBeenCalled()
    vr.shutdown()
  })
})
