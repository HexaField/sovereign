// S44: the Forge work graph (packages/work-graph) end to end against the mock
// GitHub. Sovereign's config (docker/config.json) turns forge on, points
// github.com at the mock with a fake token and gives the membrane "forge-wt"
// two repos. The scenario seeds a stack, a pair across repos, a closing
// reference and an old merge; reads /api/forge; assigns a change to a thread
// (a GitHub assignee write); then merges, fails CI and requests changes on
// the mock, syncs, and checks the graph, the task status line, the event log
// with its triage, the owner-thread notification and the assignee removal.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const M = 'forge-wt'
const W = 'acme-labs/widget'
const G = 'acme-labs/gadget'
const id = (repo: string, n: number) => `github:github.com/${repo}#${n}`
const SHA = (c: string) => c.repeat(40)

const SEED = {
  viewer: 'hex-agent',
  repos: [
    {
      repo: W,
      defaultBranch: 'dev',
      branches: [
        { name: 'stack/1', sha: SHA('1'), ahead: 2, behind: 0 },
        { name: 'stack/2', sha: SHA('2'), ahead: 1, behind: 0 },
        { name: 'feat/teeth', sha: SHA('3'), ahead: 4, behind: 3 },
        { name: 'old/thing', sha: SHA('4') }
      ],
      issues: [{ number: 10, title: 'Tooth cache leaks', author: 'sam-reporter' }],
      pulls: [
        {
          number: 1,
          title: 'Ancient cog cleanup',
          head: 'old/thing',
          state: 'MERGED',
          author: 'alex-dev',
          createdAt: '2025-01-02T09:00:00Z',
          updatedAt: '2025-01-03T09:00:00Z',
          closedAt: '2025-01-03T09:00:00Z',
          mergedAt: '2025-01-03T09:00:00Z'
        },
        {
          number: 2,
          title: 'Stack 1: gear model',
          head: 'stack/1',
          base: 'dev',
          author: 'alex-dev',
          mergeable: 'MERGEABLE'
        },
        {
          number: 3,
          title: 'Stack 2: gear API',
          head: 'stack/2',
          base: 'stack/1',
          author: 'alex-dev',
          reviewRequests: ['jo-maintainer']
        },
        {
          number: 4,
          title: 'Stream the tooth cache',
          body: 'Streams it.\n\n> ### Paired with: acme-labs/gadget#5\n\nCloses #10',
          head: 'feat/teeth',
          base: 'dev',
          author: 'kit-bot',
          assignees: ['kit-bot'],
          mergeable: 'MERGEABLE'
        }
      ],
      checks: [{ sha: SHA('3'), runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }]
    },
    {
      repo: G,
      defaultBranch: 'main',
      pulls: [
        {
          number: 5,
          title: 'Gadget side of the stream',
          head: 'feat/teeth',
          author: 'kit-bot',
          body: '> ### Paired with: acme-labs/widget#4'
        }
      ]
    }
  ]
}

