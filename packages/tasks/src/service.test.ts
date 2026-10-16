import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTaskService, type TaskService } from './service.js'
import { createInMemoryTaskStore, createResilientTaskStore, type TaskStore } from './store.js'
import type { ChangeProvider, TaskEventPayload, TaskState } from './types.js'
import { cleanupTempDirs, createFakeAd4m, quietLog, tempDir } from './testing/helpers.js'

// ── Test bus ──────────────────────────────────────────────────────────

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

// ── T1: CRUD + link management ───────────────────────────────────────

describe('TaskService — CRUD', () => {
  let svc: TaskService
  let events: Array<{ type: string; payload: unknown }>

  beforeEach(() => {
    const { bus, events: e } = makeBus()
    events = e
    svc = createTaskService({ store: createInMemoryTaskStore(), bus })
  })

  // T1.1: Create a task with autoAssign=true
  it('creates a task with autoAssign=true and state=pending', async () => {
    const task = await svc.create({
      name: 'Build auth module',
      sourceThreadId: 'thread-1'
    })
    expect(task.id).toMatch(/^task:\/\//)
    expect(task.name).toBe('Build auth module')
    expect(task.state).toBe('pending')
    expect(task.threadId).toBe('thread-1')
    expect(task.createdAt).toBeTruthy()
    expect(task.parentTasks).toEqual([])
    expect(task.childTasks).toEqual([])
  })

  // T1.2: Create a task with autoAssign=false
  it('creates an unassigned task when autoAssign=false', async () => {
    const task = await svc.create({
      name: 'Unassigned work',
      autoAssign: false,
      sourceThreadId: 'thread-1'
    })
    expect(task.threadId).toBeNull()
  })

  // T1.3: Create with parent links
  it('creates a task with parent links (bidirectional)', async () => {
    const parent = await svc.create({ name: 'Parent', sourceThreadId: 't1' })
    const child = await svc.create({
      name: 'Child',
      parentTaskIds: [parent.id],
      sourceThreadId: 't1'
    })
    expect(child.parentTasks).toHaveLength(1)
    expect(child.parentTasks[0].id).toBe(parent.id)

    // Parent should also reference the child
    const parentFull = await svc.get(parent.id)
    expect(parentFull?.childTasks).toHaveLength(1)
    expect(parentFull?.childTasks[0].id).toBe(child.id)
  })

  // T1.4: Create with tags
  it('creates a task with tags', async () => {
    const task = await svc.create({
      name: 'Tagged task',
      tags: ['auth', 'backend'],
      sourceThreadId: 't1'
    })
    expect(task.tags).toEqual(['auth', 'backend'])
  })

  // T1.5: Get returns null for absent task
  it('returns null for nonexistent task', async () => {
    const result = await svc.get('task://nonexistent')
    expect(result).toBeNull()
  })

  // T1.6: Update state
  it('updates task state and emits task.state_changed', async () => {
    const task = await svc.create({ name: 'T', sourceThreadId: 't1' })
    const updated = await svc.update(task.id, { state: 'in_progress', sourceThreadId: 't1' })
    expect(updated.state).toBe('in_progress')
    expect(updated.updatedAt).toBeTruthy()

    const stateEvent = events.find((e) => e.type === 'task.state_changed')
    expect(stateEvent).toBeTruthy()
    const p = stateEvent!.payload as TaskEventPayload
    expect(p.oldState).toBe('pending')
    expect(p.newState).toBe('in_progress')
  })

  // T1.7: Update threadId (reassign)
  it('emits task.reassigned when threadId changes', async () => {
    const task = await svc.create({ name: 'T', sourceThreadId: 't1' })
    await svc.update(task.id, { threadId: 't2', sourceThreadId: 't1' })

    const reassignEvent = events.find((e) => e.type === 'task.reassigned')
    expect(reassignEvent).toBeTruthy()
    const p = reassignEvent!.payload as TaskEventPayload
    expect(p.oldThreadId).toBe('t1')
    expect(p.newThreadId).toBe('t2')
  })

  // T1.8: Update transientState
  it('emits task.transient_updated when transientState changes', async () => {
    const task = await svc.create({ name: 'T', sourceThreadId: 't1' })
    await svc.update(task.id, { transientState: 'running tests', sourceThreadId: 't1' })

    const transientEvent = events.find((e) => e.type === 'task.transient_updated')
    expect(transientEvent).toBeTruthy()
    const p = transientEvent!.payload as TaskEventPayload
    expect(p.transientState).toBe('running tests')
  })

  // T1.9: Update with no meaningful change emits task.updated
  it('emits task.updated for non-specific changes', async () => {
    const task = await svc.create({ name: 'T', sourceThreadId: 't1' })
    events.length = 0
    await svc.update(task.id, { description: 'Updated desc', sourceThreadId: 't1' })

    const updateEvent = events.find((e) => e.type === 'task.updated')
    expect(updateEvent).toBeTruthy()
  })

  // T1.10: Update throws on invalid state
  it('throws on invalid state value', async () => {
    const task = await svc.create({ name: 'T', sourceThreadId: 't1' })
    await expect(svc.update(task.id, { state: 'invalid' as TaskState, sourceThreadId: 't1' })).rejects.toThrow(
      'Invalid task state'
    )
  })

  // T1.11: Update throws on absent task
  it('throws when updating a nonexistent task', async () => {
    await expect(svc.update('task://nope', { name: 'X', sourceThreadId: 't1' })).rejects.toThrow('Task not found')
  })
})

describe('TaskService — list + filter', () => {
  let svc: TaskService

  beforeEach(() => {
    const { bus } = makeBus()
    svc = createTaskService({ store: createInMemoryTaskStore(), bus })
  })

  it('lists all tasks', async () => {
    await svc.create({ name: 'A', sourceThreadId: 't1' })
    await svc.create({ name: 'B', sourceThreadId: 't2' })
    const list = await svc.list()
    expect(list).toHaveLength(2)
  })

  it('filters by state', async () => {
    const t = await svc.create({ name: 'A', sourceThreadId: 't1' })
    await svc.update(t.id, { state: 'in_progress', sourceThreadId: 't1' })
    await svc.create({ name: 'B', sourceThreadId: 't1' })

    const inProgress = await svc.list({ state: 'in_progress' })
    expect(inProgress).toHaveLength(1)
    expect(inProgress[0].name).toBe('A')
  })

  it('filters by threadId', async () => {
    await svc.create({ name: 'A', sourceThreadId: 't1' })
    await svc.create({ name: 'B', sourceThreadId: 't2' })
    const t1Tasks = await svc.list({ threadId: 't1' })
    expect(t1Tasks).toHaveLength(1)
    expect(t1Tasks[0].name).toBe('A')
  })

  it('filters for unassigned (threadId=null)', async () => {
    await svc.create({ name: 'Assigned', sourceThreadId: 't1' })
    await svc.create({ name: 'Unassigned', autoAssign: false, sourceThreadId: 't1' })
    const unassigned = await svc.list({ threadId: null })
    expect(unassigned).toHaveLength(1)
    expect(unassigned[0].name).toBe('Unassigned')
  })

  it('filters rootsOnly', async () => {
    const root = await svc.create({ name: 'Root', sourceThreadId: 't1' })
    await svc.create({ name: 'Child', parentTaskIds: [root.id], sourceThreadId: 't1' })
    const roots = await svc.list({ rootsOnly: true })
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('Root')
  })

  it('filters by parentId', async () => {
    const root = await svc.create({ name: 'Root', sourceThreadId: 't1' })
    await svc.create({ name: 'Child1', parentTaskIds: [root.id], sourceThreadId: 't1' })
    await svc.create({ name: 'Child2', parentTaskIds: [root.id], sourceThreadId: 't1' })
    await svc.create({ name: 'Orphan', sourceThreadId: 't1' })

    const children = await svc.list({ parentId: root.id })
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.name).sort()).toEqual(['Child1', 'Child2'])
  })
})

