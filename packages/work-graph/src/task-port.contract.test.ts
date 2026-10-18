// The TaskPort contract against the port the server binds (@sovereign/tasks:
// TaskService + the Forge meta store, persisted without AD4M here).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type BusEvent, type EventBus, type TaskPort } from '@sovereign/core'
import { createForgePersistence, createForgeTaskPort, createTaskService } from '@sovereign/tasks'
import { afterEach, describe, expect, it } from 'vitest'

interface Made {
  port: TaskPort
  /** The same data opened again, as after a restart (persistent implementations only). */
  reopen?: () => Promise<TaskPort>
  dispose(): void
}

const tmps: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-port-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const IMPLS: Array<{ name: string; make: (bus?: EventBus) => Promise<Made> }> = [
  {
    name: 'tasks (TaskService + meta store)',
    make: async (bus) => {
      const dataDir = tmp()
      const quiet = createEventBus(tmp())
      let open: Array<{ dispose(): void }> = []
      const start = async () => {
        const p = createForgePersistence({ dataDir })
        await p.taskStore.settled()
        open.push(p)
        return createForgeTaskPort({
          service: createTaskService({ store: p.taskStore, bus: bus ?? quiet }),
          meta: p.meta
        })
      }
      const port = await start()
      return {
        port,
        reopen: async () => {
          for (const p of open.splice(0)) p.dispose()
          return start()
        },
        dispose: () => {
          for (const p of open.splice(0)) p.dispose()
          open = []
        }
      }
    }
  }
]

const change = (n: number) => `github:github.com/acme/widget#${n}`

