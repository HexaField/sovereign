import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type BusEvent, type EventBus, type WorkNode } from '@sovereign/core'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRethinkPrompt,
  createRethinkRunner,
  projectOfRepo,
  renderRunReport,
  runIdFor,
  type RethinkRun,
  type RethinkRunner,
  type RethinkUsage
} from './rethink.js'
import { createRethinkRouter } from './rethink-routes.js'
import type { ScopeSource } from './scope.js'
import { createForgeService, type ForgeService } from './service.js'
import { change, createFakeForge, createTestTaskPort, type FakeForge, type TestTaskPort } from './testing.js'
import type { ForgeConfig, ForgeDigest, TriagedEvent } from './types.js'

const WIDGET = 'acme-labs/widget'
const NOW = Date.parse('2026-10-16T08:30:00Z')
const nid = (n: number) => `github:github.com/${WIDGET}#${n}`

function checkout(dir: string, remote: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n`)
}

const node = (n: number, over: Partial<WorkNode> = {}): WorkNode => ({
  id: nid(n),
  forge: 'github',
  kind: 'change',
  repo: WIDGET,
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/${WIDGET}/pull/${n}`,
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
  ...over
})

const ev = (n: number, type: TriagedEvent['type'], detail: Record<string, unknown> = {}): TriagedEvent => ({
  at: '2026-10-15T10:00:00.000Z',
  nodeId: nid(n),
  type,
  detail,
  triage: 'needs-agent',
  tier: 'rule'
})

describe('buildRethinkPrompt', () => {
  it('lays out jobs, limits, tools and the digest grouped by stream and node', () => {
    const digest: ForgeDigest = {
      membrane: 'acme',
      since: '2026-10-15T08:30:00.000Z',
      cursor: '2026-10-15T10:00:00.000Z',
      count: 3,
      groups: [
        {
          stream: { id: 'stream-1', name: 'Sprockets' },
          nodes: [
            {
              node: node(50, {
                title: 'Stream teeth',
                ci: 'failing',
                status: 'CI red: integration-tests',
                reviewers: [{ login: 'kim', state: 'changes_requested' }],
                branch: { head: 'feat/50', base: 'dev', ahead: 3, behind: 4, conflict: true },
                workstreams: ['stream-1']
              }),
              events: [
                ev(50, 'ci_failed', { failed: ['integration-tests'] }),
                ev(50, 'reviewed', { login: 'kim', state: 'changes_requested' })
              ]
            }
          ]
        },
        {
          stream: null,
          nodes: [
            {
              node: node(7, { kind: 'issue', title: 'Gear slips', url: `https://github.com/${WIDGET}/issues/7` }),
              events: [
                {
                  ...ev(7, 'commented', { author: 'sam', text: ['@hex-agent can you look?'] }),
                  tier: 'model-low',
                  confidence: 0.55
                }
              ]
            }
          ]
        }
      ]
    }
    const prompt = buildRethinkPrompt({
      membrane: 'acme',
      runId: '2026-10-16-0830',
      digest,
      limits: { maxJobs: 6, tokenBudget: 200_000 },
      owners: new Map([[nid(50), { threadId: 'owner-1', label: 'Sprocket worker', status: 'idle' }]]),
      streams: [{ id: 'stream-1', name: 'Sprockets', membrane: 'acme', memberCount: 2 }]
    })
    expect(prompt).toMatchSnapshot()
  })
})

