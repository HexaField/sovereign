import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createPrPollService, type PrPollService } from './pr-poll.js'
import { createTaskService, type TaskService } from './service.js'
import { createInMemoryTaskStore } from './store.js'
import type { TaskProvider } from './types.js'

// ── Test helpers ────────────────────────────────────────────────────────

function makeBus() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  const events: Array<{ type: string; payload: unknown }> = []
  const bus = {
    emit(event: { type: string; timestamp: string; source: string; payload: unknown }) {
      events.push({ type: event.type, payload: event.payload })
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
  return { bus: bus as any, events }
}

/** Build a mock gh CLI response matching the shape fetchPrState expects. */
function ghPrResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ state: 'COMPLETED', conclusion: 'SUCCESS' }],
    title: 'Add widget feature',
    headRefName: 'feat/widget',
    comments: [],
    url: 'https://github.com/org/repo/pull/42',
    ...overrides
  })
}

function makeExecFn(stdoutOrError: string | Error = ghPrResponse()) {
  return vi.fn().mockImplementation(async () => {
    if (stdoutOrError instanceof Error) throw stdoutOrError
    return { stdout: stdoutOrError }
  })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('PrPollService — importPr', () => {
  let taskService: TaskService
  let pollService: PrPollService
  let sentMessages: Array<{ threadId: string; text: string }>
  let execFn: ReturnType<typeof makeExecFn>

  beforeEach(() => {
    const { bus } = makeBus()
    taskService = createTaskService({ store: createInMemoryTaskStore(), bus })
    sentMessages = []
    execFn = makeExecFn()

    pollService = createPrPollService({
      taskService,
      bus,
      sendToThread: async (threadId, text) => {
        sentMessages.push({ threadId, text })
      },
      execFn
    })
  })

  it('creates a task with provider metadata from the PR', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      sourceThreadId: 'thread-1'
    })

    expect(task.name).toBe('PR #42: Add widget feature')
    expect(task.state).toBe('in_progress')
    expect(task.provider).toBeDefined()
    expect(task.provider!.kind).toBe('github-pr')
    expect(task.provider!.repo).toBe('org/repo')
    expect(task.provider!.number).toBe(42)
    expect(task.provider!.prStatus).toBe('open')
    expect(task.provider!.checksStatus).toBe('passing')
    expect(task.provider!.reviewDecision).toBe('review_required')
    expect(task.provider!.url).toBe('https://github.com/org/repo/pull/42')
    expect(task.tags).toContain('github-pr')
  })

  it('assigns the task to a thread when threadId provided', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 'thread-1'
    })

    expect(task.threadId).toBe('my-thread')
  })

  it('sends initial prompt to assigned thread', async () => {
    await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      prompt: 'Review this PR and address any issues.',
      sourceThreadId: 'thread-1'
    })

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].threadId).toBe('my-thread')
    expect(sentMessages[0].text).toBe('Review this PR and address any issues.')
  })

  it('sends default prompt when no explicit prompt provided and thread assigned', async () => {
    await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 'thread-1'
    })

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].threadId).toBe('my-thread')
    expect(sentMessages[0].text).toContain('[PR #42]')
    expect(sentMessages[0].text).toContain('Add widget feature')
    expect(sentMessages[0].text).toContain('feat/widget')
    expect(sentMessages[0].text).toContain('imported into your task list')
    pollService.dispose()
  })

  it('sends contextual default prompt when CI failing', async () => {
    const failExec = makeExecFn(
      ghPrResponse({
        statusCheckRollup: [{ state: 'COMPLETED', conclusion: 'FAILURE' }]
      })
    )
    const failPoll = createPrPollService({
      taskService,
      bus: makeBus().bus,
      sendToThread: async (threadId, text) => {
        sentMessages.push({ threadId, text })
      },
      execFn: failExec
    })

    await failPoll.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 'thread-1'
    })

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].text).toContain('CI checks have failed')
    expect(sentMessages[0].text).toContain('gh pr checks')
    failPoll.dispose()
  })

  it('starts polling after import', async () => {
    await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      sourceThreadId: 'thread-1'
    })

    expect(pollService.activeCount()).toBe(1)
    pollService.dispose()
  })

  it('wires parent tasks when parentTaskIds provided', async () => {
    const parent = await taskService.create({ name: 'Parent', sourceThreadId: 't1' })
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      parentTaskIds: [parent.id],
      sourceThreadId: 'thread-1'
    })

    expect(task.parentTasks).toHaveLength(1)
    expect(task.parentTasks[0].id).toBe(parent.id)
    pollService.dispose()
  })

  it('throws when gh CLI fetch fails', async () => {
    const failExec = makeExecFn(new Error('gh: not found'))
    const failPoll = createPrPollService({
      taskService,
      bus: makeBus().bus,
      sendToThread: async () => {},
      execFn: failExec
    })

    await expect(failPoll.importPr({ repo: 'org/repo', pr: 99, sourceThreadId: 't1' })).rejects.toThrow(
      'Failed to fetch PR #99'
    )
  })

  it('handles draft PRs', async () => {
    const draftExec = makeExecFn(ghPrResponse({ isDraft: true }))
    const draftPoll = createPrPollService({
      taskService,
      bus: makeBus().bus,
      sendToThread: async () => {},
      execFn: draftExec
    })

    const task = await draftPoll.importPr({
      repo: 'org/repo',
      pr: 10,
      sourceThreadId: 't1'
    })

    expect(task.provider!.prStatus).toBe('draft')
    draftPoll.dispose()
  })
})

