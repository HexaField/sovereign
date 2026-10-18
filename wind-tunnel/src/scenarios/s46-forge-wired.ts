// S46: the wired Forge — the work graph on the real task graph (TaskPort →
// TaskService + the Forge meta store, persisted in the `sovereign-forge`
// perspective) against the mock GitHub.
//
//   views      PUT/GET /api/forge/views: ordered, replaced, served with the graph
//   streams    POST /api/forge/streams + members → a stream task in /api/tasks
//   assign     a node to a new thread → task in_progress in /api/tasks, assignee on GitHub
//   merge      a merge on GitHub → its task completed after one sync
//   plans      a plan file in the membrane's plans/ → a stream task holding what it names;
//              a plan naming no item stays a plan node and makes no epic
//   archive    an archived epic leaves the graph; ?archived=1 and GET /api/forge/streams list it
//   task_update  PATCH /api/tasks/:id { threadId } (what the MCP tool calls) → assignee on GitHub
//   pr-poll    a PR task on a repo outside forge.repos, owned by a thread with no
//              membrane → read on its own; CI red on the mock → the owner is told
//
// The plan file is written into the container (docker compose exec), under the
// membrane's contentPath; forge.planDirs keeps its default "plans".

import { execSync } from 'node:child_process'
import path from 'node:path'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const M = 'forge-wt'
const W = 'acme-labs/widget'
const T = 'other-labs/tool'
const CONTENT = '/data/forge-wt'
const id = (repo: string, n: number) => `github:github.com/${repo}#${n}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const uuidOf = (taskId: string) => encodeURIComponent(taskId.replace('task://', ''))

const SEED = {
  viewer: 'hex-agent',
  repos: [
    {
      repo: W,
      defaultBranch: 'dev',
      branches: [
        { name: 'feat/s46-owner', sha: 'a'.repeat(40), ahead: 1, behind: 0 },
        { name: 'feat/s46-merge', sha: 'b'.repeat(40), ahead: 1, behind: 0 }
      ],
      issues: [{ number: 32, title: 'Rollout checklist', author: 'sam-reporter' }],
      pulls: [
        { number: 30, title: 'Rollout: the switch', head: 'feat/s46-owner', base: 'dev', author: 'alex-dev' },
        { number: 31, title: 'Rollout: cleanup', head: 'feat/s46-merge', base: 'dev', author: 'alex-dev' }
      ]
    },
    {
      repo: T,
      defaultBranch: 'main',
      branches: [{ name: 'fix/tool', sha: 'c'.repeat(40) }],
      pulls: [{ number: 7, title: 'Tool fix', head: 'fix/tool', base: 'main', author: 'kit-bot' }],
      checks: [{ sha: 'c'.repeat(40), runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] }]
    }
  ]
}

const PLAN = '# S46 rollout\\n\\nStatus: in progress\\n\\nRepo: acme-labs/widget\\n\\nShips #30, then closes #32.\\n'
/** Names no PR or issue: a plan node, never an epic. */
const IDEA = '# S46 idea\\n\\nNothing tracked yet.\\n'

export const s46ForgeWired: Scenario = {
  id: 's46',
  name: 'Forge Wired',
  description:
    'work graph on the real task graph: views, streams, assign → task + assignee, merge → completed, plan → stream, task_update → assignee, pr-poll parity',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, composeFile } = ctx
    const mock = ctx.mockGithubUrl
    const problems: string[] = []
    const metrics: Record<string, unknown> = {}
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(what)
    }
    const ad4mLane = !!process.env.AD4M_PROVISION_FILE
    const compose = ad4mLane
      ? `docker compose -f "${composeFile}" -f "${path.join(path.dirname(composeFile), 'docker-compose.ad4m.yml')}"`
      : `docker compose -f "${composeFile}"`
    const sh = (script: string) =>
      execSync(`${compose} exec -T sovereign sh -c '${script}'`, { encoding: 'utf-8', timeout: 30000 })
    const control = async (action: string, body?: unknown) => {
      const res = await fetch(`${mock}/mock/github/${action}`, {
        method: body === undefined && (action === 'log' || action === 'state') ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      if (!res.ok) throw new Error(`mock ${action} → ${res.status} ${await res.text()}`)
      return res.json() as Promise<any>
    }
    const put = (p: string, body: unknown) =>
      fetch(`${ctx.sovereignUrl}${p}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    const patch = (p: string, body: unknown) =>
      fetch(`${ctx.sovereignUrl}${p}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then((r) => r.json())
    const graph = (q = '') => client.timed('forge-graph', () => client.get(`/api/forge?membrane=${M}${q}`))
    const sync = () => client.timed('forge-sync', () => client.post(`/api/forge/sync?membrane=${M}`))
    const node = (g: any, nid: string) => g.nodes.find((n: any) => n.id === nid)
    const task = (taskId: string) => client.get(`/api/tasks/${uuidOf(taskId)}`)
    const assigneesOf = async (repo: string, n: number) => {
      const r = (await control('state')).repos.find((x: any) => x.repo === repo)
      return ([...(r?.pulls ?? []), ...(r?.issues ?? [])].find((x: any) => x.number === n)?.assignees ?? []) as string[]
    }
    /** Poll until `fn` holds (the server works in the background). */
    const eventually = async (fn: () => Promise<boolean>, ms = 15000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await fn().catch(() => false)) return true
        await sleep(250)
      }
      return false
    }
    const notified = async (threadId: string, text: string) =>
      eventually(async () => {
        const h = await client.threadHistory(threadId).catch(() => null)
        const llm = await fetch(`${ctx.mockLlmUrl}/mock/log`)
          .then((r) => r.text())
          .catch(() => '')
        return JSON.stringify(h ?? '').includes(text) || llm.includes(text)
      }, 20000)

    const threads: string[] = []
    const done = (): ScenarioResult => ({
      passed: problems.length === 0,
      summary: problems.length
        ? `${problems.length} problem(s): ${problems.slice(0, 4).join('; ')}`
        : 'views, streams, assign, merge, plan streams, task_update and tracked PR notifications all go through the task graph',
      metrics: { ...metrics, problems },
      samples: client.samples.filter((s) => s.name.startsWith('forge'))
    })

    await control('reset')
    await control('seed', SEED)
    if ((await client.membranes()).some((m: any) => m.id === M)) await client.del(`/api/membranes/${M}`)
    await client.post('/api/membranes', {
      id: M,
      name: 'Forge wired wind tunnel',
      workspaceIds: [],
      contentPath: CONTENT
    })
    sh(`mkdir -p ${CONTENT}/plans && printf "${PLAN}" > ${CONTENT}/plans/s46-rollout.md`)
    sh(`printf "${IDEA}" > ${CONTENT}/plans/s46-idea.md`)

    try {
      // ── Views: ordered, replaced, used by the graph ───────────────────
      const v1 = { id: 'all', membrane: M, title: 'All', repos: [], filters: {} }
      const v2 = { id: 'mine', membrane: M, title: 'Mine', repos: [W], filters: { authors: ['alex-dev'] }, height: 280 }
      check((await put(`/api/forge/views?membrane=${M}`, { views: [v1, v2] })).status === 200, 'PUT views')
      const reordered = await put(`/api/forge/views?membrane=${M}`, { views: [v2, v1] })
      check(
        reordered.body?.views?.map((v: any) => v.id).join() === 'mine,all',
        `reordered views ${JSON.stringify(reordered.body)}`
      )
      const views = (await client.get(`/api/forge/views?membrane=${M}`)).views
      check(views.map((v: any) => v.id).join() === 'mine,all' && views[0].height === 280, 'GET views in order')
      check((await put(`/api/forge/views?membrane=${M}`, { views: 'x' })).status === 400, 'bad views → 400')

      // ── First sync: graph, plan stream ────────────────────────────────
      metrics.firstSync = await sync()
      let g = await graph()
      for (const n of [id(W, 30), id(W, 31), id(W, 32)]) check(Boolean(node(g, n)), `missing node ${n}`)
      check(g.identity === 'hex-agent', `graph identity ${g.identity}`)
      const planNode = g.nodes.find((n: any) => n.kind === 'plan' && n.title === 'S46 rollout')
      check(Boolean(planNode?.taskId), `plan node with a task: ${JSON.stringify(planNode)}`)
      if (planNode?.taskId) {
        const planTask = await task(planNode.taskId)
        check(
          planTask.isStream === true && planTask.state === 'in_progress',
          `plan stream task ${planTask.isStream}/${planTask.state}`
        )
        const members = await Promise.all(planTask.childTasks.map((c: any) => task(c.id)))
        const keys = members.map((t: any) => `${t.provider?.refs?.[0]?.repo}#${t.provider?.refs?.[0]?.id}`).sort()
        check(keys.join() === [`${W}#30`, `${W}#32`].join(), `plan stream members ${keys}`)
        check(
          g.workstreams.some((s: any) => s.id === planNode.taskId),
          'plan stream in the graph workstreams'
        )
        check(node(g, id(W, 30))?.workstreams?.includes(planNode.taskId), '#30 in the plan lane')
      }
      const ideaNode = g.nodes.find((n: any) => n.kind === 'plan' && n.title === 'S46 idea')
      check(Boolean(ideaNode), 'a plan without items is still a plan node')
      check(
        !g.workstreams.some((s: any) => s.name === 'S46 idea'),
        `a plan without items makes no epic: ${g.workstreams.map((s: any) => s.name)}`
      )
      check(
        (await graph('&view=mine')).nodes.every((n: any) => !n.repo || n.repo === W),
        'the saved view filters the graph'
      )

      // ── A stream by hand, a member ────────────────────────────────────
      const stream = await client.post('/api/forge/streams', { membrane: M, name: 'S46 by hand' })
      const member = await client.post(`/api/forge/streams/${encodeURIComponent(stream.id)}/members`, {
        nodeId: id(W, 31)
      })
      const inStream = (await client.get(`/api/tasks?workstream=${encodeURIComponent(stream.id)}`)).tasks
      check(
        inStream.some((t: any) => t.id === member.taskId),
        'the stream member is a task under the stream in /api/tasks'
      )
      const streams = (await client.get(`/api/tasks/streams?membrane=${M}`)).streams
      check(
        streams.some((s: any) => s.id === stream.id && s.memberCount === 1),
        'the stream is a work stream in /api/tasks'
      )

      // ── Archive hides the epic; ?archived=1 and the streams list bring it back ──
      const arch = await client.post(`/api/forge/streams/${encodeURIComponent(stream.id)}/archive`, {
        membrane: M,
        archived: true
      })
      check(arch?.archived === true, `archive answer ${JSON.stringify(arch)}`)
      const hidden = await graph()
      check(!hidden.workstreams.some((s: any) => s.id === stream.id), 'an archived epic leaves the graph')
      check(!node(hidden, id(W, 31))?.workstreams?.includes(stream.id), '#31 no longer shows the archived epic')
      check(
        (await graph('&archived=1')).workstreams.some((s: any) => s.id === stream.id && s.archived),
        '?archived=1 lists the archived epic'
      )
      const listed = (await client.get(`/api/forge/streams?membrane=${M}&archived=1`)).streams
      check(
        listed.some((s: any) => s.id === stream.id && s.archived),
        'GET /api/forge/streams?archived=1 lists it'
      )
      await client.post(`/api/forge/streams/${encodeURIComponent(stream.id)}/archive`, { membrane: M, archived: false })
      check(
        (await graph()).workstreams.some((s: any) => s.id === stream.id),
        'unarchived: back in the graph'
      )

      // ── Assign #30 to a new thread ────────────────────────────────────
      const assigned = await client.timed('forge-assign', () =>
        client.post('/api/forge/assign', { nodeId: id(W, 30), newThread: { label: 'S46 owner' } })
      )
      if (assigned.threadId) threads.push(assigned.threadId)
      const t30 = await task(assigned.taskId)
      check(
        t30.state === 'in_progress' && t30.threadId === assigned.threadId,
        `assigned task ${t30.state}/${t30.threadId}`
      )
      check((await assigneesOf(W, 30)).includes('hex-agent'), `GitHub assignees of #30: ${await assigneesOf(W, 30)}`)
      if (assigned.threadId) await waitForThreadIdle(client, assigned.threadId, 30000).catch(() => false)

      // ── Merge #31 on GitHub → its task completed after one sync ───────
      await control('merge', { repo: W, number: 31 })
      await sync()
      const t31 = await task(member.taskId)
      check(t31.state === 'completed', `merged #31 task state ${t31.state}`)
      g = await graph()
      check(node(g, id(W, 31))?.state === 'merged', 'merged #31 in the graph')

      // ── task_update { threadId } (PATCH, as the MCP tool) → assignee ──
      const owner = await client.createThread({ label: 'S46 issue owner', membraneId: M })
      threads.push(owner.id)
      const t32 = (await client.get(`/api/tasks?membrane=${M}&providerKind=issue`)).tasks.find(
        (t: any) => t.provider?.refs?.[0]?.id === '32'
      )
      check(Boolean(t32), 'the plan made a task for issue #32')
      if (t32) {
        await patch(`/api/tasks/${uuidOf(t32.id)}`, { threadId: owner.id })
        check(
          await eventually(async () => (await assigneesOf(W, 32)).includes('hex-agent')),
          'task_update threadId → GitHub assignee on #32'
        )
        check(
          await eventually(async () => (await task(t32.id)).state === 'in_progress'),
          'task_update threadId → in progress'
        )
        await patch(`/api/tasks/${uuidOf(t32.id)}`, { threadId: null })
        check(
          await eventually(async () => !(await assigneesOf(W, 32)).includes('hex-agent')),
          'unassign → assignee removed'
        )
      }

      // ── pr-poll parity: a PR task outside forge.repos, owner with no membrane
      const polled = await client.createThread({ label: 'S46 tracked owner' })
      threads.push(polled.id)
      const prTask = await client.post('/api/tasks', {
        name: 'PR #7: Tool fix',
        threadId: polled.id,
        provider: {
          kind: 'change',
          refs: [{ forge: 'github', host: 'github.com', repo: T, kind: 'change', id: '7' }],
          url: `https://github.com/${T}/pull/7`,
          status: 'open',
          checksStatus: 'unknown',
          reviewDecision: 'unknown',
          unresolvedComments: 0,
          lastPolledAt: new Date(0).toISOString()
        }
      })
      check(
        await eventually(async () => (await task(prTask.id)).provider?.checksStatus === 'passing'),
        'the tracked PR is read on its own (CI passing)'
      )
      check(
        await eventually(async () => (await assigneesOf(T, 7)).includes('hex-agent')),
        'a task created owned → GitHub assignee'
      )
      await control('checks', { repo: T, pr: 7, runs: [{ name: 'unit', status: 'completed', conclusion: 'failure' }] })
      await client.post(`/api/tasks/${uuidOf(prTask.id)}/poll`, {})
      const after = await task(prTask.id)
      check(
        after.provider?.checksStatus === 'failing' && after.transientState === 'CI red: unit',
        `tracked PR after CI red: ${after.provider?.checksStatus} / ${after.transientState}`
      )
      check(await notified(polled.id, '[PR #7] CI check failed: unit'), 'the tracked PR owner got the CI notification')
      const reads = ((await control('log')) as any[]).filter(
        (e) => e.operation === 'ForgeChange' && e.variables?.name === 'tool'
      )
      metrics.trackedReads = reads.length
      check(reads.length >= 2, `ForgeChange reads of the tracked PR: ${reads.length}`)
      await waitForThreadIdle(client, polled.id, 20000).catch(() => false)
    } finally {
      for (const t of threads) await client.deleteThread(t).catch(() => undefined)
      await put(`/api/forge/views?membrane=${M}`, { views: [] }).catch(() => undefined)
      await client.del(`/api/membranes/${M}`).catch(() => undefined)
      try {
        sh(`rm -rf ${CONTENT}`)
      } catch {
        /* the container may be gone */
      }
    }
    return done()
  }
}
