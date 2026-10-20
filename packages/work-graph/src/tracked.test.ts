// pr-poll parity. pr-poll (packages/tasks, retired) polled every open PR task
// and told its owner thread about CI, reviews, comments, merges and closes,
// moving the task's state. The forge service's tracked-item poll does that
// for every PR or issue task its membrane's sync does not read: forge off, a
// repo outside the membrane (not in forge.repos either), or no membrane.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type EventBus } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScopeSource } from './scope.js'
import { createForgeService, type ForgeService } from './service.js'
import { change, createFakeForge, createTestTaskPort, issue, type FakeForge, type TestTaskPort } from './testing.js'
import type { ForgeConfig } from './types.js'

const THING = 'other-org/thing'
const WIDGET = 'acme-labs/widget'
const key = (repo: string, n: number) => `github:github.com/${repo}#${n}`

describe('tracked items (pr-poll parity)', () => {
  let tmp: string
  let forge: FakeForge
  let port: TestTaskPort
  let bus: EventBus
  let service: ForgeService
  let sent: Array<{ threadId: string; text: string }>
  let config: Partial<ForgeConfig>
  let scope: ScopeSource

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-tracked-'))
    sent = []
    forge = createFakeForge()
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    bus = createEventBus(path.join(tmp, 'bus'))
    config = {}
    scope = {
      getMembrane: (id) => (id === 'acme' ? { id, workspaceIds: [] } : undefined),
      listMembranes: () => [{ id: 'acme', workspaceIds: [] }],
      getOrg: () => undefined,
      listProjects: () => []
    }
    service = createForgeService({
      dataDir: path.join(tmp, 'data'),
      config: () => config,
      scope,
      forgeRegistry: { forgeFor: () => forge },
      tasks: port,
      bus,
      threads: {
        createThread: async () => 'new-thread',
        sendToThread: async (threadId, text) => void sent.push({ threadId, text }),
        presence: () => ({ label: 'T', status: 'working' })
      },
      log: () => {}
    })
  })
  afterEach(() => {
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const texts = () => sent.map((s) => s.text)
  const last = () => texts()[sent.length - 1]

  it('forge off, no membrane: the first read sets the baseline; changes update the task, and what needs work reaches the owner', async () => {
    forge.put(change(THING, 5, { checks: { state: 'pending' } }))
    const t = await port.importTask(key(THING, 5), 'change', 'PR #5', 'th-1')

    await service.pollTracked()
    expect(await port.get(t.id)).toMatchObject({
      state: 'in_progress',
      transientState: 'CI running',
      status: { kind: 'change', state: 'open', checks: 'pending', review: 'none', unresolvedComments: 0 }
    })
    expect(sent).toEqual([])

    // CI goes red: names of the failed checks, the gh hint.
    forge.put(change(THING, 5, { checks: { state: 'failing' } }))
    forge.checkResults.set(`${THING}#5`, { state: 'failing', failed: ['build'] })
    await service.pollTracked()
    expect(sent).toEqual([
      { threadId: 'th-1', text: '[PR #5] CI check failed: build. Run `gh pr checks 5 -R other-org/thing` for details.' }
    ])
    expect(await port.get(t.id)).toMatchObject({
      transientState: 'CI red: build',
      status: { checks: 'failing', failedChecks: ['build'] }
    })

    // Green again; then changes requested; then approved.
    forge.put(change(THING, 5, { checks: { state: 'passing' } }))
    await service.pollTracked()
    forge.put(change(THING, 5, { reviewers: [{ login: 'sam-reviewer', state: 'changes_requested' }] }))
    await service.pollTracked()
    forge.put(change(THING, 5, { reviewers: [{ login: 'sam-reviewer', state: 'approved' }] }))
    await service.pollTracked()
    // CI green and the approval only update the task
    expect(texts().slice(1)).toEqual([
      '[PR #5] Changes requested by sam-reviewer. Run `gh pr view 5 -R other-org/thing --comments` to see review comments.'
    ])
    expect((await port.get(t.id))!.status).toMatchObject({ review: 'approved' })

    // New comments on an owned PR.
    forge.commentsOf.set(`${THING}#5`, [
      { author: 'sam-reviewer', body: 'nit', createdAt: '2026-10-02T00:00:00Z' },
      { author: 'sam-reviewer', body: 'another', createdAt: '2026-10-02T00:01:00Z' }
    ])
    await service.pollTracked()
    expect(last()).toBe('[PR #5] 2 new comments. Run `gh pr view 5 -R other-org/thing --comments` to review.')
    expect((await port.get(t.id))!.status).toMatchObject({ unresolvedComments: 2 })

    // Merged: completed, no message, and no longer read.
    const before = sent.length
    forge.put(change(THING, 5, { state: 'merged', closedAt: '2026-10-03T00:00:00Z' }))
    await service.pollTracked()
    expect(sent).toHaveLength(before)
    expect(await port.get(t.id)).toMatchObject({ state: 'completed', transientState: 'merged into dev' })
    const reads = forge.calls.filter((c) => c.op === 'getChange').length
    await service.pollTracked()
    expect(forge.calls.filter((c) => c.op === 'getChange')).toHaveLength(reads)
  })

  it('a PR closed unmerged cancels its task without a message', async () => {
    forge.put(change(THING, 6))
    const t = await port.importTask(key(THING, 6), 'change', 'PR #6', 'th-1')
    await service.pollTracked()
    forge.put(change(THING, 6, { state: 'closed', closedAt: '2026-10-03T00:00:00Z' }))
    await service.pollTracked()
    expect(sent).toEqual([])
    expect(await port.get(t.id)).toMatchObject({ state: 'cancelled', transientState: 'closed unmerged' })
  })

  it('an unowned task gets state and status but no messages; a failed read skips the round', async () => {
    forge.put(change(THING, 7))
    const t = await port.importTask(key(THING, 7), 'change', 'PR #7')
    await service.pollTracked()
    forge.failNext = new Error('GitHub 502')
    forge.put(change(THING, 7, { state: 'merged' }))
    await service.pollTracked()
    expect((await port.get(t.id))!.state).toBe('in_progress')
    await service.pollTracked()
    expect((await port.get(t.id))!.state).toBe('completed')
    expect(sent).toEqual([])
  })

  it('reads issue tasks too: closed as completed or not planned', async () => {
    forge.put(issue(THING, 8))
    const t = await port.importTask(key(THING, 8), 'issue', 'Issue #8', 'th-2')
    await service.pollTracked()
    forge.put(issue(THING, 8, { state: 'closed', closedReason: 'not_planned' }))
    await service.pollTracked()
    expect(sent).toEqual([])
    expect(await port.get(t.id)).toMatchObject({ state: 'cancelled', status: { state: 'closed:not_planned' } })
  })

  it('reads an imported task within a second of its task.created, not at the next poll', async () => {
    config = { pollOpenMs: 3_600_000 }
    service.start()
    await new Promise((r) => setTimeout(r, 20))
    forge.put(change(THING, 10, { checks: { state: 'failing' } }))
    const t = await port.importTask(key(THING, 10), 'change', 'PR #10', 'th-1')
    bus.emit({
      type: 'task.created',
      timestamp: new Date().toISOString(),
      source: 'tasks',
      payload: { taskId: t.id, taskName: t.name, threadId: 'th-1', sourceThreadId: 'th-1' }
    })
    const end = Date.now() + 3000
    while ((await port.get(t.id))!.status?.checks !== 'failing' && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20))
    expect((await port.get(t.id))!.status).toMatchObject({ checks: 'failing' })
  })

  it('skips terminal tasks; pollTask reads one task whatever its state', async () => {
    forge.put(change(THING, 9, { state: 'merged' }))
    const t = await port.importTask(key(THING, 9), 'change', 'PR #9')
    await port.setState(t.id, 'completed')
    expect(await service.pollTracked()).toEqual({ items: 0, events: 0 })
    await service.pollTask(t.id)
    expect((await port.get(t.id))!.status).toMatchObject({ state: 'merged' })
    await expect(service.pollTask('task://none')).rejects.toThrow(/not found/i)
  })

  it('forge on: a membrane task on a repo outside its scope is tracked and drawn in its graph; one inside is left to the sync', async () => {
    config = { enabled: true, repos: { acme: [WIDGET] } }
    forge.put(change(THING, 11, { title: 'Foreign fix' }))
    forge.put(change(WIDGET, 12))
    const outside = await port.ensureTask(key(THING, 11), { name: 'Foreign', membrane: 'acme', kind: 'change' })
    await port.ensureTask(key(WIDGET, 12), { name: 'Own', membrane: 'acme', kind: 'change' })
    expect(await service.pollTracked()).toEqual({ items: 1, events: 0 })
    expect(forge.calls.filter((c) => c.op === 'getChange').map((c) => c.repo)).toEqual([THING])
    expect((await port.get(outside.id))!.state).toBe('in_progress')
    const g = await service.graph('acme', { since: '2020-01-01T00:00:00Z' })
    expect(g.nodes.find((n) => n.id === key(THING, 11))).toMatchObject({ title: 'Foreign fix', taskId: outside.id })
  })
})
