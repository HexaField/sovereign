import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type BusEvent, type EventBus, type ForgeGraph } from '@sovereign/core'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeRouter } from './routes.js'
import { resolveScope, type ScopeSource } from './scope.js'
import { createForgeService, type ForgeService, type ForgeServiceDeps } from './service.js'
import { change, createFakeForge, createTestTaskPort, issue, type FakeForge, type TestTaskPort } from './testing.js'
import type { ForgeConfig } from './types.js'

const WIDGET = 'acme-labs/widget'
const GADGET = 'acme-labs/gadget'
const NOW = Date.parse('2026-10-16T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const nid = (repo: string, n: number) => `github:github.com/${repo}#${n}`

/** A checkout whose origin points at `remote`. */
function checkout(dir: string, remote: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n`)
}

describe('forge service', () => {
  let tmp: string
  let forge: FakeForge
  let port: TestTaskPort
  let bus: EventBus
  let service: ForgeService
  let now: number
  let sent: Array<{ threadId: string; text: string }>
  let created: Array<{ membrane: string; label: string }>
  let busEvents: BusEvent[]
  let config: Partial<ForgeConfig>
  let scope: ScopeSource

  function make(extra: Partial<ForgeServiceDeps> = {}) {
    return createForgeService({
      dataDir: path.join(tmp, 'data'),
      config: () => config,
      scope,
      forgeRegistry: { forgeFor: () => forge },
      tasks: port,
      bus,
      threads: {
        createThread: async (membrane, label) => {
          created.push({ membrane, label })
          return `thread-${created.length}`
        },
        sendToThread: async (threadId, text) => {
          sent.push({ threadId, text })
        },
        presence: (id) => ({ label: `Thread ${id}`, status: 'working' })
      },
      now: () => now,
      log: () => {},
      ...extra
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-svc-'))
    now = NOW
    sent = []
    created = []
    busEvents = []
    const widgetDir = path.join(tmp, 'acme', 'widget')
    checkout(widgetDir, 'git@github.com:acme-labs/widget.git')
    fs.mkdirSync(path.join(widgetDir, 'plans'), { recursive: true })
    fs.writeFileSync(
      path.join(widgetDir, 'plans', 'sprockets.md'),
      '# Sprocket rework\n\nStatus: in progress\n\nCovers #50 in acme-labs/widget, and acme-labs/gadget#9.\n'
    )
    const membranes = [
      { id: 'acme', workspaceIds: ['acme-org'] },
      { id: 'empty', workspaceIds: [] }
    ]
    scope = {
      getMembrane: (id) => membranes.find((m) => m.id === id),
      listMembranes: () => membranes,
      getOrg: (id) => (id === 'acme-org' ? { id, path: path.join(tmp, 'acme') } : undefined),
      listProjects: (orgId) => (orgId === 'acme-org' ? [{ id: 'widget', name: 'widget', repoPath: widgetDir }] : [])
    }
    config = { enabled: true, identities: { github: 'hex-agent' }, repos: { acme: [WIDGET, GADGET] } }
    forge = createFakeForge()
    forge.put(
      change(WIDGET, 50, {
        createdAt: daysAgo(5),
        updatedAt: daysAgo(1),
        title: 'Stream teeth',
        body: '> ### Paired with: acme-labs/gadget#9'
      })
    )
    forge.put(change(WIDGET, 51, { updatedAt: daysAgo(2), base: { branch: 'feat/50' }, assignees: ['kit-bot'] }))
    forge.put(
      change(WIDGET, 30, {
        state: 'merged',
        updatedAt: daysAgo(60),
        closedAt: daysAgo(60),
        title: 'Ancient sprocket fix'
      })
    )
    forge.put(issue(WIDGET, 7, { updatedAt: daysAgo(3) }))
    forge.put(change(GADGET, 9, { updatedAt: daysAgo(1) }))
    forge.branches.set(WIDGET, [
      { name: 'dev', sha: 'd1' },
      { name: 'feat/50', sha: 'sha-50-1' }
    ])
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    bus = createEventBus(path.join(tmp, 'bus'))
    bus.on('forge.*', (e) => {
      busEvents.push(e)
    })
    service = make()
  })
  afterEach(() => {
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('scopes a membrane: only the configured repos (a listed repo keeps its local checkout), plan dirs of its projects', () => {
    const s = resolveScope(scope, 'acme', { planDirs: ['plans', 'docs/plans'], repos: config.repos })!
    expect(s.repos.map((r) => r.repo)).toEqual([WIDGET, GADGET])
    expect(s.repos.find((r) => r.repo === WIDGET)!.checkouts.map((c) => c.path)).toEqual([
      path.join(tmp, 'acme', 'widget')
    ])
    // A project's remote is never synced unless it is listed.
    const optIn = resolveScope(scope, 'acme', { planDirs: [], repos: { acme: [GADGET] } })!
    expect(optIn.repos.map((r) => r.repo)).toEqual([GADGET])
    expect(resolveScope(scope, 'acme', { planDirs: [] })!.repos).toEqual([])
    expect(s.planDirs.map((d) => [d.project, d.repo])).toEqual([['acme-org/widget', WIDGET]])
    expect(service.membranes()).toEqual(['acme'])
  })

  it('syncs both repos and serves the window graph with stacks, pairing and plans; forge.updated on the bus', async () => {
    await service.sync('acme')
    const g: ForgeGraph = await service.graph('acme')
    const ids = g.nodes.map((n) => n.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        nid(WIDGET, 50),
        nid(WIDGET, 51),
        nid(WIDGET, 7),
        nid(GADGET, 9),
        'plan:acme-org/widget/sprockets.md'
      ])
    )
    expect(ids).not.toContain(nid(WIDGET, 30))
    const has = (from: string, to: string, kind: string) =>
      g.edges.some((e) => e.from === from && e.to === to && e.kind === kind)
    expect(has(nid(WIDGET, 51), nid(WIDGET, 50), 'base')).toBe(true)
    expect(g.edges.some((e) => e.kind === 'paired')).toBe(true)
    expect(has('plan:acme-org/widget/sprockets.md', nid(WIDGET, 50), 'plans')).toBe(true)
    expect(has('plan:acme-org/widget/sprockets.md', nid(GADGET, 9), 'plans')).toBe(true)
    expect(g.since).toBe(daysAgo(21))
    expect(busEvents.map((e) => e.type)).toContain('forge.updated')
    // Search reaches history beyond the window once backfilled.
    while (await service.backfillStep('acme')) {
      /* drain */
    }
    expect((await service.search('acme', 'ancient')).nodes.map((n) => n.id)).toEqual([nid(WIDGET, 30)])
    const older = await service.graph('acme', { since: daysAgo(90), until: daysAgo(21) })
    expect(older.nodes.map((n) => n.id)).toEqual([nid(WIDGET, 30)])
  })

  it('asks the injected structureOf for every open change of a checked-out repo once per head, and carries the answer', async () => {
    service.stop()
    const asked: string[] = []
    const widgetDir = path.join(tmp, 'acme', 'widget')
    service = make({
      structureOf: async (repoPath, base, head) => {
        asked.push(`${repoPath} ${base} ${head}`)
        if (head === 'sha-51-1') throw new Error('index broke')
        return {
          base: 'b'.repeat(40),
          head,
          modules: [],
          symbols: { added: [], removed: [], modified: [] },
          reach: 2,
          parts: 1,
          tests: [],
          violations: []
        }
      }
    })
    await service.sync('acme')
    await service.sync('acme')
    await new Promise((r) => setTimeout(r, 0))
    // gadget has no local checkout; #30 is merged
    expect(asked.sort()).toEqual([`${widgetDir} origin/dev sha-50-1`, `${widgetDir} origin/feat/50 sha-51-1`])
    const g = await service.graph('acme')
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    expect(byId.get(nid(WIDGET, 50))!.structure).toMatchObject({ state: 'ready', reach: 2, head: 'sha-50-1' })
    expect(byId.get(nid(WIDGET, 51))!.structure).toMatchObject({ state: 'failed', error: 'index broke' })
    expect(byId.get(nid(GADGET, 9))!.structure).toBeUndefined()
    expect((await service.node('acme', nid(WIDGET, 50)))!.structure).toMatchObject({ state: 'ready' })
  })

  it('assign: ensures the task, sets the thread, adds only its own identity on the forge, sends the prompt', async () => {
    await service.sync('acme')
    const r = await service.assign({ nodeId: nid(WIDGET, 51), newThread: { label: 'Widget 51' } })
    expect(r.threadId).toBe('thread-1')
    expect(created).toEqual([{ membrane: 'acme', label: 'Widget 51' }])
    const t = (await port.get(r.taskId))!
    expect(t).toMatchObject({ threadId: 'thread-1', state: 'in_progress', key: nid(WIDGET, 51), membrane: 'acme' })
    expect(forge.calls.filter((c) => c.op === 'setAssignees').map((c) => c.opts)).toEqual([
      { id: '51', add: ['hex-agent'], remove: [] }
    ])
    // kit-bot stays: Forge never touches anyone else.
    expect(forge.changes.get(WIDGET)!.find((c) => c.ref.id === '51')!.assignees).toEqual(['kit-bot', 'hex-agent'])
    expect(sent[0].threadId).toBe('thread-1')
    expect(sent[0].text).toContain('https://github.com/acme-labs/widget/pull/51')

    // Idempotent: a second assign does not write the assignee again.
    await service.assign({ nodeId: nid(WIDGET, 51), threadId: 'thread-9', prompt: 'carry on' })
    expect(forge.calls.filter((c) => c.op === 'setAssignees')).toHaveLength(1)
    expect((await port.get(r.taskId))!.threadId).toBe('thread-9')

    // Unassign removes what Forge added, only that.
    await service.assign({ nodeId: nid(WIDGET, 51), threadId: null })
    expect(forge.calls.filter((c) => c.op === 'setAssignees').map((c) => c.opts)).toEqual([
      { id: '51', add: ['hex-agent'], remove: [] },
      { id: '51', add: [], remove: ['hex-agent'] }
    ])
    expect((await port.get(r.taskId))!.threadId).toBeNull()
  })

  it('never removes an identity Forge did not add', async () => {
    forge.put(change(WIDGET, 52, { updatedAt: daysAgo(1), assignees: ['hex-agent'] }))
    await service.sync('acme')
    await service.assign({ nodeId: nid(WIDGET, 52), threadId: 'thread-x' })
    await service.assign({ nodeId: nid(WIDGET, 52), threadId: null })
    expect(forge.calls.filter((c) => c.op === 'setAssignees')).toEqual([])
  })

  it('an assignee change on GitHub shows on the next sync; assigned to the identity with no owner → needs-agent', async () => {
    await service.sync('acme')
    now += 120_000
    forge.put(
      change(WIDGET, 50, { updatedAt: new Date(now).toISOString(), assignees: ['hex-agent'], title: 'Stream teeth' })
    )
    now += 60_000
    await service.sync('acme')
    const g = await service.graph('acme')
    expect(g.nodes.find((n) => n.id === nid(WIDGET, 50))?.assignees).toEqual(['hex-agent'])
    const ev = service.events('acme').find((e) => e.type === 'assigned')
    expect(ev).toMatchObject({ nodeId: nid(WIDGET, 50), triage: 'needs-agent', tier: 'rule' })
    const d = await service.digest('acme')
    expect(d.groups[0].nodes[0].node.id).toBe(nid(WIDGET, 50))
  })

  it('a merged change turns its task completed within one sync and notifies the owner thread', async () => {
    await service.sync('acme')
    await service.assign({ nodeId: nid(WIDGET, 50), threadId: 'owner' })
    sent = []
    now += 60_000
    forge.put(
      change(WIDGET, 50, {
        state: 'merged',
        updatedAt: new Date(now).toISOString(),
        closedAt: new Date(now).toISOString()
      })
    )
    now += 60_000
    await service.sync('acme')
    const t = (await port.findByKey(nid(WIDGET, 50)))!
    expect(t.state).toBe('completed')
    expect(t.transientState).toBe('merged into dev')
    expect(sent).toEqual([{ threadId: 'owner', text: '[PR #50] Merged.' }])
    // The stacked change got base_merged; it is unowned, so info.
    expect(service.events('acme').find((e) => e.type === 'base_merged')).toMatchObject({
      nodeId: nid(WIDGET, 51),
      triage: 'info'
    })
  })

  it('CI red on an owned change: transientState, notification, needs-agent', async () => {
    await service.sync('acme')
    await service.assign({ nodeId: nid(WIDGET, 50), threadId: 'owner' })
    sent = []
    forge.changes.get(WIDGET)!.find((c) => c.ref.id === '50')!.checks = { state: 'failing' }
    forge.checkResults.set(`${WIDGET}#50`, { state: 'failing', failed: ['integration-tests-mcp'] })
    now += 120_000
    await service.sync('acme', 'open')
    const t = (await port.findByKey(nid(WIDGET, 50)))!
    expect(t.transientState).toMatch(/^CI red: integration-tests-mcp/)
    expect(t.status).toMatchObject({ checks: 'failing', failedChecks: ['integration-tests-mcp'] })
    expect(sent.map((s) => s.text)).toEqual([
      '[PR #50] CI check failed: integration-tests-mcp. Run `gh pr checks 50 -R acme-labs/widget` for details.'
    ])
    expect(service.events('acme').find((e) => e.type === 'ci_failed')).toMatchObject({
      triage: 'needs-agent',
      tier: 'rule'
    })
    expect((await service.status('acme')).triage.rule.needsAgent).toBeGreaterThanOrEqual(1)
  })

  it('rethink runs Loop 2 on a non-empty digest only, and moves the cursor', async () => {
    const runs: number[] = []
    service = make({ runRethink: async (_m, d) => void runs.push(d.count) })
    await service.sync('acme')
    expect(await service.rethink('acme')).toEqual({ ran: false, count: 0 })
    forge.put(change(WIDGET, 50, { updatedAt: new Date(now + 60_000).toISOString(), mergeable: false }))
    now += 120_000
    await service.sync('acme')
    expect(await service.rethink('acme')).toEqual({ ran: true, count: 1 })
    expect(await service.rethink('acme')).toEqual({ ran: false, count: 0 })
    expect(runs).toEqual([1])
  })

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    return cond()
  }

  it('start() syncs at once when enabled, rescans plans on a file change, and stays idle when disabled', async () => {
    service = make({ backfillDelayMs: 5 })
    service.start()
    expect(await until(() => busEvents.some((e) => e.type === 'forge.updated'))).toBe(true)
    expect(await until(() => forge.calls.some((c) => c.op === 'pageChanges'))).toBe(true)
    const plan = path.join(tmp, 'acme', 'widget', 'plans', 'sprockets.md')
    fs.writeFileSync(plan, '# Sprocket rework\n\nStatus: done\n')
    bus.emit({
      type: 'file.changed',
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { fullPath: plan }
    })
    expect(await until(() => service.events('acme').some((e) => e.type === 'plan_changed'))).toBe(true)
    expect((await service.search('acme', 'sprocket rework')).nodes[0]).toMatchObject({
      kind: 'plan',
      state: 'done',
      zone: 'past'
    })
    service.stop()

    config = { ...config, enabled: false }
    const calls = forge.calls.length
    const idle = make()
    idle.start()
    await new Promise((r) => setTimeout(r, 50))
    // No membrane sync; only tracked items (the plan's tasks) are read, one by one.
    expect(forge.calls.slice(calls).every((c) => c.op === 'getChange' || c.op === 'getIssue')).toBe(true)
    // The graph says sync is off instead of "syncing" forever.
    expect(await idle.graph('acme')).toMatchObject({ syncing: false, syncOff: true })
    idle.stop()
  })

  it('serves the membrane identity with the graph', async () => {
    await service.sync('acme')
    expect((await service.graph('acme')).identity).toBe('hex-agent')
    config = { ...config, identities: {} }
    expect((await make().graph('acme')).identity).toBe('hex-agent')
  })

  it('makes each plan a work stream related to the items it names; it owns only what is added by hand', async () => {
    const planFile = path.join(tmp, 'acme', 'widget', 'plans', 'sprockets.md')
    const planId = 'plan:acme-org/widget/sprockets.md'
    await service.sync('acme')
    const stream = (await port.findByKey(planId))!
    expect(stream).toMatchObject({ isStream: true, name: 'Sprocket rework', state: 'in_progress', membrane: 'acme' })
    const members = async () =>
      (await Promise.all((await port.get(stream.id))!.childIds.map((id) => port.get(id)))).map((t) => t!.key).sort()
    expect(await members()).toEqual([])
    const node = (g: ForgeGraph, id: string) => g.nodes.find((n) => n.id === id)!
    let g = await service.graph('acme')
    expect(node(g, planId)).toMatchObject({ kind: 'plan', taskId: stream.id })
    expect(node(g, nid(WIDGET, 50))).toMatchObject({ workstreams: [], relatedStreams: [stream.id] })
    expect(node(g, nid(GADGET, 9))).toMatchObject({ workstreams: [], relatedStreams: [stream.id] })
    expect(g.workstreams).toEqual([expect.objectContaining({ id: stream.id, memberCount: 0, relatedCount: 2 })])

    // By hand: #51 and #50 join. Owned wins over related: #50 is no longer listed as related.
    await service.addMember(stream.id, nid(WIDGET, 51))
    await service.addMember(stream.id, nid(WIDGET, 50))
    await service.sync('acme')
    expect(await members()).toEqual([nid(WIDGET, 50), nid(WIDGET, 51)].sort())
    g = await service.graph('acme')
    expect(node(g, nid(WIDGET, 50)).workstreams).toEqual([stream.id])
    expect(node(g, nid(WIDGET, 50))).not.toHaveProperty('relatedStreams')
    expect(g.workstreams[0]).toMatchObject({ memberCount: 2, relatedCount: 1 })

    // The plan drops #50 and names issue #7: #50 stays owned, #7 is related only.
    fs.writeFileSync(planFile, '# Sprocket rework\n\nStatus: in progress\n\nNow only #7 in acme-labs/widget.\n')
    await service.sync('acme')
    expect(await members()).toEqual([nid(WIDGET, 50), nid(WIDGET, 51)].sort())
    g = await service.graph('acme')
    expect(node(g, nid(WIDGET, 7))).toMatchObject({ workstreams: [], relatedStreams: [stream.id] })
    expect(node(g, nid(GADGET, 9))).not.toHaveProperty('relatedStreams')

    // The plan file goes: the stream with its hand-added members stays, related to nothing.
    fs.rmSync(planFile)
    await service.sync('acme')
    expect(await members()).toEqual([nid(WIDGET, 50), nid(WIDGET, 51)].sort())
    expect((await port.get(stream.id))!.isStream).toBe(true)
    expect((await service.graph('acme')).nodes.some((n) => n.relatedStreams)).toBe(false)
  })

  it('a change or issue has one owning epic: every add path moves it; task-only items and sub-epics may sit in several', async () => {
    await service.sync('acme')
    const a = await service.createStream('acme', 'Alpha')
    const b = await service.createStream('acme', 'Beta')
    const c = await service.createStream('acme', 'Gamma')
    const owners = async (id: string) => (await service.graph('acme')).nodes.find((n) => n.id === id)!.workstreams

    await service.addMember(a.id, nid(WIDGET, 50), 'acme')
    await service.addMember(b.id, nid(WIDGET, 50), 'acme')
    expect(await owners(nid(WIDGET, 50))).toEqual([b.id])

    // Merging moves it again; the TaskPort itself enforces it too.
    await service.addMember(c.id, nid(WIDGET, 51), 'acme')
    await service.mergeStreams(b.id, c.id, 'acme')
    expect(await owners(nid(WIDGET, 50))).toEqual([c.id])
    const t51 = (await port.findByKey(nid(WIDGET, 51)))!
    await port.addToStream(a.id, t51.id)
    expect(await owners(nid(WIDGET, 51))).toEqual([a.id])

    // A task-only item and a sub-epic keep every stream they are in.
    const sub = await service.createStream('acme', 'Sub', a.id)
    await port.addToStream(c.id, sub.id)
    expect((await port.get(sub.id))!.parentIds.sort()).toEqual([a.id, c.id].sort())
    const task = await port.service.create({ name: 'Loose task', membrane: 'acme', sourceThreadId: 't' })
    await port.addToStream(a.id, task.id)
    await port.addToStream(c.id, task.id)
    expect(await owners(`task:${task.id}`)).toEqual(expect.arrayContaining([a.id, c.id]))
  })

  it('migrates plan-added members to related, and keeps one owner per item (the first epic by name)', async () => {
    const planId = 'plan:acme-org/widget/sprockets.md'
    await service.sync('acme')
    const plan = (await port.findByKey(planId))!
    const zeta = await service.createStream('acme', 'Zeta')
    const alpha = await service.createStream('acme', 'Alpha')
    // Data as an older build left it: the plan added #50 and gadget#9; #51 was put in two epics by hand.
    for (const id of [nid(WIDGET, 50), nid(GADGET, 9)]) await service.addMember(plan.id, id, 'acme')
    await service.addMember(zeta.id, nid(WIDGET, 51), 'acme')
    const t51 = (await port.findByKey(nid(WIDGET, 51)))!
    await port.store.addLink(alpha.id, t51.id)
    await port.store.addLink(plan.id, t51.id)
    const file = path.join(tmp, 'data', 'forge', 'acme', 'state.json')
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...prev,
        planLinks: { [planId]: { named: [nid(WIDGET, 50), nid(GADGET, 9)], linked: [nid(WIDGET, 50), nid(GADGET, 9)] } }
      })
    )

    now += 120_000
    await service.sync('acme')
    const g = await service.graph('acme')
    const node = (id: string) => g.nodes.find((n) => n.id === id)!
    expect(node(nid(WIDGET, 50))).toMatchObject({ workstreams: [], relatedStreams: [plan.id] })
    expect(node(nid(GADGET, 9))).toMatchObject({ workstreams: [], relatedStreams: [plan.id] })
    // #51: Alpha < Sprocket rework < Zeta by name, so Alpha keeps it.
    expect(node(nid(WIDGET, 51)).workstreams).toEqual([alpha.id])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('planLinks')
    const counts = Object.fromEntries(g.workstreams.map((w) => [w.name, [w.memberCount, w.relatedCount]]))
    expect(counts).toEqual({ Alpha: [1, 0], Zeta: [0, 0], 'Sprocket rework': [0, 2] })

    // Idempotent: a second sync changes nothing.
    const before = JSON.stringify((await service.graph('acme')).nodes.map((n) => [n.id, n.workstreams]))
    now += 120_000
    await service.sync('acme')
    expect(JSON.stringify((await service.graph('acme')).nodes.map((n) => [n.id, n.workstreams]))).toBe(before)
  })

  it('a plan that names no item, or is done, makes no stream; it stays a plan node', async () => {
    const dir = path.join(tmp, 'acme', 'widget', 'plans')
    fs.writeFileSync(path.join(dir, 'idea.md'), '# Loose idea\n\nNothing tracked yet.\n')
    fs.writeFileSync(path.join(dir, 'shipped.md'), '# Shipped\n\nStatus: done\n\nLanded as #51 in acme-labs/widget.\n')
    await service.sync('acme')
    const g = await service.graph('acme')
    expect(g.workstreams.map((w) => w.name)).toEqual(['Sprocket rework'])
    expect(g.workstreams[0]).toMatchObject({
      plan: 'plan:acme-org/widget/sprockets.md',
      memberCount: 0,
      relatedCount: 2
    })
    for (const id of ['plan:acme-org/widget/idea.md', 'plan:acme-org/widget/shipped.md']) {
      expect(g.nodes.find((n) => n.id === id)).toMatchObject({ kind: 'plan' })
      expect((await port.findByKey(id))?.isStream ?? false).toBe(false)
    }
  })

  it('a plan stream that stops qualifying with only plan links stops being a stream; a child stream keeps one', async () => {
    const dir = path.join(tmp, 'acme', 'widget', 'plans')
    fs.writeFileSync(path.join(dir, 'gears.md'), '# Gears\n\nCovers #51 in acme-labs/widget.\n')
    await service.sync('acme')
    const sprockets = (await port.findByKey('plan:acme-org/widget/sprockets.md'))!
    const gears = (await port.findByKey('plan:acme-org/widget/gears.md'))!
    expect(gears.isStream).toBe(true)
    const sub = await service.createStream('acme', 'Sprocket follow-ups', sprockets.id)
    const handMade = await service.createStream('acme', 'Hand-made, empty')

    fs.writeFileSync(path.join(dir, 'gears.md'), '# Gears\n\nNo items any more.\n')
    fs.writeFileSync(path.join(dir, 'sprockets.md'), '# Sprocket rework\n\nStatus: done\n')
    await service.sync('acme')
    const g = await service.graph('acme')
    // Gears had only what its plan added: a plain plan task again, still on its plan node.
    expect(await port.get(gears.id)).toMatchObject({ isStream: false, childIds: [] })
    expect(g.nodes.find((n) => n.id === 'plan:acme-org/widget/gears.md')).toMatchObject({ taskId: gears.id })
    // Sprockets keeps its child stream, so it stays (without the plan's items); hand-made streams are never touched.
    expect(await port.get(sprockets.id)).toMatchObject({ isStream: true, childIds: [sub.id] })
    expect(g.workstreams.map((w) => w.id).sort()).toEqual([sprockets.id, sub.id, handMade.id].sort())
  })

  it('archived hides a stream from the graph (unless asked for), and a plan sync never brings it back', async () => {
    const planId = 'plan:acme-org/widget/sprockets.md'
    await service.sync('acme')
    const stream = (await port.findByKey(planId))!
    const archived = await service.setStreamStatus(stream.id, 'archived', 'acme')
    expect(archived).toMatchObject({ status: 'archived' })
    let g = await service.graph('acme')
    expect(g.workstreams).toEqual([])
    expect(g.nodes.find((n) => n.id === nid(WIDGET, 50))).not.toHaveProperty('relatedStreams')
    const all = await service.graph('acme', { archived: true })
    expect(all.workstreams).toEqual([expect.objectContaining({ id: stream.id, status: 'archived' })])
    expect(all.nodes.find((n) => n.id === nid(WIDGET, 50))!.relatedStreams).toEqual([stream.id])

    // The plan now names #51 too: an archived stream stays archived and owns nothing.
    fs.writeFileSync(
      path.join(tmp, 'acme', 'widget', 'plans', 'sprockets.md'),
      '# Sprocket rework\n\nStatus: in progress\n\nCovers #50 and #51 in acme-labs/widget.\n'
    )
    await service.sync('acme')
    expect(await port.get(stream.id)).toMatchObject({ state: 'cancelled', isStream: true, childIds: [] })

    // Brought back as paused: it shows again, related to what the plan names, and stays paused.
    expect(await service.setStreamStatus(stream.id, 'paused', 'acme')).toMatchObject({ status: 'paused' })
    now += 120_000
    await service.sync('acme')
    g = await service.graph('acme')
    expect(g.workstreams.map((w) => [w.id, w.status])).toEqual([[stream.id, 'paused']])
    expect(g.nodes.find((n) => n.id === nid(WIDGET, 51))).toMatchObject({
      workstreams: [],
      relatedStreams: [stream.id]
    })
  })

  it("a plan's Status line sets its epic's status once; after that the status is the user's", async () => {
    const dir = path.join(tmp, 'acme', 'widget', 'plans')
    fs.writeFileSync(path.join(dir, 'gears.md'), '# Gears\n\nCovers #51 in acme-labs/widget.\n')
    await service.sync('acme')
    const status = async () =>
      Object.fromEntries((await service.graph('acme')).workstreams.map((w) => [w.name, w.status]))
    // "Status: in progress" → active; no Status line → planned.
    expect(await status()).toEqual({ 'Sprocket rework': 'active', Gears: 'planned' })
    const sprockets = (await port.findByKey('plan:acme-org/widget/sprockets.md'))!
    const gears = (await port.findByKey('plan:acme-org/widget/gears.md'))!

    // The user's status holds through plan edits, syncs and an assigned thread.
    await service.setStreamStatus(sprockets.id, 'planned', 'acme')
    await service.setStreamStatus(gears.id, 'paused', 'acme')
    fs.writeFileSync(path.join(dir, 'gears.md'), '# Gears\n\nStatus: in progress\n\nCovers #51 in acme-labs/widget.\n')
    await service.assign({ membrane: 'acme', nodeId: 'plan:acme-org/widget/sprockets.md', threadId: 'thread-1' })
    now += 120_000
    await service.sync('acme')
    expect(await status()).toEqual({ 'Sprocket rework': 'planned', Gears: 'paused' })
    expect(await port.get(gears.id)).toMatchObject({ state: 'paused' })

    // Done in the plan, with no members: no longer a stream.
    fs.writeFileSync(path.join(dir, 'gears.md'), '# Gears\n\nStatus: done\n\nCovers #51 in acme-labs/widget.\n')
    now += 120_000
    await service.sync('acme')
    expect(await port.get(gears.id)).toMatchObject({ isStream: false })
    expect(await status()).toEqual({ 'Sprocket rework': 'planned' })

    // A completed stream counts as archived.
    await port.setState(sprockets.id, 'completed')
    expect(await status()).toEqual({})
    expect((await service.streams('acme', { archived: true })).map((w) => w.status)).toEqual(['archived'])
    await expect(service.setStreamStatus(sprockets.id, 'done' as never, 'acme')).rejects.toMatchObject({ status: 400 })
  })

  it('renames, nests, merges and lists epics', async () => {
    await service.sync('acme')
    const plan = (await port.findByKey('plan:acme-org/widget/sprockets.md'))!
    const a = await service.createStream('acme', 'Alpha')
    const b = await service.createStream('acme', 'Beta')
    const child = await service.createStream('acme', 'Beta child', b.id)
    await service.addMember(b.id, nid(WIDGET, 51), 'acme')
    await service.addMember(b.id, nid(WIDGET, 50), 'acme')

    expect(await service.renameStream(a.id, '  Alpha prime ', 'acme')).toMatchObject({ name: 'Alpha prime' })
    await expect(service.renameStream(a.id, ' ', 'acme')).rejects.toMatchObject({ status: 400 })

    expect(await service.setStreamParent(a.id, plan.id, 'acme')).toMatchObject({ parentId: plan.id })
    expect(await service.setStreamParent(a.id, null, 'acme')).not.toHaveProperty('parentId')
    await expect(service.setStreamParent(a.id, a.id, 'acme')).rejects.toMatchObject({ status: 400 })

    await expect(service.mergeStreams(b.id, child.id, 'acme')).rejects.toMatchObject({ status: 400 })
    expect(await service.mergeStreams(b.id, a.id, 'acme')).toEqual({ members: 2, streams: 1 })
    const epics = await service.epics('acme')
    const alpha = epics.find((e) => e.id === a.id)!
    expect(alpha.members.map((x) => x.id).sort()).toEqual([nid(WIDGET, 50), nid(WIDGET, 51)].sort())
    expect(alpha.members.find((x) => x.id === nid(WIDGET, 50))!.title).toBe('Stream teeth')
    expect(epics.find((e) => e.id === child.id)).toMatchObject({ parentId: a.id })
    expect(epics.find((e) => e.id === b.id)).toMatchObject({ status: 'archived', members: [] })
    expect(epics.find((e) => e.id === plan.id)).toMatchObject({ plan: 'plan:acme-org/widget/sprockets.md' })
    expect(busEvents.filter((e) => e.type === 'forge.updated').length).toBeGreaterThan(5)
  })

  it('follows a reassignment made outside Forge with the forge assignee', async () => {
    service.start()
    await service.sync('acme')
    const t = await port.ensureTask(nid(WIDGET, 7), { name: 'Issue 7', membrane: 'acme', kind: 'issue' })
    const reassigned = (newThreadId: string | null) =>
      bus.emit({
        type: 'task.reassigned',
        timestamp: new Date().toISOString(),
        source: 'tasks',
        payload: { taskId: t.id, taskName: t.name, threadId: newThreadId, sourceThreadId: 'th-mcp', newThreadId }
      })
    reassigned('th-mcp')
    const writes = () => forge.calls.filter((c) => c.op === 'setAssignees').map((c) => c.opts)
    expect(await until(() => writes().length === 1)).toBe(true)
    expect(writes()).toEqual([{ id: '7', add: ['hex-agent'], remove: [] }])
    expect((await port.get(t.id))!.state).toBe('in_progress')
    reassigned(null)
    expect(await until(() => writes().length === 2)).toBe(true)
    expect(writes()[1]).toEqual({ id: '7', add: [], remove: ['hex-agent'] })
    // Forge's own writes (source 'forge') are not echoed.
    await port.setThread(t.id, 'th-x')
    await new Promise((r) => setTimeout(r, 30))
    expect(writes()).toHaveLength(2)
  })

  it('auto-links a change a subagent or a CI watch works on to that thread when nobody owns it', async () => {
    const widgetDir = path.join(tmp, 'acme', 'widget')
    service = make({
      overlayPollMs: 20,
      subagents: {
        list: async () => [{ key: 'sub-1', label: 'fix', parentThreadId: 'parent-1', cwd: widgetDir, startedAt: 1 }]
      },
      branchOf: async () => 'feat/50',
      ciWatch: {
        list: () => [{ threadKey: 'th-ci', repo: WIDGET, target: { kind: 'pr', number: 51 }, createdAt: 1 }]
      }
    })
    await service.sync('acme')
    const owned = await port.ensureTask(nid(GADGET, 9), { name: 'G9', membrane: 'acme', kind: 'change' })
    await port.setThread(owned.id, 'someone')
    service.start()
    const ownerOf = async (id: string) => (await port.findByKey(id))?.threadId
    const done = async () =>
      (await ownerOf(nid(WIDGET, 50))) === 'parent-1' && (await ownerOf(nid(WIDGET, 51))) === 'th-ci'
    const end = Date.now() + 3000
    while (!(await done()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    expect(await done()).toBe(true)
    expect(await ownerOf(nid(GADGET, 9))).toBe('someone')
    expect((await port.findByKey(nid(WIDGET, 50)))!.state).toBe('in_progress')
    expect(
      forge.calls
        .filter((c) => c.op === 'setAssignees')
        .map((c) => (c.opts as { id: string }).id)
        .sort()
    ).toEqual(['50', '51'])
  })

  it('a repo two membranes sync: each logs its events and tells its own owner threads', async () => {
    const ms = [
      { id: 'acme', workspaceIds: ['acme-org'] },
      { id: 'beta', workspaceIds: [] }
    ]
    scope = { ...scope, getMembrane: (id) => ms.find((m) => m.id === id), listMembranes: () => ms }
    config = { ...config, repos: { acme: [GADGET], beta: [GADGET] } }
    service = make()
    await service.sync('acme')
    await service.sync('beta')
    await service.assign({ membrane: 'beta', nodeId: nid(GADGET, 9), threadId: 'beta-owner' })
    sent = []
    now += 120_000
    forge.put(change(GADGET, 9, { state: 'merged', updatedAt: new Date(now).toISOString() }))
    now += 60_000
    await service.sync('acme')
    await service.sync('beta')
    const merged = (m: string) => service.events(m).filter((e) => e.type === 'merged' && e.nodeId === nid(GADGET, 9))
    expect(merged('acme')).toHaveLength(1)
    expect(merged('beta')).toHaveLength(1)
    expect(sent).toEqual([{ threadId: 'beta-owner', text: '[PR #9] Merged.' }])
  })

  it('an assignment made while a sync runs keeps its marker in state.json', async () => {
    await service.sync('acme')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let held = false
    const planId = 'plan:acme-org/widget/sprockets.md'
    const find = port.findByKey.bind(port)
    port.findByKey = async (key) => {
      if (key === planId && !held) {
        held = true
        await gate
      }
      return find(key)
    }
    // Plan links an older build left: this sync migrates them and drops them from state.json.
    const file = path.join(tmp, 'data', 'forge', 'acme', 'state.json')
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...prev, planLinks: { [planId]: { named: [], linked: [] } } }))
    now += 120_000
    const syncing = service.sync('acme')
    expect(await until(() => held)).toBe(true)
    await service.assign({ membrane: 'acme', nodeId: nid(WIDGET, 50), threadId: 'owner' })
    release()
    await syncing
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(after.assignedByForge).toEqual({ [nid(WIDGET, 50)]: 'hex-agent' })
    expect(after).not.toHaveProperty('planLinks')
  })

  it('a stream of one membrane takes no members or child streams through another', async () => {
    const ms = [
      { id: 'acme', workspaceIds: ['acme-org'] },
      { id: 'beta', workspaceIds: [] }
    ]
    scope = { ...scope, getMembrane: (id) => ms.find((m) => m.id === id), listMembranes: () => ms }
    config = { ...config, repos: { acme: [WIDGET, GADGET], beta: [WIDGET] } }
    service = make()
    await service.sync('acme')
    await service.sync('beta')
    const stream = await service.createStream('acme', 'Gears')
    await expect(service.addMember(stream.id, nid(WIDGET, 50), 'beta')).rejects.toMatchObject({ status: 404 })
    await expect(service.removeMember(stream.id, nid(WIDGET, 50), 'beta')).rejects.toMatchObject({ status: 404 })
    await expect(service.createStream('beta', 'Sub', stream.id)).rejects.toMatchObject({ status: 404 })
    expect((await port.get(stream.id))!.childIds).toEqual([])
    expect(await service.addMember(stream.id, nid(WIDGET, 50), 'acme')).toMatchObject({ taskId: expect.any(String) })
  })

  describe('routes', () => {
    const app = () => {
      const a = express()
      a.use(createForgeRouter(service, (_req, _res, next) => next()))
      return a
    }

    it('serve the graph, search, overlay, sync, status and validate input', async () => {
      const a = app()
      expect((await request(a).get('/api/forge')).status).toBe(400)
      expect((await request(a).get('/api/forge?membrane=nope')).status).toBe(404)
      const s = await request(a).post('/api/forge/sync?membrane=acme')
      expect(s.status).toBe(200)
      expect(s.body).toMatchObject({ membrane: 'acme', changed: true })
      const g = await request(a).get('/api/forge?membrane=acme')
      expect(g.status).toBe(200)
      expect(g.body.nodes.length).toBeGreaterThan(3)
      expect((await request(a).get(`/api/forge?membrane=acme&since=garbage`)).status).toBe(400)
      expect(
        (await request(a).get('/api/forge/search?membrane=acme&q=teeth')).body.nodes.map((n: { id: string }) => n.id)
      ).toEqual([nid(WIDGET, 50)])
      expect((await request(a).get('/api/forge/search?membrane=acme')).status).toBe(400)
      const ov = await request(a).get('/api/forge/overlay?membrane=acme')
      expect(ov.body).toEqual({ overlays: [], unmatched: [], claims: [] })
      const st = await request(a).get('/api/forge/status?membrane=acme')
      expect(st.body).toMatchObject({ membrane: 'acme', identity: 'hex-agent', plans: 1 })
      expect(st.body.repos.map((r: { repo: string }) => r.repo)).toEqual([WIDGET, GADGET])
      expect((await request(a).post('/api/forge/rethink?membrane=acme')).status).toBe(501)
    })

    it('assign, views, streams, members and suggested edges', async () => {
      const a = app()
      await request(a).post('/api/forge/sync?membrane=acme')
      expect((await request(a).post('/api/forge/assign').send({})).status).toBe(400)
      expect(
        (
          await request(a)
            .post('/api/forge/assign')
            .send({ nodeId: nid(WIDGET, 7) })
        ).status
      ).toBe(400)
      expect(
        (
          await request(a)
            .post('/api/forge/assign')
            .send({ nodeId: 'github:github.com/acme-labs/widget#999', threadId: 't' })
        ).status
      ).toBe(404)
      const as = await request(a)
        .post('/api/forge/assign')
        .send({ nodeId: nid(WIDGET, 7), threadId: 'thread-7', prompt: 'look at this' })
      expect(as.status).toBe(200)
      expect(as.body).toMatchObject({ threadId: 'thread-7' })
      expect(sent).toEqual([{ threadId: 'thread-7', text: 'look at this' }])
      const ov = await request(a).get('/api/forge/overlay?membrane=acme')
      expect(ov.body.overlays).toEqual([
        {
          nodeId: nid(WIDGET, 7),
          thread: { id: 'thread-7', label: 'Thread thread-7', status: 'working' },
          subagents: [],
          waitingOn: null
        }
      ])

      expect((await request(a).get('/api/forge/views?membrane=acme')).body.views).toEqual([
        { id: 'all', membrane: 'acme', title: 'All repos', repos: [], filters: {} }
      ])
      const put = await request(a)
        .put('/api/forge/views?membrane=acme')
        .send({ views: [{ id: 'mine', title: 'Mine', repos: [WIDGET], filters: { authors: ['alex-dev'] } }] })
      expect(put.body.views).toEqual([
        { id: 'mine', membrane: 'acme', title: 'Mine', repos: [WIDGET], filters: { authors: ['alex-dev'] } }
      ])
      const viewed = await request(a).get('/api/forge?membrane=acme&view=mine')
      expect(viewed.body.nodes.every((n: { repo?: string }) => !n.repo || n.repo === WIDGET)).toBe(true)
      expect((await request(a).get('/api/forge?membrane=acme&view=nope')).status).toBe(404)
      expect((await request(a).put('/api/forge/views?membrane=acme').send({ views: 'x' })).status).toBe(400)

      const st = await request(a).post('/api/forge/streams').send({ membrane: 'acme', name: 'Plan 20' })
      expect(st.status).toBe(201)
      expect(st.body).toMatchObject({ name: 'Plan 20', membrane: 'acme', memberCount: 0 })
      const add = await request(a)
        .post(`/api/forge/streams/${encodeURIComponent(st.body.id)}/members`)
        .send({ nodeId: nid(WIDGET, 50) })
      expect(add.status).toBe(200)
      const g = await request(a).get('/api/forge?membrane=acme')
      // Beside the plan's own stream (the fixture plan names #50 and gadget#9: related, not members;
      // #50 owned by Plan 20 stays related to it).
      expect(g.body.workstreams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: st.body.id, memberCount: 1, relatedCount: 0 }),
          expect.objectContaining({ name: 'Sprocket rework', memberCount: 0, relatedCount: 2 })
        ])
      )
      const plan = g.body.workstreams.find((w: { name: string }) => w.name === 'Sprocket rework')
      expect(g.body.nodes.find((n: { id: string }) => n.id === nid(WIDGET, 50))).toMatchObject({
        workstreams: [st.body.id],
        relatedStreams: [plan.id]
      })
      expect(
        (
          await request(a)
            .delete(`/api/forge/streams/${encodeURIComponent(st.body.id)}/members`)
            .send({ nodeId: nid(WIDGET, 50) })
        ).status
      ).toBe(200)
      expect(
        (
          await request(a)
            .delete(`/api/forge/streams/${encodeURIComponent(st.body.id)}/members`)
            .send({ nodeId: nid(WIDGET, 50) })
        ).status
      ).toBe(404)
      expect(
        (
          await request(a)
            .post('/api/forge/streams/nope/members')
            .send({ nodeId: nid(WIDGET, 50) })
        ).status
      ).toBe(404)

      // Status: archived is gone from the graph, back with ?archived=1; any other status brings it back.
      expect(st.body).toMatchObject({ status: 'planned' })
      const arch = `/api/forge/streams/${encodeURIComponent(st.body.id)}/status`
      expect((await request(a).post(arch).send({ membrane: 'acme', status: 'done' })).status).toBe(400)
      expect((await request(a).post(arch).send({ membrane: 'acme' })).status).toBe(400)
      const archived = await request(a).post(arch).send({ membrane: 'acme', status: 'archived' })
      expect(archived.body).toMatchObject({ id: st.body.id, status: 'archived' })
      const ids = async (q = '') =>
        (await request(a).get(`/api/forge?membrane=acme${q}`)).body.workstreams.map((w: { id: string }) => w.id)
      expect(await ids()).not.toContain(st.body.id)
      expect(await ids('&archived=1')).toContain(st.body.id)
      const listed = async (q = '') =>
        (await request(a).get(`/api/forge/streams?membrane=acme${q}`)).body.streams.map((w: { id: string }) => w.id)
      expect(await listed()).not.toContain(st.body.id)
      expect(await listed('&archived=1')).toContain(st.body.id)
      expect((await request(a).get('/api/forge/streams')).status).toBe(400)
      expect((await request(a).post(arch).send({ membrane: 'acme', status: 'active' })).body).toMatchObject({
        status: 'active'
      })
      expect(await ids()).toContain(st.body.id)
      expect((await port.get(st.body.id))!.state).toBe('in_progress')

      await port.addRelated('acme', {
        from: nid(WIDGET, 50),
        to: nid(WIDGET, 7),
        kind: 'related',
        reason: 'same sprocket',
        confidence: 0.8,
        source: 'rethink'
      })
      const enc = (s: string) => encodeURIComponent(s)
      const accept = await request(a).post(
        `/api/forge/edges/${enc(nid(WIDGET, 50))}/${enc(nid(WIDGET, 7))}/related/accept`
      )
      expect(accept.status).toBe(200)
      const after = await request(a).get('/api/forge?membrane=acme')
      expect(after.body.edges.find((e: { kind: string }) => e.kind === 'related')).toMatchObject({
        source: 'user',
        reason: 'same sprocket'
      })
      expect(
        (await request(a).delete(`/api/forge/edges/${enc(nid(WIDGET, 50))}/${enc(nid(WIDGET, 7))}/related`)).status
      ).toBe(200)
      expect(
        (await request(a).delete(`/api/forge/edges/${enc(nid(WIDGET, 50))}/${enc(nid(WIDGET, 7))}/related`)).status
      ).toBe(404)
      expect((await request(a).delete(`/api/forge/edges/a/b/bogus`)).status).toBe(400)
    })
  })
})