// ── T2: Link management + cycle detection ────────────────────────────

describe('TaskService — links', () => {
  let svc: TaskService
  let events: Array<{ type: string; payload: unknown }>

  beforeEach(() => {
    const { bus, events: e } = makeBus()
    events = e
    svc = createTaskService({ store: createInMemoryTaskStore(), bus })
  })

  it('links parent ↔ child bidirectionally', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    const b = await svc.create({ name: 'B', sourceThreadId: 't1' })
    await svc.link(a.id, b.id, 't1')

    const aFull = await svc.get(a.id)
    const bFull = await svc.get(b.id)
    expect(aFull?.childTasks).toHaveLength(1)
    expect(bFull?.parentTasks).toHaveLength(1)

    const linkEvent = events.find((e) => e.type === 'task.linked')
    expect(linkEvent).toBeTruthy()
  })

  it('unlinks and emits task.unlinked', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    const b = await svc.create({ name: 'B', sourceThreadId: 't1' })
    await svc.link(a.id, b.id, 't1')
    await svc.unlink(a.id, b.id, 't1')

    const aFull = await svc.get(a.id)
    expect(aFull?.childTasks).toHaveLength(0)

    const unlinkEvent = events.find((e) => e.type === 'task.unlinked')
    expect(unlinkEvent).toBeTruthy()
  })

  // T2.1: Self-link rejection
  it('rejects self-link', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    await expect(svc.link(a.id, a.id, 't1')).rejects.toThrow('Cannot link a task to itself')
  })

  // T2.2: Direct cycle rejection (A→B, B→A)
  it('rejects direct cycle', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    const b = await svc.create({ name: 'B', sourceThreadId: 't1' })
    await svc.link(a.id, b.id, 't1')
    await expect(svc.link(b.id, a.id, 't1')).rejects.toThrow('Cycle detected')
  })

  // T2.3: Transitive cycle rejection (A→B→C, C→A)
  it('rejects transitive cycle', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    const b = await svc.create({ name: 'B', sourceThreadId: 't1' })
    const c = await svc.create({ name: 'C', sourceThreadId: 't1' })
    await svc.link(a.id, b.id, 't1')
    await svc.link(b.id, c.id, 't1')
    await expect(svc.link(c.id, a.id, 't1')).rejects.toThrow('Cycle detected')
  })

  // T2.4: Diamond DAG (allowed — A→B, A→C, B→D, C→D — not a cycle)
  it('allows diamond DAG without cycle', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    const b = await svc.create({ name: 'B', sourceThreadId: 't1' })
    const c = await svc.create({ name: 'C', sourceThreadId: 't1' })
    const d = await svc.create({ name: 'D', sourceThreadId: 't1' })
    await svc.link(a.id, b.id, 't1')
    await svc.link(a.id, c.id, 't1')
    await svc.link(b.id, d.id, 't1')
    // C→D should succeed (diamond, not cycle)
    await expect(svc.link(c.id, d.id, 't1')).resolves.not.toThrow()

    const dFull = await svc.get(d.id)
    expect(dFull?.parentTasks).toHaveLength(2)
  })

  it('throws on link to nonexistent parent', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    await expect(svc.link('task://nope', a.id, 't1')).rejects.toThrow('Parent task not found')
  })

  it('throws on link to nonexistent child', async () => {
    const a = await svc.create({ name: 'A', sourceThreadId: 't1' })
    await expect(svc.link(a.id, 'task://nope', 't1')).rejects.toThrow('Child task not found')
  })
})