export const s45ForgeWorkGraph: Scenario = {
  id: 's45',
  name: 'Forge Work Graph',
  description:
    'work graph vs the mock GitHub: graph, stacks, pairs, assign → assignee, merge/CI/review → task state, events, notification',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const mock = ctx.mockGithubUrl
    const problems: string[] = []
    const metrics: Record<string, unknown> = {}
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(what)
    }
    const control = async (action: string, body?: unknown) => {
      const res = await fetch(`${mock}/mock/github/${action}`, {
        method: body === undefined && (action === 'log' || action === 'state') ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      if (!res.ok) throw new Error(`mock ${action} → ${res.status} ${await res.text()}`)
      return res.json() as Promise<any>
    }
    const graph = () => client.timed('forge-graph', () => client.get(`/api/forge?membrane=${M}`))
    const sync = () => client.timed('forge-sync', () => client.post(`/api/forge/sync?membrane=${M}`))
    const node = (g: any, nid: string) => g.nodes.find((n: any) => n.id === nid)
    const edge = (g: any, from: string, to: string, kind: string) =>
      g.edges.some(
        (e: any) =>
          e.kind === kind && ((e.from === from && e.to === to) || (kind === 'paired' && e.from === to && e.to === from))
      )

    let threadId: string | undefined
    const done = (): ScenarioResult => ({
      passed: problems.length === 0,
      summary: problems.length
        ? `${problems.length} problem(s): ${problems.slice(0, 4).join('; ')}`
        : 'graph, task sync, events and assignees all follow the mock',
      metrics: { ...metrics, problems },
      samples: client.samples.filter((s) => s.name.startsWith('forge'))
    })

    await control('reset')
    await control('seed', SEED)
    const existing = (await client.membranes()).find((m: any) => m.id === M)
    if (!existing) await client.post('/api/membranes', { id: M, name: 'Forge wind tunnel', workspaceIds: [] })

    try {
      // ── 1. First sync: the 21-day window + open items ────────────────
      // (The background loop may have run the first sync already; this one waits for it.)
      metrics.firstSync = await sync()
      let g = await graph()
      metrics.nodes = g.nodes.length
      metrics.edges = g.edges.length
      for (const n of [id(W, 2), id(W, 3), id(W, 4), id(W, 10), id(G, 5)])
        check(Boolean(node(g, n)), `missing node ${n}`)
      check(!node(g, id(W, 1)), 'the 2025 merge is outside the 21-day window')
      check(
        node(g, id(W, 2))?.zone === 'present' && node(g, id(W, 10))?.zone === 'future',
        'zones of open change / open issue'
      )
      check(edge(g, id(W, 3), id(W, 2), 'base'), 'stack: #3 → #2 base edge')
      check(edge(g, id(W, 2), 'github:github.com/acme-labs/widget@dev', 'base'), 'stack bottom → dev branch node')
      check(edge(g, id(W, 4), id(G, 5), 'paired'), 'paired edge widget#4 ↔ gadget#5')
      check(edge(g, id(W, 4), id(W, 10), 'closes'), 'closes edge #4 → #10')
      check(node(g, id(W, 4))?.branch?.behind === 3, `compare: #4 behind ${node(g, id(W, 4))?.branch?.behind}`)

      // Search reaches beyond the window once the backfill has read history.
      let found: any[] = []
      for (let i = 0; i < 40 && !found.length; i++) {
        found = (await client.get(`/api/forge/search?membrane=${M}&q=ancient`)).nodes
        if (!found.length) await new Promise((r) => setTimeout(r, 250))
      }
      check(
        found.some((n: any) => n.id === id(W, 1)),
        'search finds the backfilled 2025 merge'
      )

      // ── 2. Assign #4 to a thread: the task, and the assignee on GitHub ─
      const thread = await client.createThread({ label: 'S44 forge owner', membraneId: M })
      threadId = thread.id
      const assigned = await client.timed('forge-assign', () =>
        client.post('/api/forge/assign', { nodeId: id(W, 4), threadId })
      )
      check(assigned.threadId === threadId && Boolean(assigned.taskId), `assign → ${JSON.stringify(assigned)}`)
      let state = await control('state')
      const pr4 = (s: any) => s.repos.find((r: any) => r.repo === W).pulls.find((p: any) => p.number === 4)
      check(
        JSON.stringify(pr4(state).assignees) === JSON.stringify(['kit-bot', 'hex-agent']),
        `assignees after assign: ${pr4(state).assignees}`
      )

      // ── 3. Mutate on GitHub: merge #2, CI red on #4, changes requested on #3
      await control('merge', { repo: W, number: 2 })
      await control('checks', {
        repo: W,
        pr: 4,
        runs: [{ name: 'integration-tests', status: 'completed', conclusion: 'failure' }]
      })
      await control('review', { repo: W, number: 3, login: 'jo-maintainer', state: 'CHANGES_REQUESTED' })
      const after = await sync()
      metrics.secondSync = after
      g = await graph()

      check(
        node(g, id(W, 2))?.state === 'merged' && node(g, id(W, 2))?.zone === 'past',
        `#2 merged → ${node(g, id(W, 2))?.state}`
      )
      check(edge(g, id(W, 2), 'github:github.com/acme-labs/widget@dev', 'merged-into'), 'merged-into edge #2 → dev')
      check(
        node(g, id(W, 3))?.reviewers?.some((r: any) => r.login === 'jo-maintainer' && r.state === 'changes_requested'),
        '#3 changes requested'
      )
      check(node(g, id(W, 4))?.ci === 'failing', `#4 ci ${node(g, id(W, 4))?.ci}`)
      check(
        (node(g, id(W, 4))?.status ?? '').startsWith('CI red: integration-tests'),
        `#4 status line "${node(g, id(W, 4))?.status}"`
      )

      const events: any[] = (await client.get(`/api/forge/events?membrane=${M}`)).events
      metrics.events = events.map((e) => `${e.nodeId.split('#')[1]}:${e.type}:${e.triage}`)
      const ev = (n: string, type: string) => events.find((e) => e.nodeId === n && e.type === type)
      check(Boolean(ev(id(W, 2), 'merged')), 'merged event on #2')
      check(Boolean(ev(id(W, 3), 'base_merged')), 'base_merged event on #3')
      check(ev(id(W, 3), 'reviewed')?.triage === 'needs-agent', 'changes requested → needs-agent')
      check(ev(id(W, 4), 'ci_failed')?.triage === 'needs-agent', 'CI red on the owned #4 → needs-agent')
      check(
        JSON.stringify(ev(id(W, 4), 'ci_failed')?.detail?.failed) === JSON.stringify(['integration-tests']),
        'ci_failed names the check'
      )
      const status = await client.get(`/api/forge/status?membrane=${M}`)
      metrics.triage = status.triage
      check(status.triage.rule.needsAgent >= 2, `triage coverage ${JSON.stringify(status.triage)}`)

      // The owner thread got pr-poll's CI notification: in its history, or
      // in the turn it started at the mock LLM.
      const text = '[PR #4] CI check failed: integration-tests'
      let notified = false
      for (let i = 0; i < 80 && !notified; i++) {
        const h = await client.threadHistory(threadId!).catch(() => null)
        const llm = await fetch(`${ctx.mockLlmUrl}/mock/log`)
          .then((r) => r.text())
          .catch(() => '')
        notified = JSON.stringify(h ?? '').includes(text) || llm.includes(text)
        if (!notified) await new Promise((r) => setTimeout(r, 250))
      }
      check(notified, 'owner thread got the CI notification')
      await waitForThreadIdle(client, threadId!, 20000).catch(() => false)

      // ── 4. Unassign removes only what Forge added ─────────────────────
      await client.post('/api/forge/assign', { nodeId: id(W, 4), threadId: null })
      state = await control('state')
      check(
        JSON.stringify(pr4(state).assignees) === JSON.stringify(['kit-bot']),
        `assignees after unassign: ${pr4(state).assignees}`
      )
      const writes = ((await control('log')) as any[]).filter((e) => e.path.includes('/issues/4/assignees'))
      check(writes.map((e) => e.method).join(',') === 'POST,DELETE', `assignee writes ${writes.map((e) => e.method)}`)
    } finally {
      if (threadId) await client.deleteThread(threadId).catch(() => undefined)
      await client.del(`/api/membranes/${M}`).catch(() => undefined)
    }
    return done()
  }
}