describe.each(IMPLS)('TaskPort contract: $name', ({ make }) => {
  it('ensureTask is idempotent per key; streams nest; links refuse cycles', async () => {
    const { port, dispose } = await make()
    const a = await port.ensureTask(change(1), { name: 'A', membrane: 'acme', kind: 'change' })
    expect(a).toMatchObject({ key: change(1), kind: 'change', membrane: 'acme', state: 'pending', threadId: null })
    expect((await port.ensureTask(change(1), { name: 'other', membrane: 'acme', kind: 'change' })).id).toBe(a.id)
    expect((await port.findByKey(change(1)))?.id).toBe(a.id)
    expect(await port.findByKey(change(2))).toBeUndefined()
    const s = await port.createStream('acme', 'Plan 20')
    const sub = await port.createStream('acme', 'Part 1', s.id)
    expect(sub.parentId).toBe(s.id)
    await port.addToStream(sub.id, a.id)
    await port.addToStream(sub.id, a.id)
    await expect(port.addToStream(a.id, s.id)).rejects.toThrow(/work stream/i)
    await expect(port.addToStream(sub.id, s.id)).rejects.toThrow(/cycle/i)
    await expect(port.createStream('acme', 'x', a.id)).rejects.toThrow(/work stream/i)
    expect((await port.streamsOf('acme')).map((x) => [x.name, x.memberCount]).sort()).toEqual([
      ['Part 1', 1],
      ['Plan 20', 1]
    ])
    expect((await port.get(a.id))!.parentIds).toEqual([sub.id])
    expect((await port.get(sub.id))!.childIds).toEqual([a.id])
    await port.removeFromStream(sub.id, a.id)
    expect((await port.get(a.id))!.parentIds).toEqual([])
    expect(await port.streamsOf('other')).toEqual([])
    dispose()
  })

  it('a stream init makes the task a stream; a task with no membrane joins the one that asks', async () => {
    const { port, dispose } = await make()
    const plan = await port.ensureTask('plan:widget/plans/p.md', {
      name: 'P',
      membrane: 'acme',
      kind: 'plan',
      stream: true
    })
    expect(plan).toMatchObject({ isStream: true, kind: 'plan', key: 'plan:widget/plans/p.md' })
    const t = await port.ensureTask(change(3), { name: 'C', membrane: 'acme', kind: 'change' })
    expect(
      (await port.ensureTask(change(3), { name: 'C', membrane: 'acme', kind: 'change', stream: true })).isStream
    ).toBe(true)
    expect((await port.streamsOf('acme')).map((x) => x.id).sort()).toEqual([plan.id, t.id].sort())
    expect((await port.streamsOf('acme')).find((x) => x.id === plan.id)).toMatchObject({
      plan: 'plan:widget/plans/p.md'
    })

    // Rename; a cancelled stream reads as archived; setStream(false) makes it a plain task again.
    await port.setName(plan.id, 'P renamed')
    await port.setState(t.id, 'cancelled')
    const listed = await port.streamsOf('acme')
    expect(listed.find((x) => x.id === plan.id)).toMatchObject({ name: 'P renamed' })
    expect(listed.find((x) => x.id === plan.id)).not.toHaveProperty('archived')
    expect(listed.find((x) => x.id === t.id)).toMatchObject({ archived: true })
    await port.setStream(plan.id, false)
    expect(await port.get(plan.id)).toMatchObject({ isStream: false, key: 'plan:widget/plans/p.md' })
    expect((await port.streamsOf('acme')).map((x) => x.id)).toEqual([t.id])
    dispose()
  })

  it('writes thread, state, transient line and status; lists by membrane and every forge item', async () => {
    const { port, dispose } = await make()
    const a = await port.ensureTask(change(1), { name: 'A', membrane: 'acme', kind: 'change' })
    const b = await port.ensureTask(change(2), { name: 'B', membrane: 'beta', kind: 'issue' })
    await port.ensureTask('plan:widget/x.md', { name: 'X', membrane: 'acme', kind: 'plan' })
    await port.setThread(a.id, 'th-1')
    await port.setState(a.id, 'in_progress')
    await port.setTransientState(a.id, 'CI red: build')
    await port.setStatus(a.id, {
      kind: 'change',
      state: 'open',
      checks: 'failing',
      failedChecks: ['build'],
      review: 'changes_requested',
      unresolvedComments: 3,
      lastPolledAt: '2026-10-01T00:00:00.000Z'
    })
    await port.setStatus(b.id, { kind: 'issue', state: 'closed:not_planned', lastPolledAt: '2026-10-01T00:00:00.000Z' })
    const got = (await port.get(a.id))!
    expect(got).toMatchObject({ threadId: 'th-1', state: 'in_progress', transientState: 'CI red: build' })
    expect(got.status).toMatchObject({
      kind: 'change',
      state: 'open',
      checks: 'failing',
      failedChecks: ['build'],
      review: 'changes_requested',
      unresolvedComments: 3
    })
    expect((await port.get(b.id))!.status).toMatchObject({ kind: 'issue', state: 'closed:not_planned' })
    await port.setTransientState(a.id, null)
    await port.setThread(a.id, null)
    expect(await port.get(a.id)).toMatchObject({ transientState: null, threadId: null })
    expect((await port.listByMembrane('acme')).map((t) => t.name).sort()).toEqual(['A', 'X'])
    expect((await port.listForgeItems()).map((t) => t.name).sort()).toEqual(['A', 'B'])
    await expect(port.setState('task://missing', 'completed')).rejects.toThrow(/not found/i)
    dispose()
  })

  it('keeps views in order per membrane and related edges with accept and delete', async () => {
    const { port, reopen, dispose } = await make()
    const views = [
      { id: 'b', membrane: 'acme', title: 'Second first', repos: ['acme/widget'], filters: { requestedFromMe: true } },
      { id: 'all', membrane: 'acme', title: 'All', repos: [], filters: {}, height: 300 }
    ]
    expect(await port.putViews('acme', views)).toEqual(views)
    await port.putViews('beta', [{ id: 'all', membrane: 'beta', title: 'Beta', repos: [], filters: {} }])
    expect(await port.putViews('acme', [views[1], views[0]])).toEqual([views[1], views[0]])
    await port.addRelated('acme', {
      from: 'a',
      to: 'b',
      kind: 'related',
      source: 'rethink',
      reason: 'r',
      confidence: 0.8
    })
    const again = await port.addRelated('acme', { from: 'a', to: 'b', kind: 'related', source: 'rethink', reason: 'x' })
    expect(again).toMatchObject({ reason: 'r', accepted: false })
    expect(await port.acceptRelated('acme', 'a', 'b', 'related')).toBe(true)
    expect(await port.acceptRelated('acme', 'a', 'x', 'related')).toBe(false)
    expect(await port.acceptRelated('beta', 'a', 'b', 'related')).toBe(false)

    const after = reopen ? await reopen() : port
    expect(await after.getViews('acme')).toEqual([views[1], views[0]])
    expect((await after.getViews('beta')).map((v) => v.title)).toEqual(['Beta'])
    expect(await after.listRelated('acme')).toEqual([
      expect.objectContaining({ from: 'a', to: 'b', kind: 'related', accepted: true, reason: 'r', source: 'rethink' })
    ])
    expect(await after.listRelated('beta')).toEqual([])
    expect(await after.deleteRelated('acme', 'a', 'b', 'related')).toBe(true)
    expect(await after.deleteRelated('acme', 'a', 'b', 'related')).toBe(false)
    await after.putViews('acme', [])
    expect(await after.getViews('acme')).toEqual([])
    dispose()
  })

  it('keeps tasks across a restart (persistent implementations)', async () => {
    const { port, reopen, dispose } = await make()
    if (!reopen) return dispose()
    const t = await port.ensureTask(change(5), { name: 'Five', membrane: 'acme', kind: 'change' })
    const s = await port.createStream('acme', 'S')
    await port.addToStream(s.id, t.id)
    await port.setThread(t.id, 'th')
    const after = await reopen()
    expect(await after.findByKey(change(5))).toMatchObject({ id: t.id, threadId: 'th', parentIds: [s.id] })
    dispose()
  })

  it('emits the task.* events TaskService emits, once per real change', async () => {
    const bus = createEventBus(tmp())
    const seen: BusEvent[] = []
    bus.on('task.*', (e) => {
      seen.push(e)
    })
    const { port, dispose } = await make(bus)
    const t = await port.ensureTask(change(1), { name: 'A', membrane: 'acme', kind: 'change' })
    await port.setState(t.id, 'in_progress')
    await port.setState(t.id, 'in_progress')
    await port.setThread(t.id, 'th')
    await port.setThread(t.id, 'th')
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.map((e) => e.type)).toEqual(['task.created', 'task.state_changed', 'task.reassigned'])
    expect(seen[1].payload).toMatchObject({
      taskId: t.id,
      oldState: 'pending',
      newState: 'in_progress',
      sourceThreadId: 'forge'
    })
    expect(seen[2].payload).toMatchObject({ taskId: t.id, newThreadId: 'th', sourceThreadId: 'forge' })
    dispose()
  })
})