// ── T3: Summary ──────────────────────────────────────────────────────

describe('TaskService — summary', () => {
  let svc: TaskService

  beforeEach(() => {
    const { bus } = makeBus()
    svc = createTaskService({ store: createInMemoryTaskStore(), bus })
  })

  it('returns inFlight tasks (pending + in_progress)', async () => {
    await svc.create({ name: 'Pending', sourceThreadId: 'th1' })
    const t2 = await svc.create({ name: 'Active', sourceThreadId: 'th2' })
    await svc.update(t2.id, { state: 'in_progress', sourceThreadId: 'th2' })
    const t3 = await svc.create({ name: 'Done', sourceThreadId: 'th3' })
    await svc.update(t3.id, { state: 'completed', sourceThreadId: 'th3' })

    const summary = await svc.summary()
    expect(summary.inFlight).toHaveLength(2)
    expect(summary.inFlight.map((t) => t.name).sort()).toEqual(['Active', 'Pending'])
  })

  it('returns recentlyCompleted tasks', async () => {
    const t = await svc.create({ name: 'Done', sourceThreadId: 'th1' })
    await svc.update(t.id, { state: 'completed', sourceThreadId: 'th1' })

    const summary = await svc.summary()
    expect(summary.recentlyCompleted).toHaveLength(1)
    expect(summary.recentlyCompleted[0].name).toBe('Done')
  })

  it('returns unassigned tasks', async () => {
    await svc.create({ name: 'Orphan', autoAssign: false, sourceThreadId: 'th1' })
    await svc.create({ name: 'Assigned', sourceThreadId: 'th1' })

    const summary = await svc.summary()
    expect(summary.unassigned).toHaveLength(1)
    expect(summary.unassigned[0].name).toBe('Orphan')
  })

  it('resolves thread labels when resolveLabel provided', async () => {
    await svc.create({ name: 'T', sourceThreadId: 'th1' })

    const labels: Record<string, string> = { th1: 'main-thread' }
    const summary = await svc.summary((id) => labels[id])
    expect(summary.inFlight[0].threadLabel).toBe('main-thread')
  })
})

