import { describe, it, expect } from 'vitest'
import { createAskUserQuestionStore } from './ask-user-question-store.js'
import type { AskUserQuestionInput, EventBus } from '@sovereign/core'

function stubBus(): EventBus & { events: any[] } {
  const events: any[] = []
  return {
    events,
    emit: (e: any) => {
      events.push(e)
    },
    on: () => () => {},
    off: () => {}
  } as any
}

const sampleInput: AskUserQuestionInput = {
  questions: [
    {
      question: 'Ship it?',
      header: 'Ship?',
      multiSelect: false,
      options: [
        { label: 'Yes', description: 'Ship now' },
        { label: 'No', description: 'Hold' }
      ]
    }
  ]
}

describe('AskUserQuestionStore', () => {
  it('resolves the register() promise with the answer submitted through submit()', async () => {
    const store = createAskUserQuestionStore()
    const promise = store.register('thread-1', 'tool-abc', sampleInput)
    // Give the microtask a tick so the pending entry lands.
    await Promise.resolve()

    expect(store.listPending('thread-1')).toHaveLength(1)
    const ok = store.submit('tool-abc', {
      questions: sampleInput.questions,
      answers: { 'Ship it?': 'Yes' }
    })
    expect(ok).toBe(true)

    const result = await promise
    expect(result.kind).toBe('sovereign:ask-user-question')
    expect(result.answers).toEqual({ 'Ship it?': 'Yes' })
    expect(typeof result.answeredAt).toBe('number')
    expect(store.listPending('thread-1')).toHaveLength(0)
  })

  it('emits question.pending / question.answered on the bus with full entry payloads', async () => {
    const bus = stubBus()
    const store = createAskUserQuestionStore(bus)
    const promise = store.register('thread-1', 'tool-abc', sampleInput)
    await Promise.resolve()
    store.submit('tool-abc', { questions: sampleInput.questions, answers: { 'Ship it?': 'Yes' } })
    await promise

    const types = bus.events.map((e) => e.type)
    expect(types).toEqual(['question.pending', 'question.answered'])
    expect(bus.events[0].payload.toolCallId).toBe('tool-abc')
    expect(bus.events[1].payload.result.answers).toEqual({ 'Ship it?': 'Yes' })
  })

  it('submit() returns false for an unknown toolCallId', () => {
    const store = createAskUserQuestionStore()
    expect(store.submit('nope', { questions: [], answers: {} })).toBe(false)
  })

  it('abort() rejects the outstanding promise + emits question.aborted', async () => {
    const bus = stubBus()
    const store = createAskUserQuestionStore(bus)
    const promise = store.register('thread-1', 'tool-abc', sampleInput)
    await Promise.resolve()
    store.abort('tool-abc', 'user cancelled')
    await expect(promise).rejects.toThrow(/user cancelled/)
    expect(bus.events.map((e) => e.type)).toEqual(['question.pending', 'question.aborted'])
  })

  it('re-registering the same toolCallId supersedes the previous entry', async () => {
    const store = createAskUserQuestionStore()
    const first = store.register('thread-1', 'tool-abc', sampleInput)
    await Promise.resolve()
    const second = store.register('thread-1', 'tool-abc', sampleInput)
    await Promise.resolve()
    await expect(first).rejects.toThrow(/superseded/)
    expect(store.listPending('thread-1')).toHaveLength(1)
    store.submit('tool-abc', { questions: sampleInput.questions, answers: { 'Ship it?': 'Yes' } })
    await expect(second).resolves.toBeDefined()
  })

  it('listPending() filters by threadId and orders oldest first', async () => {
    const store = createAskUserQuestionStore()
    void store.register('thread-a', 'tool-1', sampleInput)
    await new Promise((r) => setTimeout(r, 2))
    void store.register('thread-b', 'tool-2', sampleInput)
    await new Promise((r) => setTimeout(r, 2))
    void store.register('thread-a', 'tool-3', sampleInput)
    const inA = store.listPending('thread-a').map((e) => e.toolCallId)
    expect(inA).toEqual(['tool-1', 'tool-3'])
    const all = store.listPending().map((e) => e.toolCallId)
    expect(all).toEqual(['tool-1', 'tool-2', 'tool-3'])
  })
})
