import type { WorkNode } from '@sovereign/core'
import { describe, expect, it, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestTaskPort } from './testing.js'
import { nextTaskState, notificationFor, statusLine, syncTasks, type StateContext } from './task-sync.js'
import type { CachedChange, ForgeEvent, PortTaskState } from './types.js'

const node = (over: Partial<WorkNode> = {}): WorkNode => ({
  id: 'github:github.com/acme-labs/widget#1',
  forge: 'github',
  kind: 'change',
  repo: 'acme-labs/widget',
  number: 1,
  title: 'Sprockets',
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  branch: { head: 'feat/1', base: 'dev' },
  ci: 'passing',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over
})
const ctx = (over: Partial<StateContext> = {}): StateContext => ({
  owned: false,
  reopened: false,
  changeOpen: false,
  ...over
})

describe('nextTaskState (plan §7.3, forward only)', () => {
  const change = (state: WorkNode['state']) => node({ state })
  const issue = (state: WorkNode['state']) => node({ kind: 'issue', state, branch: undefined })
  const cases: Array<[string, PortTaskState, WorkNode, StateContext, PortTaskState | undefined]> = [
    ['merged change → completed', 'in_progress', change('merged'), ctx(), 'completed'],
    ['merged change from pending → completed', 'pending', change('merged'), ctx(), 'completed'],
    ['closed unmerged → cancelled', 'in_progress', change('closed'), ctx(), 'cancelled'],
    ['completed stays completed when closed', 'completed', change('closed'), ctx(), undefined],
    ['open change of a pending task → in_progress', 'pending', change('open'), ctx(), 'in_progress'],
    ['reopened change → in_progress', 'cancelled', change('open'), ctx({ reopened: true }), 'in_progress'],
    ['open without a reopen does not undo a terminal state', 'completed', change('open'), ctx(), undefined],
    [
      'issue closed completed → completed',
      'in_progress',
      issue('closed'),
      ctx({ issueReason: 'completed' }),
      'completed'
    ],
    [
      'issue closed not planned → cancelled',
      'pending',
      issue('closed'),
      ctx({ issueReason: 'not_planned' }),
      'cancelled'
    ],
    ['issue assigned to a thread → in_progress', 'pending', issue('open'), ctx({ owned: true }), 'in_progress'],
    ['issue with an open change → in_progress', 'pending', issue('open'), ctx({ changeOpen: true }), 'in_progress'],
    ['plain open issue stays pending', 'pending', issue('open'), ctx(), undefined],
    ['reopened issue → in_progress', 'completed', issue('open'), ctx({ reopened: true }), 'in_progress'],
    ['in_progress never goes back to pending', 'in_progress', issue('open'), ctx(), undefined],
    ['plan done → completed', 'in_progress', node({ kind: 'plan', state: 'done' }), ctx(), 'completed'],
    ['plan in progress → in_progress', 'pending', node({ kind: 'plan', state: 'in_progress' }), ctx(), 'in_progress'],
    ['a paused task stays paused while its change is open', 'paused', change('open'), ctx({ owned: true }), undefined],
    ['a paused task completes when its change merges', 'paused', change('merged'), ctx(), 'completed']
  ]
  for (const [name, from, n, c, to] of cases) it(name, () => expect(nextTaskState(from, n, c)).toBe(to))
})

describe('statusLine', () => {
  it('names the CI failure, the drift and the review state', () => {
    const n = node({
      ci: 'failing',
      branch: { head: 'feat/1', base: 'dev', behind: 4, conflict: true },
      reviewers: [{ login: 'data-bot', state: 'changes_requested' }]
    })
    expect(statusLine(n, { failed: ['integration-tests-mcp', 'lint'] })).toBe(
      'CI red: integration-tests-mcp +1 · conflict with dev · behind dev by 4 · changes requested by data-bot'
    )
    expect(statusLine(node({ ci: 'pending', reviewers: [{ login: 'jo', state: 'requested' }] }))).toBe(
      'CI running · review requested from jo'
    )
    expect(statusLine(node({ state: 'merged' }))).toBe('merged into dev')
    expect(statusLine(node({ state: 'closed' }))).toBe('closed unmerged')
    expect(statusLine(node())).toBe('CI green')
    const issue = node({ kind: 'issue', branch: undefined, ci: undefined })
    expect(statusLine(issue, { openChange: node({ number: 7 }) })).toBe('change #7 open')
    expect(statusLine({ ...issue, state: 'closed' }, { issueReason: 'not_planned' })).toBe('closed as not planned')
  })
})

