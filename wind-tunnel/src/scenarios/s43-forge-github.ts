// S43: the GitHub forge adapter against the mock GitHub. Forge's server routes
// come in a later phase, so the runner drives the adapter itself
// (packages/forges) against the mock container: it seeds two repos, then
// checks the mapping of every Forge call, paging and the since cut, the
// assignee write, ETag reuse, retries over injected 502s and a secondary
// rate limit, and that a merge closes the linked issue.

import { refKey, type Change, type ForgeRef } from '../../../packages/core/src/forge.js'
import { createGithubForge } from '../../../packages/forges/src/github.js'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const W = 'acme-labs/widget'
const G = 'acme-labs/gadget'
const HEAD = (n: number) => `${n}`.repeat(40).slice(0, 40)

/** Fixed past timestamps, oldest first, so the since cut is deterministic. */
const day = (d: number, h = 9) => `2026-02-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`

const SEED = {
  viewer: 'hex-agent',
  repos: [
    {
      repo: W,
      defaultBranch: 'main',
      branches: [
        { name: 'feat/stream-teeth', sha: HEAD(1), ahead: 3, behind: 2 },
        { name: 'feat/flange', sha: HEAD(2), ahead: 1, behind: 0 },
        { name: 'fix/gear-ratio', sha: HEAD(3), ahead: 0, behind: 5 },
        { name: 'chore/drop-cog', sha: HEAD(4) },
        { name: 'old/work', sha: HEAD(5) }
      ],
      issues: [
        {
          number: 1,
          title: 'Tooth cache uses too much memory',
          author: 'sam-reviewer',
          labels: ['perf'],
          createdAt: day(1),
          updatedAt: day(20)
        },
        {
          number: 2,
          title: 'Left-handed sprockets',
          state: 'CLOSED',
          stateReason: 'NOT_PLANNED',
          createdAt: day(1),
          updatedAt: day(3),
          closedAt: day(3)
        }
      ],
      pulls: [
        {
          number: 10,
          title: 'Old work',
          head: 'old/work',
          state: 'MERGED',
          author: 'alex-dev',
          createdAt: day(2),
          updatedAt: day(4),
          closedAt: day(4),
          mergedAt: day(4)
        },
        {
          number: 11,
          title: 'Drop the legacy cog API',
          head: 'chore/drop-cog',
          state: 'CLOSED',
          author: 'alex-dev',
          createdAt: day(5),
          updatedAt: day(6),
          closedAt: day(6)
        },
        {
          number: 12,
          title: 'Fix gear ratio rounding',
          head: 'fix/gear-ratio',
          author: 'jo-maintainer',
          mergeable: 'MERGEABLE',
          reviews: [{ login: 'sam-reviewer', state: 'APPROVED', at: day(21) }],
          createdAt: day(18),
          updatedAt: day(21)
        },
        {
          number: 13,
          title: 'WIP: flange refactor',
          head: 'feat/flange',
          base: 'feat/stream-teeth',
          isDraft: true,
          author: 'kit-bot',
          headRepo: 'kit-bot/widget',
          createdAt: day(19),
          updatedAt: day(22)
        },
        {
          number: 14,
          title: 'Sprockets: stream the tooth cache',
          body: 'Streams the cache.\n\n> ### Paired with: acme-labs/gadget#1\n\nCloses #1',
          head: 'feat/stream-teeth',
          author: 'alex-dev',
          assignees: ['alex-dev'],
          reviewRequests: ['sam-reviewer', 'acme-labs/core'],
          reviews: [{ login: 'jo-maintainer', state: 'CHANGES_REQUESTED', at: day(23) }],
          labels: ['perf'],
          mergeable: 'CONFLICTING',
          createdAt: day(20),
          updatedAt: day(23)
        }
      ],
      checks: [
        {
          sha: HEAD(1),
          runs: [
            { name: 'build', status: 'completed', conclusion: 'success' },
            { name: 'lint', status: 'completed', conclusion: 'failure', output: { title: '2 errors' } }
          ],
          statuses: [{ context: 'ci/circleci: test', state: 'success' }]
        },
        { sha: HEAD(3), runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }
      ]
    },
    {
      repo: G,
      pulls: [
        {
          number: 1,
          title: 'Gadget side of the tooth stream',
          body: 'Paired with acme-labs/widget#14',
          head: 'feat/stream-teeth',
          author: 'alex-dev',
          createdAt: day(20),
          updatedAt: day(24)
        }
      ]
    }
  ]
}