describe('renderRunReport', () => {
  it('summarises digest, actions, limits and usage', () => {
    const run: RethinkRun = {
      id: '2026-10-16-0830',
      membrane: 'acme',
      trigger: 'schedule',
      status: 'done',
      startedAt: '2026-10-16T08:30:00.000Z',
      endedAt: '2026-10-16T08:34:00.000Z',
      threadId: 'rt-1',
      digest: {
        events: 2,
        nodes: 1,
        streams: 0,
        items: [{ nodeId: nid(50), ref: `${WIDGET}#50`, title: 'Stream teeth', events: ['ci_failed', 'conflict'] }]
      },
      limits: { maxJobs: 1, tokenBudget: 1000 },
      actions: [
        { kind: 'relate', at: 'x', from: nid(50), to: nid(51), reason: 'same gear train', confidence: 0.8 },
        {
          kind: 'dispatch',
          at: 'x',
          nodeId: nid(50),
          threadId: 'owner-1',
          threadLabel: 'Worker',
          newThread: false,
          prompt: 'Fix CI'
        },
        { kind: 'refused', at: 'x', tool: 'forge_dispatch', reason: 'job limit: 1 dispatch per run' },
        { kind: 'note', at: 'x', nodeId: nid(51), text: 'Looks stale' }
      ],
      limitsHit: ['job limit: 1 dispatch per run'],
      usage: { tokens: 1500, input: 1000, output: 300, cacheWrite: 200, cacheRead: 9000 }
    }
    const md = renderRunReport(run)
    expect(md).toContain('# Forge rethink — acme — 2026-10-16-0830')
    expect(md).toContain('2 events on 1 item in 0 streams.')
    expect(md).toContain(`- ${nid(50)} → ${nid(51)} (0.8): same gear train`)
    expect(md).toContain('### Dispatched jobs (1 of 1)')
    expect(md).toContain('- Hit: job limit: 1 dispatch per run')
    expect(md).toContain('1,500 fresh tokens (input 1,000, cache writes 200, output 300); cache reads 9,000.')
    expect(md).not.toContain('Bug-report drafts')
  })

  it('names runs by local date and time', () => {
    const d = new Date(2026, 9, 16, 8, 5)
    expect(runIdFor(d.getTime())).toBe('2026-10-16-0805')
  })
})

