import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTaskService, type TaskService } from './service.js'
import { createInMemoryTaskStore } from './store.js'
import type { TaskEventPayload, TaskState } from './types.js'

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

describe('TaskService — provider', () => {
  let svc: TaskService
  let events: Array<{ type: string; payload: unknown }>

  const sampleProvider = {
    kind: 'github-pr' as const,
    url: 'https://github.com/org/repo/pull/42',
    repo: 'org/repo',
    number: 42,
    prStatus: 'open' as const,
    checksStatus: 'passing' as const,
    reviewDecision: 'review_required' as const,
    lastPolledAt: '2026-09-15T00:00:00.000Z',
    unresolvedComments: 0
  }

  beforeEach(() => {
    const { bus, events: e } = makeBus()
    events = e
    svc = createTaskService({ store: createInMemoryTaskStore(), bus })
  })

  it('creates a task with provider metadata', async () => {
    const task = await svc.create({
      name: 'PR #42',
      sourceThreadId: 't1',
      provider: sampleProvider
    })

    expect(task.provider).toBeDefined()
    expect(task.provider!.kind).toBe('github-pr')
    expect(task.provider!.number).toBe(42)
    expect(task.provider!.repo).toBe('org/repo')
  })

  it('persists provider through get', async () => {
    const task = await svc.create({
      name: 'PR #42',
      sourceThreadId: 't1',
      provider: sampleProvider
    })

    const fetched = await svc.get(task.id)
    expect(fetched!.provider).toEqual(sampleProvider)
  })

  it('updates provider and emits task.provider_updated', async () => {
    const task = await svc.create({
      name: 'PR #42',
      sourceThreadId: 't1',
      provider: sampleProvider
    })

    const updated = await svc.update(task.id, {
      provider: { ...sampleProvider, checksStatus: 'failing' },
      sourceThreadId: 't1'
    })

    expect(updated.provider!.checksStatus).toBe('failing')

    const providerEvent = events.find((e) => e.type === 'task.provider_updated')
    expect(providerEvent).toBeTruthy()
    expect((providerEvent!.payload as TaskEventPayload).taskId).toBe(task.id)
  })

  it('includes provider summary in list items', async () => {
    await svc.create({
      name: 'PR #42',
      sourceThreadId: 't1',
      provider: sampleProvider
    })

    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].provider).toBeDefined()
    expect(list[0].provider!.kind).toBe('github-pr')
    expect(list[0].provider!.prStatus).toBe('open')
    expect(list[0].provider!.checksStatus).toBe('passing')
  })

  it('omits provider from list items when task has no provider', async () => {
    await svc.create({ name: 'Plain task', sourceThreadId: 't1' })

    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].provider).toBeUndefined()
  })
})