describe('PrPollService — pollOnce', () => {
  let taskService: TaskService
  let pollService: PrPollService
  let sentMessages: Array<{ threadId: string; text: string }>
  let execFn: ReturnType<typeof makeExecFn>

  beforeEach(async () => {
    const { bus } = makeBus()
    taskService = createTaskService({ store: createInMemoryTaskStore(), bus })
    sentMessages = []
    execFn = makeExecFn()

    pollService = createPrPollService({
      taskService,
      bus,
      sendToThread: async (threadId, text) => {
        sentMessages.push({ threadId, text })
      },
      execFn
    })
  })

  it('updates provider when CI status changes', async () => {
    // Import with passing CI
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 't1'
    })
    pollService.dispose() // Stop interval polling

    // Next poll returns failing CI
    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({
        statusCheckRollup: [{ state: 'COMPLETED', conclusion: 'FAILURE' }]
      })
    }))

    await pollService.pollOnce(task.id)

    const updated = await taskService.get(task.id)
    expect(updated!.provider!.checksStatus).toBe('failing')
    expect(sentMessages.some((m) => m.text.includes('CI check failed'))).toBe(true)
  })

  it('marks task completed when PR merges', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 't1'
    })
    pollService.dispose()

    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({ state: 'MERGED' })
    }))

    await pollService.pollOnce(task.id)

    const updated = await taskService.get(task.id)
    expect(updated!.state).toBe('completed')
    expect(updated!.provider!.prStatus).toBe('merged')
    expect(sentMessages.some((m) => m.text.includes('Merged'))).toBe(true)
  })

  it('marks task cancelled when PR closed without merge', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 't1'
    })
    pollService.dispose()

    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({ state: 'CLOSED' })
    }))

    await pollService.pollOnce(task.id)

    const updated = await taskService.get(task.id)
    expect(updated!.state).toBe('cancelled')
    expect(updated!.provider!.prStatus).toBe('closed')
  })

  it('notifies thread on review changes requested', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 't1'
    })
    pollService.dispose()

    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({ reviewDecision: 'CHANGES_REQUESTED' })
    }))

    await pollService.pollOnce(task.id)
    expect(sentMessages.some((m) => m.text.includes('Changes requested'))).toBe(true)
  })

  it('notifies thread on new comments', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      threadId: 'my-thread',
      sourceThreadId: 't1'
    })
    pollService.dispose()

    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({ comments: [{ body: 'fix this' }, { body: 'also this' }] })
    }))

    await pollService.pollOnce(task.id)
    expect(sentMessages.some((m) => m.text.includes('2 new comment'))).toBe(true)
  })

  it('skips tick gracefully when gh CLI fails', async () => {
    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      sourceThreadId: 't1'
    })
    pollService.dispose()

    execFn.mockImplementation(async () => {
      throw new Error('network timeout')
    })

    // Should not throw
    await pollService.pollOnce(task.id)

    // Task remains unchanged
    const updated = await taskService.get(task.id)
    expect(updated!.state).toBe('in_progress')
  })
})