// ── Cross-thread bus event observability ─────────────────────────────

describe('TaskService — cross-thread event emission', () => {
  it('task.state_changed carries sourceThreadId distinct from task threadId', async () => {
    const { bus, events } = makeBus()
    const svc = createTaskService({ store: createInMemoryTaskStore(), bus })

    // Thread A creates and owns the task
    const task = await svc.create({ name: 'Feature', sourceThreadId: 'thread-A' })

    // Thread B updates the task (e.g. a review agent completing it)
    await svc.update(task.id, { state: 'completed', sourceThreadId: 'thread-B' })

    const stateEvent = events.find((e) => e.type === 'task.state_changed')
    expect(stateEvent).toBeTruthy()
    const p = stateEvent!.payload as TaskEventPayload
    expect(p.sourceThreadId).toBe('thread-B')
    expect(p.threadId).toBe('thread-A')
    expect(p.oldState).toBe('pending')
    expect(p.newState).toBe('completed')
  })

  it('task.created event emits for observation by any listener', async () => {
    const { bus, events } = makeBus()
    const svc = createTaskService({ store: createInMemoryTaskStore(), bus })

    await svc.create({ name: 'Observable', sourceThreadId: 'thread-X' })

    const createEvent = events.find((e) => e.type === 'task.created')
    expect(createEvent).toBeTruthy()
    const p = createEvent!.payload as TaskEventPayload
    expect(p.taskName).toBe('Observable')
    expect(p.sourceThreadId).toBe('thread-X')
  })

  it('task.linked and task.unlinked events fire with correct source', async () => {
    const { bus, events } = makeBus()
    const svc = createTaskService({ store: createInMemoryTaskStore(), bus })

    const parent = await svc.create({ name: 'Parent', sourceThreadId: 't1' })
    const child = await svc.create({ name: 'Child', sourceThreadId: 't1' })
    events.length = 0

    await svc.link(parent.id, child.id, 'linker-thread')
    const linkEvent = events.find((e) => e.type === 'task.linked')
    expect(linkEvent).toBeTruthy()
    expect((linkEvent!.payload as TaskEventPayload).sourceThreadId).toBe('linker-thread')

    events.length = 0
    await svc.unlink(parent.id, child.id, 'unlinker-thread')
    const unlinkEvent = events.find((e) => e.type === 'task.unlinked')
    expect(unlinkEvent).toBeTruthy()
    expect((unlinkEvent!.payload as TaskEventPayload).sourceThreadId).toBe('unlinker-thread')
  })
})