export const s43ForgeGithub: Scenario = {
  id: 's43',
  name: 'Forge GitHub Adapter',
  description: 'forges GitHub adapter vs the mock GitHub: mapping, paging, since, assignees, ETags, retries, merge',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const mock = ctx.mockGithubUrl
    const metrics: Record<string, unknown> = {}
    const samples: ScenarioResult['samples'] = []
    const problems: string[] = []
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(what)
    }
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now()
      try {
        return await fn()
      } catch (err) {
        samples.push({ name, durationMs: performance.now() - t, error: (err as Error).message })
        throw err
      } finally {
        if (!samples.some((s) => s.name === name)) samples.push({ name, durationMs: performance.now() - t })
      }
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
    const log = async () =>
      (await control('log')) as Array<{ method: string; path: string; status: number; operation?: string }>
    const done = (): ScenarioResult => ({
      passed: problems.length === 0,
      summary: problems.length
        ? `${problems.length} problem(s): ${problems.slice(0, 4).join('; ')}`
        : 'adapter matches the mock on every call',
      metrics: { ...metrics, problems },
      samples
    })

    await control('reset')
    await control('seed', SEED)

    const forge = createGithubForge({ apiUrl: mock, token: 'wind-tunnel', pageSize: 2, backoffMs: 50 })
    const ref = (repo: string, kind: ForgeRef['kind'], id: string | number): ForgeRef => ({
      forge: 'github',
      host: 'github.com',
      repo,
      kind,
      id: String(id)
    })
    const byId = (cs: Change[]) => new Map(cs.map((c) => [c.ref.id, c]))

    // 1. All changes: newest first, three pages of two.
    const all = await timed('listChanges-all', () => forge.listChanges(W))
    check(all.map((c) => c.ref.id).join(',') === '14,13,12,11,10', `order ${all.map((c) => c.ref.id)}`)
    let gql = (await log()).filter((e) => e.operation === 'ForgeChanges')
    check(gql.length === 3, `paging: ${gql.length} ForgeChanges requests, want 3`)
    const c = byId(all)
    const pr14 = c.get('14')
    check(pr14?.state === 'open' && pr14.mergeable === false, 'PR 14 open + conflicting')
    check(pr14?.checks?.state === 'failing', `PR 14 checks ${pr14?.checks?.state}`)
    check(
      JSON.stringify(pr14?.reviewers) ===
        JSON.stringify([
          { login: 'sam-reviewer', state: 'requested' },
          { login: 'acme-labs/core', state: 'requested' },
          { login: 'jo-maintainer', state: 'changes_requested' }
        ]),
      `PR 14 reviewers ${JSON.stringify(pr14?.reviewers)}`
    )
    check(pr14?.closes.map(refKey).join() === `github:github.com/${W}#1`, `PR 14 closes ${pr14?.closes.map(refKey)}`)
    check(pr14?.body.includes('> ### Paired with: acme-labs/gadget#1') ?? false, 'PR 14 body intact')
    check(
      pr14?.references.some((r) => refKey(r) === `github:github.com/${G}#1` && r.kind === 'change') ?? false,
      `PR 14 cross-reference from ${G}#1: ${pr14?.references.map(refKey)}`
    )
    check(
      pr14?.head.branch === 'feat/stream-teeth' && pr14.head.sha === HEAD(1) && pr14.base.branch === 'main',
      'PR 14 head/base'
    )
    check(
      c.get('13')?.state === 'draft' && c.get('13')?.base.branch === 'feat/stream-teeth',
      'PR 13 draft stacked on 14'
    )
    check((c.get('13')?.extra as any)?.headRepo === 'kit-bot/widget', 'PR 13 fork head')
    check(c.get('13')?.checks?.state === 'none', `PR 13 checks ${c.get('13')?.checks?.state}`)
    check(c.get('12')?.checks?.state === 'passing' && c.get('12')?.mergeable === true, 'PR 12 green + mergeable')
    check(c.get('11')?.state === 'closed' && c.get('11')?.closedAt === day(6), 'PR 11 closed')
    check(c.get('10')?.state === 'merged' && c.get('10')?.closedAt === day(4), 'PR 10 merged')
    metrics.changes = all.length

    // 2. since cuts the paging: changes updated from 22 Feb are on page 1 plus the head of page 2.
    await control('reset')
    await control('seed', SEED)
    const recent = await timed('listChanges-since', () => forge.listChanges(W, { since: day(22) }))
    check(recent.map((x) => x.ref.id).join() === '14,13', `since: ${recent.map((x) => x.ref.id)}`)
    gql = (await log()).filter((e) => e.operation === 'ForgeChanges')
    check(gql.length === 2, `since paging: ${gql.length} requests, want 2 (stop at the first older item)`)
    const window = await forge.listChanges(W, { since: day(5), until: day(22) })
    check(window.map((x) => x.ref.id).join() === '12,11', `window: ${window.map((x) => x.ref.id)}`)
    const open = await forge.listChanges(W, { state: 'open' })
    check(open.map((x) => x.ref.id).join() === '14,13,12', `open: ${open.map((x) => x.ref.id)}`)

    // 3. Issues, branches, compare, comments, identity.
    const issues = await timed('listIssues', () => forge.listIssues(W))
    check(issues.map((i) => i.ref.id).join() === '1,2', `issues ${issues.map((i) => i.ref.id)}`)
    check(issues[1]?.closedReason === 'not_planned', 'issue 2 not planned')
    check(
      issues[0]?.references.some((r) => r.id === '14' && r.kind === 'change') ?? false,
      'issue 1 referenced by PR 14'
    )
    const branches = await timed('listBranches', () => forge.listBranches(W))
    check(
      branches.length === 6 && branches.some((b) => b.name === 'feat/flange' && b.sha === HEAD(2)),
      `branches ${branches.length}`
    )
    const cmp = await timed('compare', () => forge.compare(W, 'main', 'feat/stream-teeth'))
    check(cmp.ahead === 3 && cmp.behind === 2, `compare ${JSON.stringify(cmp)}`)
    await control('comment', { repo: W, number: 14, login: 'sam-reviewer', body: 'Looks close.' })
    await control('comment', { repo: W, number: 14, login: 'jo-maintainer', body: 'Nit: rename.', review: true })
    const comments = await timed('comments', () => forge.comments(ref(W, 'change', 14)))
    check(
      comments.map((x) => x.author).join() === 'sam-reviewer,jo-maintainer',
      `comments ${comments.map((x) => x.author)}`
    )
    check((await forge.identity()) === 'hex-agent', 'identity')

    // 4. checks(): failing with names; turns green; a repeat poll is all 304s.
    const red = await timed('checks-red', () => forge.checks(ref(W, 'change', 14)))
    check(red?.state === 'failing' && red.failed?.join() === 'lint', `checks red ${JSON.stringify(red)}`)
    await control('checks', {
      repo: W,
      pr: 14,
      runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'success' }
      ]
    })
    const green = await forge.checks(ref(W, 'change', 14))
    check(green?.state === 'passing', `checks green ${JSON.stringify(green)}`)
    const before = (await log()).length
    await forge.checks(ref(W, 'change', 14))
    const repeat = (await log()).slice(before)
    // PR head, check runs, statuses: three conditional GETs, all answered 304.
    check(repeat.length === 3 && repeat.every((e) => e.status === 304), `ETag reuse: ${repeat.map((e) => e.status)}`)
    const branchChecks = await forge.checks(ref(W, 'branch', 'fix/gear-ratio'))
    check(branchChecks?.state === 'passing', `branch checks ${JSON.stringify(branchChecks)}`)

    // 5. Assignees: add ours, remove someone, read back.
    await timed('setAssignees', () => forge.setAssignees(ref(W, 'change', 14), ['hex-agent'], ['alex-dev']))
    const writes = (await log()).filter((e) => e.path.endsWith('/issues/14/assignees'))
    check(
      writes.map((e) => `${e.method} ${e.status}`).join() === 'POST 201,DELETE 200',
      `assignee writes ${writes.map((e) => `${e.method} ${e.status}`)}`
    )
    const after = byId(await forge.listChanges(W, { state: 'open' })).get('14')
    check(after?.assignees.join() === 'hex-agent', `assignees after write: ${after?.assignees}`)

    // 6. Retries: two 502s on GraphQL, then a secondary rate limit on REST.
    await control('fail', { status: 502, count: 2, path: '/graphql' })
    const retried = await timed('listChanges-retry', () => forge.listChanges(W, { state: 'open' }))
    check(retried.length === 3, `after 502s: ${retried.length} changes`)
    const statuses = (await log())
      .filter((e) => e.operation === 'ForgeChanges' || (e.path === '/graphql' && e.status === 502))
      .slice(-4)
    check(
      statuses.map((e) => e.status).join() === '502,502,200,200',
      `502 retry statuses ${statuses.map((e) => e.status)}`
    )
    await control('fail', { status: 403, count: 1, retryAfter: 1, path: `/repos/${W}/compare` })
    const t0 = performance.now()
    const cmp2 = await timed('compare-rate-limited', () => forge.compare(W, 'main', 'feat/flange'))
    const waited = performance.now() - t0
    check(
      cmp2.ahead === 1 && waited >= 900,
      `secondary rate limit: ahead ${cmp2.ahead}, waited ${Math.round(waited)} ms`
    )
    metrics.rateLimitWaitMs = Math.round(waited)

    // 7. Merge PR 14: it shows merged, and issue 1 closes as completed.
    const mark = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    await control('merge', { repo: W, number: 14 })
    const since = await timed('listChanges-after-merge', () => forge.listChanges(W, { since: mark }))
    check(
      since.length === 1 && since[0].ref.id === '14' && since[0].state === 'merged',
      `after merge: ${since.map((x) => `${x.ref.id}:${x.state}`)}`
    )
    const closed = (await forge.listIssues(W, { since: mark }))[0]
    check(
      closed?.ref.id === '1' && closed.state === 'closed' && closed.closedReason === 'completed',
      `issue 1 after merge: ${closed?.state}/${closed?.closedReason}`
    )

    // 8. A missing repo is a 404.
    const missing = await forge.listChanges('acme-labs/nope').then(
      () => 'resolved',
      (e) => String(e.status)
    )
    check(missing === '404', `missing repo → ${missing}`)

    metrics.requests = (await log()).length
    return done()
  }
}