describe('rethink runner', () => {
  let tmp: string
  let forge: FakeForge
  let port: TestTaskPort
  let bus: EventBus
  let service: ForgeService
  let runner: RethinkRunner
  let config: Partial<ForgeConfig>
  let now: number
  let threads: Map<string, { label: string; membrane: string; busy: boolean }>
  let sent: Array<{ threadId: string; text: string }>
  let posted: string[]
  let drafts: Array<{ title: string; body: string; orgId: string | null; projectId: string | null }>
  let listeners: Map<string, Set<(s: string) => void>>
  let usage: RethinkUsage | undefined
  let events: BusEvent[]
  const dataDir = () => path.join(tmp, 'data')

  const status = (threadId: string, s: string) => {
    threads.get(threadId)!.busy = s !== 'idle'
    for (const cb of listeners.get(threadId) ?? []) cb(s)
  }

  function makeRunner(over: { runTimeoutMs?: number } = {}) {
    return createRethinkRunner({
      dataDir: dataDir(),
      service: () => service,
      threads: {
        find: (m, label) => [...threads].find(([, t]) => t.membrane === m && t.label === label)?.[0],
        exists: (id) => threads.has(id),
        membraneOf: (id) => threads.get(id)?.membrane,
        create: async (m, label) => {
          const id = `thread-${threads.size + 1}`
          threads.set(id, { label, membrane: m, busy: false })
          return id
        },
        label: (id) => threads.get(id)?.label,
        busy: (id) => threads.get(id)?.busy ?? false,
        send: async (threadId, text) => void sent.push({ threadId, text }),
        onStatus: (id, cb) => {
          const set = listeners.get(id) ?? new Set()
          set.add(cb)
          listeners.set(id, set)
          return () => set.delete(cb)
        }
      },
      presence: { post: async (text) => void posted.push(text) },
      drafts: {
        create: (d) => {
          drafts.push(d)
          return { id: `draft-${drafts.length}` }
        }
      },
      projectOf: (_m, repo) => (repo === WIDGET ? { orgId: 'acme-org', projectId: 'widget' } : undefined),
      usage: () => usage,
      bus,
      now: () => now,
      log: () => {},
      ...over
    })
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-rethink-'))
    now = NOW
    threads = new Map([['owner-1', { label: 'Sprocket worker', membrane: 'acme', busy: false }]])
    sent = []
    posted = []
    drafts = []
    listeners = new Map()
    usage = undefined
    events = []
    const widgetDir = path.join(tmp, 'acme', 'widget')
    checkout(widgetDir, 'git@github.com:acme-labs/widget.git')
    const membranes = [{ id: 'acme', workspaceIds: ['acme-org'] }]
    const scope: ScopeSource = {
      getMembrane: (id) => membranes.find((m) => m.id === id),
      listMembranes: () => membranes,
      getOrg: (id) => (id === 'acme-org' ? { id, path: path.join(tmp, 'acme') } : undefined),
      listProjects: (orgId) => (orgId === 'acme-org' ? [{ id: 'widget', name: 'widget', repoPath: widgetDir }] : [])
    }
    config = {
      enabled: true,
      identities: { github: 'hex-agent' },
      repos: { acme: [WIDGET] },
      rethink: { times: ['08:30'], maxJobs: 2, tokenBudget: 10_000 }
    }
    forge = createFakeForge()
    forge.put(change(WIDGET, 50, { updatedAt: '2026-10-15T00:00:00Z', title: 'Stream teeth' }))
    forge.put(change(WIDGET, 51, { updatedAt: '2026-10-14T00:00:00Z', title: 'Gear ratio' }))
    forge.put(change(WIDGET, 52, { updatedAt: '2026-10-13T00:00:00Z', title: 'Axle grease' }))
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    bus = createEventBus(path.join(tmp, 'bus'))
    bus.on('forge.*', (e) => void events.push(e))
    runner = makeRunner()
    service = createForgeService({
      dataDir: dataDir(),
      config: () => config,
      scope,
      forgeRegistry: { forgeFor: () => forge },
      tasks: port,
      bus,
      threads: {
        createThread: async (m, label) => {
          const id = `thread-${threads.size + 1}`
          threads.set(id, { label, membrane: m, busy: false })
          return id
        },
        sendToThread: async (threadId, text) => void sent.push({ threadId, text }),
        presence: (id) => (threads.has(id) ? { label: threads.get(id)!.label, status: 'idle' } : undefined)
      },
      runRethink: (m, d, o) => runner.run(m, d, o),
      rethinkNotes: (m) => runner.notes(m),
      now: () => now,
      log: () => {}
    })
    await service.sync('acme')
    await service.assign({ nodeId: nid(50), threadId: 'owner-1' })
    // CI red on the owned change → a needs-agent event.
    forge.changes.get(WIDGET)!.find((c) => c.ref.id === '50')!.checks = { state: 'failing' }
    forge.checkResults.set(`${WIDGET}#50`, { state: 'failing', failed: ['integration-tests'] })
    now += 120_000
    await service.sync('acme', 'open')
    sent = []
  })
  afterEach(() => {
    runner.stop()
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('runs in one forge-rethink thread, reused across runs and restarts; the turn end closes the run', async () => {
    const res = await service.rethink('acme')
    expect(res).toMatchObject({ ran: true, count: 1, runId: runIdFor(now) })
    const rt = runner.threadOf('acme')!
    expect(threads.get(rt)).toMatchObject({ label: 'forge-rethink', membrane: 'acme' })
    expect(sent).toHaveLength(1)
    expect(sent[0].threadId).toBe(rt)
    expect(sent[0].text).toContain('[Forge rethink · acme · run')
    expect(sent[0].text).toContain(`id: \`${nid(50)}\``)
    expect(sent[0].text).toContain('Owner: thread "Sprocket worker" (`owner-1`)')
    expect(runner.active('acme')?.status).toBe('running')
    await expect(runner.run('acme', await service.digest('acme', '1970-01-01T00:00:00Z'))).rejects.toMatchObject({
      status: 409
    })
    const report = path.join(dataDir(), 'forge', 'acme', 'rethink', `${res.runId}.md`)
    expect(fs.readFileSync(report, 'utf8')).toContain('- Status: running')

    status(rt, 'working')
    status(rt, 'idle')
    expect(runner.active('acme')).toBeUndefined()
    expect(fs.readFileSync(report, 'utf8')).toContain('- Status: done')
    expect(runner.runs('acme')).toEqual([
      expect.objectContaining({ id: res.runId, status: 'done', trigger: 'manual', events: 1, path: report })
    ])
    expect(
      events.filter((e) => e.type === 'forge.rethink').map((e) => (e.payload as { status: string }).status)
    ).toEqual(['running', 'done'])

    // Empty digest: no run.
    expect(await service.rethink('acme')).toEqual({ ran: false, count: 0 })

    // A restarted runner finds the thread from its state file.
    runner = makeRunner()
    now += 60_000
    await runner.run('acme', await service.digest('acme', '1970-01-01T00:00:00Z'))
    expect(sent[1].threadId).toBe(rt)
    expect([...threads.values()].filter((t) => t.label === 'forge-rethink')).toHaveLength(1)
  })

  it('a thread busy at the start goes idle once before the run turn', async () => {
    const res = await service.rethink('acme')
    const rt = runner.threadOf('acme')!
    status(rt, 'working')
    status(rt, 'idle')
    // that run is done; start one while the thread works on something else
    expect(runner.active('acme')).toBeUndefined()
    status(rt, 'working')
    now += 60_000
    await runner.run('acme', await service.digest('acme', '1970-01-01T00:00:00Z'))
    status(rt, 'idle')
    expect(runner.active('acme')).toBeDefined()
    status(rt, 'working')
    status(rt, 'idle')
    expect(runner.active('acme')).toBeUndefined()
    expect(res.runId).toBeDefined()
  })

  it('a run a crashed server left open reads as interrupted', async () => {
    const { runId } = await runner.run('acme', await service.digest('acme'))
    // A new runner (restart) never saw it close.
    runner = makeRunner()
    expect(runner.runs('acme')[0]).toMatchObject({ id: runId, status: 'failed' })
    expect(runner.report('acme', runId)).toContain('- Error: interrupted: the server stopped during the run')
  })

  it('times out a run whose turn never ends', async () => {
    vi.useFakeTimers()
    try {
      runner = makeRunner({ runTimeoutMs: 1000 })
      const { runId } = await runner.run('acme', await service.digest('acme'))
      vi.advanceTimersByTime(1001)
      expect(runner.active('acme')).toBeUndefined()
      expect(runner.report('acme', runId)).toContain('- Status: timed-out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('tools: related edge (dashed, rethink), note and stream on the card; one attention message; bug draft only as a draft', async () => {
    const { runId } = (await service.rethink('acme')) as { runId: string }
    const rt = runner.threadOf('acme')!
    const call = (name: Parameters<RethinkRunner['tool']>[1], args: Record<string, unknown>) =>
      runner.tool(rt, name, { membrane: 'acme', ...args })

    expect(
      await call('forge_relate', { from: nid(50), to: nid(51), reason: 'same gear train', confidence: 0.8 })
    ).toMatchObject({
      added: true
    })
    await expect(call('forge_relate', { from: nid(50), to: 'nope', reason: 'x', confidence: 0.5 })).rejects.toThrow(
      /node not found/
    )
    expect(await call('forge_note', { nodeId: nid(51), text: 'Looks stale since the gear rework' })).toEqual({
      noted: true
    })
    const stream = await service.createStream('acme', 'Gears')
    expect(await call('forge_stream_add', { nodeId: nid(51), streamId: stream.id })).toMatchObject({ added: true })

    expect(
      await call('forge_attention', {
        items: [{ nodeId: nid(50), text: 'Merge decision needed' }, { text: 'Two drafts to approve' }]
      })
    ).toEqual({
      posted: true,
      items: 2
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('**Forge · acme — needs your attention**')
    expect(posted[0]).toContain(
      `[${WIDGET}#50](https://github.com/${WIDGET}/pull/50) Stream teeth: Merge decision needed`
    )
    expect(posted[0]).toContain('- Two drafts to approve')
    expect(await call('forge_attention', { items: [{ text: 'again' }] })).toMatchObject({
      refused: expect.stringMatching(/one forge_attention/)
    })
    expect(posted).toHaveLength(1)

    const callsBefore = forge.calls.length
    expect(
      await call('forge_bug_draft', {
        repo: WIDGET,
        title: 'Integration tests flake on teeth',
        body: 'The same check fails on both changes.',
        evidence: [nid(50), nid(51)]
      })
    ).toMatchObject({ draftId: 'draft-1', status: 'draft' })
    expect(forge.calls.slice(callsBefore)).toEqual([])
    expect(drafts[0]).toMatchObject({
      title: 'Integration tests flake on teeth',
      orgId: 'acme-org',
      projectId: 'widget'
    })
    expect(drafts[0].body).toContain(`- ${WIDGET}#50 Stream teeth — https://github.com/${WIDGET}/pull/50`)
    // A draft becomes a forge issue: local items (plans, tasks) never go in one.
    fs.mkdirSync(path.join(tmp, 'acme', 'widget', 'plans'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'acme', 'widget', 'plans', 'gears.md'), '# Private gear plan\n')
    await service.sync('acme')
    const plan = (await service.graph('acme')).nodes.find((n) => n.kind === 'plan')
    expect(plan).toBeDefined()
    await expect(
      call('forge_bug_draft', { repo: WIDGET, title: 'x', body: 'y', evidence: [nid(50), plan!.id] })
    ).rejects.toThrow(/stay private/)
    expect(drafts).toHaveLength(1)

    const g = await service.graph('acme')
    const edge = g.edges.find((e) => e.kind === 'related' && e.from === nid(50) && e.to === nid(51))
    expect(edge).toMatchObject({ source: 'rethink', dashed: true, reason: 'same gear train', confidence: 0.8 })
    const n51 = g.nodes.find((n) => n.id === nid(51))!
    expect(n51.workstreams).toContain(stream.id)
    expect(n51.rethink?.map((r) => [r.kind, r.runId])).toEqual([
      ['note', runId],
      ['draft', runId]
    ])
    expect(g.nodes.find((n) => n.id === nid(50))!.rethink?.map((r) => r.kind)).toEqual(['attention', 'draft'])

    const md = runner.report('acme', runId)!
    expect(md).toContain('### Related edges')
    expect(md).toContain('### Stream memberships')
    expect(md).toContain('- Integration tests flake on teeth (acme-labs/widget) — draft `draft-1`')
    expect(md).toContain('### Needs your attention')
    expect(md).toContain(`- ${nid(51)}: Looks stale since the gear rework`)
    expect(md).toContain('- forge_attention: one forge_attention per run')
  })

  it('limits: max jobs, token budget, no new thread outside a stream', async () => {
    await service.rethink('acme')
    const rt = runner.threadOf('acme')!
    const dispatch = (n: number, prompt = 'Fix the failing integration tests') =>
      runner.tool(rt, 'forge_dispatch', { membrane: 'acme', nodeId: nid(n), prompt })

    expect(await dispatch(50)).toMatchObject({ dispatched: true, threadId: 'owner-1', newThread: false, jobsLeft: 1 })
    expect(sent[sent.length - 1]).toMatchObject({ threadId: 'owner-1' })
    expect(sent[sent.length - 1].text).toMatch(
      /^\[Forge rethink · \d{4}-\d{2}-\d{2}-\d{4}\] acme-labs\/widget#50 "Stream teeth"/
    )

    // No owner, no stream: refused, no thread made.
    const before = threads.size
    expect(await dispatch(52)).toMatchObject({
      refused: expect.stringMatching(/no owner thread and is in no work stream/)
    })
    expect(threads.size).toBe(before)

    // Over budget: refused.
    usage = { tokens: 12_000, input: 10_000, output: 1000, cacheWrite: 1000, cacheRead: 50_000 }
    expect(await dispatch(50)).toMatchObject({ refused: expect.stringMatching(/token budget: 12,000 of 10,000/) })
    usage = { tokens: 100, input: 100, output: 0, cacheWrite: 0, cacheRead: 0 }

    // In a stream with no owner: a new thread for it.
    const stream = await service.createStream('acme', 'Axles')
    await service.addMember(stream.id, nid(52), 'acme')
    const r = await dispatch(52, 'Pick this up')
    expect(r).toMatchObject({ dispatched: true, newThread: true })
    expect(threads.get(r.threadId as string)?.label).toBe('Axle grease')
    expect((await port.findByKey(nid(52)))?.threadId).toBe(r.threadId)

    // Job limit (2).
    expect(await dispatch(50)).toMatchObject({ refused: 'job limit: 2 dispatches per run' })

    status(rt, 'working')
    status(rt, 'idle')
    const run = runner.runs('acme')[0]
    expect(run.actions).toMatchObject({ dispatch: 2, refused: 3 })
    const md = runner.report('acme', run.id)!
    expect(md).toContain('### Dispatched jobs (2 of 2)')
    expect(md).toContain('- Hit: token budget: 12,000 of 10,000 fresh tokens spent; no more dispatches this run')
    expect(md).toContain('- Hit: job limit: 2 dispatches per run')
    expect(md).toContain('100 fresh tokens')
    const n50 = (await service.graph('acme')).nodes.find((n) => n.id === nid(50))!
    expect(n50.rethink?.[0]).toMatchObject({
      kind: 'dispatch',
      text: expect.stringContaining('Sent to "Sprocket worker"')
    })
  })

  it('parallel tool calls in one turn still respect the job limit and the one attention post', async () => {
    await service.rethink('acme')
    const rt = runner.threadOf('acme')!
    const call = (name: Parameters<RethinkRunner['tool']>[1], args: Record<string, unknown>) =>
      runner.tool(rt, name, { membrane: 'acme', ...args })
    const results = await Promise.all(
      [1, 2, 3].map((i) => call('forge_dispatch', { nodeId: nid(50), prompt: `job ${i}` }))
    )
    expect(results.filter((r) => r.dispatched)).toHaveLength(2)
    expect(results.filter((r) => r.refused)).toHaveLength(1)
    expect(sent.filter((s) => s.threadId === 'owner-1')).toHaveLength(2)

    const posts = await Promise.all([1, 2].map((i) => call('forge_attention', { items: [{ text: `item ${i}` }] })))
    expect(posts.filter((r) => r.posted)).toHaveLength(1)
    expect(posted).toHaveLength(1)
  })

  it('forge_dispatch to a given thread only reaches a thread of the membrane or an owner of its items', async () => {
    threads.set('elsewhere', { label: 'Other membrane', membrane: 'other', busy: false })
    threads.set('acme-chat', { label: 'Acme chat', membrane: 'acme', busy: false })
    await service.rethink('acme')
    const rt = runner.threadOf('acme')!
    const dispatch = (threadId: string) =>
      runner.tool(rt, 'forge_dispatch', { membrane: 'acme', nodeId: nid(50), threadId, prompt: 'look' })
    await expect(dispatch('elsewhere')).rejects.toMatchObject({ status: 403 })
    expect(sent.some((s) => s.threadId === 'elsewhere')).toBe(false)
    expect(await dispatch('acme-chat')).toMatchObject({ dispatched: true, threadId: 'acme-chat' })
    threads.get('owner-1')!.membrane = 'other'
    expect(await dispatch('owner-1')).toMatchObject({ dispatched: true, threadId: 'owner-1' })
  })

  it('two runs started together make one rethink thread', async () => {
    const digest = await service.digest('acme')
    const results = await Promise.allSettled([runner.run('acme', digest), runner.run('acme', digest)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect([...threads.values()].filter((t) => t.label === 'forge-rethink')).toHaveLength(1)
  })

  it('tools only work in the membrane rethink thread; outside a run they open a chat run', async () => {
    await expect(
      runner.tool('owner-1', 'forge_note', { membrane: 'acme', nodeId: nid(50), text: 'x' })
    ).rejects.toMatchObject({
      status: 403
    })
    await service.rethink('acme')
    const rt = runner.threadOf('acme')!
    await expect(
      runner.tool(rt, 'forge_note', { membrane: 'other', nodeId: nid(50), text: 'x' })
    ).rejects.toMatchObject({
      status: 403
    })
    status(rt, 'working')
    status(rt, 'idle')
    expect(runner.membraneOfThread(rt)).toBe('acme')
    now += 60_000
    await runner.tool(rt, 'forge_note', { membrane: 'acme', nodeId: nid(50), text: 'Checked by hand' })
    expect(runner.active('acme')).toMatchObject({ trigger: 'chat' })
    status(rt, 'idle')
    expect(runner.active('acme')).toBeUndefined()
    expect(runner.runs('acme').map((r) => r.trigger)).toEqual(['chat', 'manual'])
  })

  it('finds the org and project whose checkout is a repo (for publishing a draft)', () => {
    const widgetDir = path.join(tmp, 'acme', 'widget')
    const scope: ScopeSource = {
      getMembrane: (id) => (id === 'acme' ? { id, workspaceIds: ['acme-org'] } : undefined),
      listMembranes: () => [],
      getOrg: () => undefined,
      listProjects: () => [{ id: 'widget', name: 'widget', repoPath: widgetDir }]
    }
    expect(projectOfRepo(scope, 'acme', 'Acme-Labs/Widget')).toEqual({ orgId: 'acme-org', projectId: 'widget' })
    expect(projectOfRepo(scope, 'acme', 'acme-labs/gadget')).toBeUndefined()
    expect(projectOfRepo(scope, 'other', WIDGET)).toBeUndefined()
  })

  it('routes: runs list and markdown report', async () => {
    const { runId } = (await service.rethink('acme')) as { runId: string }
    const app = express()
    app.use(createRethinkRouter(runner, (_q, _s, next) => next()))
    const list = await request(app).get('/api/forge/rethink/runs?membrane=acme').expect(200)
    expect(list.body).toMatchObject({
      membrane: 'acme',
      active: { id: runId },
      runs: [{ id: runId, status: 'running' }]
    })
    const md = await request(app).get(`/api/forge/rethink/runs/${runId}?membrane=acme`).expect(200)
    expect(md.headers['content-type']).toMatch(/text\/markdown/)
    expect(md.text).toContain(`# Forge rethink — acme — ${runId}`)
    await request(app).get('/api/forge/rethink/runs/../../state?membrane=acme').expect(404)
    await request(app).get('/api/forge/rethink/runs/2020-01-01-0000?membrane=acme').expect(404)
    await request(app).get('/api/forge/rethink/runs').expect(400)
  })
})