// ── T4: Provider (PR-Task Bridge) ───────────────────────────────────────

const changeProvider: ChangeProvider = {
  kind: 'change',
  refs: [{ forge: 'github', host: 'github.com', repo: 'org/repo', kind: 'change', id: '42' }],
  url: 'https://github.com/org/repo/pull/42',
  status: 'open',
  checksStatus: 'passing',
  reviewDecision: 'review_required',
  unresolvedComments: 0,
  lastPolledAt: '2026-09-15T00:00:00.000Z'
}

/** Run a suite against the in-memory store and the resilient store (fake AD4M up). */
const STORES: Array<[string, () => TaskStore]> = [
  ['in-memory store', () => createInMemoryTaskStore()],
  [
    'resilient store',
    () => {
      const ad4m = createFakeAd4m()
      return createResilientTaskStore({ dir: tempDir(), connect: ad4m.connect, snapshotDelayMs: 1, log: quietLog() })
    }
  ]
]

afterAll(cleanupTempDirs)

describe.each(STORES)('TaskService — provider (%s)', (_name, makeStore) => {
  let svc: TaskService
  let events: Array<{ type: string; payload: unknown }>

  beforeEach(() => {
    const { bus, events: e } = makeBus()
    events = e
    svc = createTaskService({ store: makeStore(), bus })
  })
  afterEach(() => svc.dispose())

  it('creates a task with provider metadata', async () => {
    const task = await svc.create({ name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    expect(task.provider).toEqual(changeProvider)
  })

  it('persists provider through get', async () => {
    const task = await svc.create({ name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    expect((await svc.get(task.id))!.provider).toEqual(changeProvider)
  })

  it('converts a legacy github-pr provider to a change provider', async () => {
    const task = await svc.create({
      name: 'PR #42',
      sourceThreadId: 't1',
      provider: {
        kind: 'github-pr',
        url: 'https://github.com/org/repo/pull/42',
        repo: 'org/repo',
        number: 42,
        prStatus: 'open',
        checksStatus: 'passing',
        reviewDecision: 'review_required',
        lastPolledAt: '2026-09-15T00:00:00.000Z',
        unresolvedComments: 0
      }
    })
    expect(task.provider).toEqual(changeProvider)
  })

  it('updates provider and emits task.provider_updated', async () => {
    const task = await svc.create({ name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    const updated = await svc.update(task.id, {
      provider: { ...changeProvider, checksStatus: 'failing' },
      sourceThreadId: 't1'
    })
    expect(updated.provider).toMatchObject({ kind: 'change', checksStatus: 'failing' })
    const providerEvent = events.find((e) => e.type === 'task.provider_updated')
    expect((providerEvent!.payload as TaskEventPayload).taskId).toBe(task.id)
  })

  it('includes the provider in list items', async () => {
    await svc.create({ name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].provider).toEqual(changeProvider)
  })

  it('omits provider from list items when task has no provider', async () => {
    await svc.create({ name: 'Plain task', sourceThreadId: 't1' })
    const list = await svc.list()
    expect(list[0].provider).toBeUndefined()
  })

  it('refuses a second task for the same provider key', async () => {
    await svc.create({ name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    await expect(svc.create({ name: 'again', sourceThreadId: 't1', provider: changeProvider })).rejects.toThrow(
      /already exists/
    )
    const other = await svc.create({ name: 'other', sourceThreadId: 't1' })
    await expect(svc.update(other.id, { provider: changeProvider, sourceThreadId: 't1' })).rejects.toThrow(
      /already exists/
    )
  })
})

describe.each(STORES)('TaskService — ensureTask (%s)', (_name, makeStore) => {
  let svc: TaskService
  let events: Array<{ type: string; payload: unknown }>
  const key = 'github:github.com/org/repo#42'

  beforeEach(() => {
    const { bus, events: e } = makeBus()
    events = e
    svc = createTaskService({ store: makeStore(), bus })
  })
  afterEach(() => svc.dispose())

  it('creates the task once and returns the same task afterwards', async () => {
    const first = await svc.ensureTask(key, { name: 'PR #42', sourceThreadId: 't1', provider: changeProvider })
    const second = await svc.ensureTask(key, { name: 'renamed', sourceThreadId: 't2', provider: changeProvider })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    expect(second.task.name).toBe('PR #42')
    expect(await svc.list()).toHaveLength(1)
    expect(events.filter((e) => e.type === 'task.created')).toHaveLength(1)
  })

  it('creates one task under concurrent calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.ensureTask(key, { name: 'PR', sourceThreadId: 't', provider: changeProvider })
      )
    )
    expect(new Set(results.map((r) => r.task.id)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await svc.list()).toHaveLength(1)
  })

  it('derives a plan provider from a plan key', async () => {
    const { task, created } = await svc.ensureTask('plan:sovereign/plans/forge.md', {
      name: 'Forge plan',
      sourceThreadId: 't1'
    })
    expect(created).toBe(true)
    expect(task.provider).toEqual({ kind: 'plan', project: 'sovereign', path: 'plans/forge.md', status: 'planned' })
    expect((await svc.ensureTask('plan:sovereign/plans/forge.md', { name: 'x', sourceThreadId: 't1' })).task.id).toBe(
      task.id
    )
  })

  it('needs a provider for an unknown forge key, and a matching one', async () => {
    await expect(svc.ensureTask(key, { name: 'x', sourceThreadId: 't' })).rejects.toThrow(/no provider/)
    await expect(
      svc.ensureTask('github:github.com/org/repo#43', { name: 'x', sourceThreadId: 't', provider: changeProvider })
    ).rejects.toThrow(/does not match/)
  })

  it('adds parent links on an existing task without duplicating them', async () => {
    const stream = await svc.createStream({ name: 'Stream', sourceThreadId: 't' })
    await svc.ensureTask(key, { name: 'PR', sourceThreadId: 't', provider: changeProvider })
    await svc.ensureTask(key, { name: 'PR', sourceThreadId: 't', provider: changeProvider, parentTaskIds: [stream.id] })
    const { task } = await svc.ensureTask(key, {
      name: 'PR',
      sourceThreadId: 't',
      provider: changeProvider,
      parentTaskIds: [stream.id]
    })
    expect(task.parentTasks.map((p) => p.id)).toEqual([stream.id])
  })

  it('finds a task by provider key', async () => {
    const { task } = await svc.ensureTask(key, { name: 'PR', sourceThreadId: 't', provider: changeProvider })
    expect((await svc.findByProviderKey(key))!.id).toBe(task.id)
    expect(await svc.findByProviderKey('github:github.com/org/repo#999')).toBeNull()
  })
})

describe.each(STORES)('TaskService — work streams and filters (%s)', (_name, makeStore) => {
  let svc: TaskService

  beforeEach(() => {
    svc = createTaskService({ store: makeStore(), bus: makeBus().bus })
  })
  afterEach(() => svc.dispose())

  async function seed() {
    const stream = await svc.createStream({ name: 'Plan 20', membrane: 'coasys', sourceThreadId: 't' })
    const sub = await svc.createStream({
      name: 'Plan 20 — SFU',
      membrane: 'coasys',
      parentStreamIds: [stream.id],
      sourceThreadId: 't'
    })
    const pr = await svc.create({ name: 'PR', membrane: 'coasys', provider: changeProvider, sourceThreadId: 't' })
    const issue = await svc.create({
      name: 'Issue',
      membrane: 'coasys',
      sourceThreadId: 't',
      provider: {
        kind: 'issue',
        refs: [{ forge: 'github', host: 'github.com', repo: 'Org/Other', kind: 'issue', id: '7' }],
        url: 'https://github.com/Org/Other/issues/7',
        issueState: 'open',
        lastPolledAt: '2026-10-01T00:00:00.000Z'
      }
    })
    const plain = await svc.create({ name: 'Decide the gate box', membrane: 'home', sourceThreadId: 't' })
    await svc.addToStream(stream.id, pr.id, 't')
    await svc.addToStream(sub.id, issue.id, 't')
    return { stream, sub, pr, issue, plain }
  }

  it('creates streams unassigned and flagged', async () => {
    const { stream } = await seed()
    expect(stream.isStream).toBe(true)
    expect(stream.threadId).toBeNull()
    expect(stream.membrane).toBe('coasys')
  })

  it('lists streams with nesting and member counts', async () => {
    const { stream, sub } = await seed()
    const streams = await svc.listStreams('coasys')
    expect(streams).toHaveLength(2)
    expect(streams.find((s) => s.id === stream.id)).toEqual({
      id: stream.id,
      name: 'Plan 20',
      membrane: 'coasys',
      memberCount: 2
    })
    expect(streams.find((s) => s.id === sub.id)).toMatchObject({ parentId: stream.id, memberCount: 1 })
    expect(await svc.listStreams('home')).toEqual([])
  })

  it('filters by workstream through nested streams', async () => {
    const { stream, sub, pr, issue } = await seed()
    const ids = (await svc.list({ workstream: stream.id })).map((t) => t.id).sort()
    expect(ids).toEqual([sub.id, pr.id, issue.id].sort())
    expect((await svc.list({ workstream: sub.id })).map((t) => t.id)).toEqual([issue.id])
  })

  it('filters by membrane, repo (case-insensitive), provider kind and stream flag', async () => {
    const { pr, issue, plain, stream, sub } = await seed()
    expect((await svc.list({ membrane: 'home' })).map((t) => t.id)).toEqual([plain.id])
    expect((await svc.list({ repo: 'org/other' })).map((t) => t.id)).toEqual([issue.id])
    expect((await svc.list({ providerKind: 'change' })).map((t) => t.id)).toEqual([pr.id])
    expect((await svc.list({ providerKind: 'none', isStream: false })).map((t) => t.id)).toEqual([plain.id])
    expect((await svc.list({ isStream: true })).map((t) => t.id).sort()).toEqual([stream.id, sub.id].sort())
    expect(await svc.list({ membrane: 'coasys', repo: 'org/repo', providerKind: 'issue' })).toEqual([])
  })

  it('removes a member from a stream', async () => {
    const { stream, pr } = await seed()
    await svc.removeFromStream(stream.id, pr.id, 't')
    expect((await svc.list({ workstream: stream.id })).map((t) => t.id)).not.toContain(pr.id)
  })

  it('refuses to add to a task that is not a stream', async () => {
    const { plain, pr } = await seed()
    await expect(svc.addToStream(plain.id, pr.id, 't')).rejects.toThrow(/not a work stream/)
  })

  it('sets membrane and stream flag through update', async () => {
    const { plain } = await seed()
    const updated = await svc.update(plain.id, { membrane: 'coasys', isStream: true, sourceThreadId: 't' })
    expect(updated.membrane).toBe('coasys')
    expect(updated.isStream).toBe(true)
  })
})