describe('PrPollService — bootstrap', () => {
  it('starts polls for existing PR-tasks in active states', async () => {
    const { bus } = makeBus()
    const taskService = createTaskService({ store: createInMemoryTaskStore(), bus })
    const execFn = makeExecFn()

    // Create a PR task manually (simulating prior import)
    const task = await taskService.create({
      name: 'PR #10: Old PR',
      sourceThreadId: 't1',
      provider: {
        kind: 'github-pr',
        url: 'https://github.com/org/repo/pull/10',
        repo: 'org/repo',
        number: 10,
        prStatus: 'open',
        checksStatus: 'pending',
        reviewDecision: 'unknown',
        lastPolledAt: new Date().toISOString(),
        unresolvedComments: 0
      } as TaskProvider
    })
    await taskService.update(task.id, { state: 'in_progress', sourceThreadId: 't1' })

    const pollService = createPrPollService({
      taskService,
      bus,
      sendToThread: async () => {},
      execFn
    })

    await pollService.bootstrap()
    expect(pollService.activeCount()).toBe(1)
    pollService.dispose()
  })

  it('skips completed PR-tasks on bootstrap', async () => {
    const { bus } = makeBus()
    const taskService = createTaskService({ store: createInMemoryTaskStore(), bus })

    const task = await taskService.create({
      name: 'PR #11: Done PR',
      sourceThreadId: 't1',
      provider: {
        kind: 'github-pr',
        url: 'https://github.com/org/repo/pull/11',
        repo: 'org/repo',
        number: 11,
        prStatus: 'merged',
        checksStatus: 'passing',
        reviewDecision: 'approved',
        lastPolledAt: new Date().toISOString(),
        unresolvedComments: 0
      } as TaskProvider
    })
    await taskService.update(task.id, { state: 'completed', sourceThreadId: 't1' })

    const pollService = createPrPollService({
      taskService,
      bus: makeBus().bus,
      sendToThread: async () => {},
      execFn: makeExecFn()
    })

    await pollService.bootstrap()
    expect(pollService.activeCount()).toBe(0)
    pollService.dispose()
  })
})

describe('PrPollService — provider event', () => {
  it('emits task.provider_updated on provider change', async () => {
    const { bus, events } = makeBus()
    const taskService = createTaskService({ store: createInMemoryTaskStore(), bus })
    const execFn = makeExecFn()

    const pollService = createPrPollService({
      taskService,
      bus,
      sendToThread: async () => {},
      execFn
    })

    const task = await pollService.importPr({
      repo: 'org/repo',
      pr: 42,
      sourceThreadId: 't1'
    })
    pollService.dispose()

    // Change CI status on next poll
    execFn.mockImplementation(async () => ({
      stdout: ghPrResponse({
        statusCheckRollup: [{ state: 'COMPLETED', conclusion: 'FAILURE' }]
      })
    }))

    await pollService.pollOnce(task.id)

    const providerEvents = events.filter((e) => e.type === 'task.provider_updated')
    expect(providerEvents.length).toBeGreaterThan(0)
  })
})