describe('notifications (pr-poll parity)', () => {
  const e = (type: ForgeEvent['type'], detail: Record<string, unknown> = {}): ForgeEvent => ({
    at: '',
    nodeId: node().id,
    type,
    detail
  })
  it('words the needs-agent events: CI red, changes requested, comments, conflicts', () => {
    const n = node()
    expect(notificationFor(e('ci_failed', { failed: ['build'] }), n)).toBe(
      '[PR #1] CI check failed: build. Run `gh pr checks 1 -R acme-labs/widget` for details.'
    )
    expect(notificationFor(e('reviewed', { state: 'changes_requested', login: 'jo' }), n)).toContain(
      'Changes requested by jo'
    )
    expect(notificationFor(e('commented', { count: 2 }), n)).toBe(
      '[PR #1] 2 new comments. Run `gh pr view 1 -R acme-labs/widget --comments` to review.'
    )
    expect(notificationFor(e('conflict', { base: 'dev' }), n)).toBe(
      '[PR #1] Conflicts with dev. Merge the base in and resolve.'
    )
    expect(notificationFor(e('pushed'), n)).toBeUndefined()
  })
})

describe('syncTasks', () => {
  it('writes status, state and transientState, emits task events, and tells the owner thread only what needs it', async () => {
    const events: string[] = []
    const bus = {
      emit: (ev: { type: string }) => events.push(ev.type),
      on: () => () => {},
      once: () => () => {},
      replay: async function* () {},
      history: () => []
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-sync-'))
    const port = createTestTaskPort(dir, bus as never)
    onTestFinished(() => {
      port.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const merged = node({ state: 'merged' })
    const t = await port.ensureTask(merged.id, { name: 'x', membrane: 'acme', kind: 'change' })
    await port.setThread(t.id, 'thread-1')
    await port.setState(t.id, 'in_progress')
    const r = await syncTasks(port, {
      tasks: await port.listByMembrane('acme'),
      nodes: new Map([[merged.id, merged]]),
      edges: [],
      events: [
        { at: '', nodeId: merged.id, type: 'merged', detail: {}, triage: 'info', tier: 'rule' },
        { at: '', nodeId: merged.id, type: 'conflict', detail: { base: 'dev' }, triage: 'needs-agent', tier: 'rule' }
      ],
      item: () => ({ checks: { state: 'passing' } }) as CachedChange,
      now: '2026-10-16T00:00:00.000Z'
    })
    const after = (await port.get(t.id))!
    expect(after.state).toBe('completed')
    expect(after.transientState).toBe('merged into dev')
    expect(after.status).toMatchObject({ kind: 'change', state: 'merged', checks: 'passing', review: 'none' })
    // The merge is recorded on the task; only the needs-agent event becomes a message
    expect(r.notifications).toEqual([
      {
        threadId: 'thread-1',
        text: '[PR #1] Conflicts with dev. Merge the base in and resolve.',
        nodeId: merged.id,
        type: 'conflict'
      }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        'task.created',
        'task.reassigned',
        'task.state_changed',
        'task.transient_updated',
        'task.provider_updated'
      ])
    )
    // A second pass with nothing new writes nothing.
    const before = events.length
    const again = await syncTasks(port, {
      tasks: await port.listByMembrane('acme'),
      nodes: new Map([[merged.id, merged]]),
      edges: [],
      events: [],
      item: () => ({ checks: { state: 'passing' } }) as CachedChange,
      now: '2026-10-16T00:02:00.000Z'
    })
    expect(again.updated).toBe(0)
    expect(events.length).toBe(before)
  })

  it("never moves a work stream's state: that is its epic status, the user's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-task-sync-'))
    const port = createTestTaskPort(dir)
    onTestFinished(() => {
      port.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const plan = node({ id: 'plan:acme-org/widget/p.md', kind: 'plan', state: 'in_progress', branch: undefined })
    const t = await port.ensureTask(plan.id, { name: 'P', membrane: 'acme', kind: 'plan', stream: true })
    await port.setThread(t.id, 'thread-1')
    const sync = async (n: WorkNode) =>
      syncTasks(port, {
        tasks: await port.listByMembrane('acme'),
        nodes: new Map([[n.id, n]]),
        edges: [],
        events: [],
        item: () => undefined,
        now: '2026-10-16T00:00:00.000Z'
      })
    // Owned, plan in progress: a plain plan task would go in_progress; the epic stays planned.
    await sync(plan)
    expect((await port.get(t.id))!.state).toBe('pending')
    await port.setState(t.id, 'paused')
    await sync({ ...plan, state: 'done' })
    expect((await port.get(t.id))!).toMatchObject({ state: 'paused', transientState: 'plan done' })
  })
})
