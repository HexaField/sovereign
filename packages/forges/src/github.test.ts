import fs from 'node:fs'
import path from 'node:path'
import { refKey, type ForgeRef } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { createGithubForge, hostForApi, mapChange, mapIssue, type PageInfo } from './github.js'
import { BRANCHES_QUERY, CHANGES_QUERY, ISSUES_QUERY } from './queries.js'

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'))

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: any
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

/** A fetch that records each request and answers from `route`. */
function fakeFetch(route: (req: Sent) => Reply) {
  const sent: Sent[] = []
  const fetchFn = async (url: string, init?: RequestInit) => {
    const req: Sent = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    sent.push(req)
    const r = route(req)
    const status = r.status ?? 200
    const text = r.body === undefined ? null : JSON.stringify(r.body)
    return new Response(status === 204 || status === 304 ? null : text, { status, headers: r.headers })
  }
  return { sent, fetchFn }
}

const API = 'https://api.github.test'
const forgeWith = (route: (req: Sent) => Reply, extra: Record<string, unknown> = {}) => {
  const { sent, fetchFn } = fakeFetch(route)
  const forge = createGithubForge({ apiUrl: API, host: 'github.com', token: 't0k', fetch: fetchFn, ...extra })
  return { forge, sent }
}
const ctx = { host: 'github.com', repo: 'acme-labs/widget' }

describe('mapChange', () => {
  const [open, draft, merged] = fixture('changes-page-1.json').data.repository.pullRequests.nodes
  const [closed, old] = fixture('changes-page-2.json').data.repository.pullRequests.nodes

  it('maps an open PR with reviews, closing issues, cross-references and a failed rollup', () => {
    const c = mapChange(ctx, open)
    expect(refKey(c.ref)).toBe('github:github.com/acme-labs/widget#412')
    expect(c.ref.kind).toBe('change')
    expect(c.state).toBe('open')
    expect(c.author).toBe('alex-dev')
    expect(c.assignees).toEqual(['alex-dev', 'kit-bot'])
    expect(c.labels).toEqual(['perf', 'sprockets'])
    // Requests first (a re-requested review is current), then latest reviews; PENDING dropped.
    expect(c.reviewers).toEqual([
      { login: 'sam-reviewer', state: 'requested' },
      { login: 'acme-labs/core', state: 'requested' },
      { login: 'jo-maintainer', state: 'approved' },
      { login: 'pat-drive-by', state: 'commented' }
    ])
    expect(c.head).toEqual({ branch: 'feat/stream-teeth', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })
    expect(c.base).toEqual({ branch: 'dev' })
    expect(c.mergeable).toBe(false)
    expect(c.closes.map(refKey)).toEqual([
      'github:github.com/acme-labs/widget#377',
      'github:github.com/acme-labs/gadget#12'
    ])
    expect(c.closes.every((r) => r.kind === 'issue')).toBe(true)
    // Duplicates and empty timeline nodes dropped; kind follows the source type.
    expect(c.references).toEqual([
      { forge: 'github', host: 'github.com', repo: 'acme-labs/gadget', kind: 'change', id: '88' },
      { forge: 'github', host: 'github.com', repo: 'acme-labs/widget', kind: 'issue', id: '377' }
    ])
    expect(c.checks).toEqual({ state: 'failing' })
    expect(c.closedAt).toBeUndefined()
    expect(c.extra).toBeUndefined()
    expect(c.url).toBe('https://github.com/acme-labs/widget/pull/412')
  })

  it('keeps the body intact, Paired-with block included', () => {
    expect(mapChange(ctx, open).body).toBe(open.body)
    expect(mapChange(ctx, open).body).toContain('> ### Paired with: acme-labs/gadget#88')
  })

  it('maps a draft from a fork with no rollup and unknown mergeability', () => {
    const c = mapChange(ctx, draft)
    expect(c.state).toBe('draft')
    expect(c.mergeable).toBeUndefined()
    expect('mergeable' in c).toBe(false)
    expect(c.checks).toEqual({ state: 'none' })
    expect(c.extra).toEqual({ headRepo: 'kit-bot/widget' })
    expect(c.base.branch).toBe('feat/stream-teeth')
  })

  it('maps a merged PR: mergedAt as closedAt, ghost author, mergeable true', () => {
    const c = mapChange(ctx, merged)
    expect(c.state).toBe('merged')
    expect(c.closedAt).toBe('2026-02-28T11:58:00Z')
    expect(c.author).toBe('ghost')
    expect(c.mergeable).toBe(true)
    expect(c.checks).toEqual({ state: 'passing' })
    expect(c.extra).toEqual({ mergedAt: '2026-02-28T11:58:00Z' })
    expect(c.reviewers).toEqual([{ login: 'jo-maintainer', state: 'approved' }])
  })

  it('maps a closed PR, a dismissed review and a pending rollup; no commits → no checks', () => {
    const c = mapChange(ctx, closed)
    expect(c.state).toBe('closed')
    expect(c.closedAt).toBe('2026-02-25T15:00:00Z')
    expect(c.reviewers).toEqual([{ login: 'sam-reviewer', state: 'dismissed' }])
    expect(c.checks).toEqual({ state: 'pending' })
    expect(mapChange(ctx, old).checks).toBeUndefined()
  })
})

describe('mapIssue', () => {
  const [open, done, notPlanned] = fixture('issues-page.json').data.repository.issues.nodes

  it('maps an open issue (a reopened reason is not a close reason)', () => {
    const i = mapIssue(ctx, open)
    expect(refKey(i.ref)).toBe('github:github.com/acme-labs/widget#377')
    expect(i.ref.kind).toBe('issue')
    expect(i.state).toBe('open')
    expect(i.closedReason).toBeUndefined()
    expect(i.closedAt).toBeUndefined()
    expect(i.assignees).toEqual(['alex-dev'])
    expect(i.labels).toEqual(['perf'])
    expect(i.references).toEqual([
      { forge: 'github', host: 'github.com', repo: 'acme-labs/widget', kind: 'change', id: '412' }
    ])
  })

  it('maps close reasons', () => {
    expect(mapIssue(ctx, done)).toMatchObject({
      state: 'closed',
      closedReason: 'completed',
      closedAt: '2026-02-28T12:01:00Z'
    })
    expect(mapIssue(ctx, notPlanned)).toMatchObject({ state: 'closed', closedReason: 'not_planned', author: 'ghost' })
    expect(mapIssue(ctx, { ...notPlanned, stateReason: 'DUPLICATE' }).closedReason).toBe('not_planned')
  })
})

describe('listChanges', () => {
  const pages = [fixture('changes-page-1.json'), fixture('changes-page-2.json')]
  const route = (req: Sent): Reply => {
    expect(req.url).toBe(`${API}/graphql`)
    return { body: pages[req.body.variables.after ? 1 : 0] }
  }

  it('sends the changes query newest-first with page size and cursor, all states by default', async () => {
    const { forge, sent } = forgeWith(route, { pageSize: 3, maxPages: 2 })
    const out = await forge.listChanges('acme-labs/widget')
    expect(out.map((c) => c.ref.id)).toEqual(['412', '415', '401', '399', '350'])
    expect(sent).toHaveLength(2)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].headers.Authorization).toBe('Bearer t0k')
    expect(sent[0].body.query).toBe(CHANGES_QUERY)
    expect(sent[0].body.query).toContain('orderBy: { field: UPDATED_AT, direction: DESC }')
    expect(sent[0].body.variables).toEqual({ owner: 'acme-labs', name: 'widget', first: 3, after: null, states: null })
    expect(sent[1].body.variables.after).toBe('Y3Vyc29yOjM=')
  })

  it("state 'open' asks for OPEN only", async () => {
    const { forge, sent } = forgeWith(route, { maxPages: 1 })
    await forge.listChanges('acme-labs/widget', { state: 'open' })
    expect(sent[0].body.variables.states).toEqual(['OPEN'])
    expect(sent[0].body.variables.first).toBe(50)
  })

  it('stops paging at the first item older than since', async () => {
    const { forge, sent } = forgeWith(route)
    const out = await forge.listChanges('acme-labs/widget', { since: '2026-02-27T00:00:00Z' })
    expect(out.map((c) => c.ref.id)).toEqual(['412', '415', '401'])
    // All of page 1 is newer than since, so page 2 is fetched; its first item ends it.
    const out2 = await forge.listChanges('acme-labs/widget', { since: '2026-03-01T12:00:00Z' })
    expect(out2.map((c) => c.ref.id)).toEqual(['412', '415'])
    // Two pages for the first call, one for the second.
    expect(sent).toHaveLength(3)
  })

  it('skips items updated at or after until, and keeps paging below it', async () => {
    const { forge, sent } = forgeWith(route)
    const out = await forge.listChanges('acme-labs/widget', {
      since: '2026-02-01T00:00:00Z',
      until: '2026-03-01T18:00:00Z'
    })
    expect(out.map((c) => c.ref.id)).toEqual(['401', '399'])
    expect(sent).toHaveLength(2)
  })

  it('reports page timing and GraphQL cost', async () => {
    const seen: PageInfo[] = []
    const { forge } = forgeWith(route, { onPage: (p: PageInfo) => seen.push(p) })
    await forge.listChanges('acme-labs/widget', { since: '2026-02-27T00:00:00Z' })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ op: 'changes', repo: 'acme-labs/widget', items: 3, cost: 4 })
  })

  it('stops when there is no next page and honours maxPages', async () => {
    const one = fixture('changes-page-1.json')
    one.data.repository.pullRequests.pageInfo.hasNextPage = false
    const a = forgeWith(() => ({ body: one }))
    await a.forge.listChanges('acme-labs/widget')
    expect(a.sent).toHaveLength(1)
    const b = forgeWith(route, { maxPages: 1 })
    expect(await b.forge.listChanges('acme-labs/widget')).toHaveLength(3)
    expect(b.sent).toHaveLength(1)
  })

  it('fails on a missing repo and on a malformed repo name', async () => {
    const { forge } = forgeWith(() => ({
      body: {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }]
      }
    }))
    await expect(forge.listChanges('acme-labs/nope')).rejects.toMatchObject({ status: 404 })
    await expect(forge.listChanges('not-a-repo')).rejects.toThrow(/owner\/name/)
  })
})

describe('listIssues', () => {
  it('sends the issues query with since as a server-side filter', async () => {
    const { forge, sent } = forgeWith(() => ({ body: fixture('issues-page.json') }))
    const out = await forge.listIssues('acme-labs/widget', { since: '2026-02-25T00:00:00Z', state: 'all' })
    expect(sent[0].body.query).toBe(ISSUES_QUERY)
    expect(sent[0].body.variables).toMatchObject({ since: '2026-02-25T00:00:00Z', states: null })
    // The fixture also holds an older issue; the client-side cut drops it.
    expect(out.map((i) => i.ref.id)).toEqual(['377', '360'])
  })

  it("state 'open' asks for OPEN", async () => {
    const { forge, sent } = forgeWith(() => ({ body: fixture('issues-page.json') }))
    await forge.listIssues('acme-labs/widget', { state: 'open' })
    expect(sent[0].body.variables).toMatchObject({ states: ['OPEN'], since: null })
  })
})

describe('listBranches', () => {
  it('pages refs/heads 100 at a time', async () => {
    const page = (names: string[], next: string | null) => ({
      data: {
        rateLimit: { cost: 1 },
        repository: {
          refs: {
            pageInfo: { hasNextPage: !!next, endCursor: next },
            nodes: names.map((name, i) => ({ name, target: { oid: `${i}`.padStart(40, 'f') } }))
          }
        }
      }
    })
    const { forge, sent } = forgeWith((req) => ({
      body: req.body.variables.after ? page(['feat/flange'], null) : page(['dev', 'feat/stream-teeth'], 'cur1')
    }))
    const out = await forge.listBranches('acme-labs/widget')
    expect(out.map((b) => b.name)).toEqual(['dev', 'feat/stream-teeth', 'feat/flange'])
    expect(out[0].sha).toHaveLength(40)
    expect(sent[0].body.query).toBe(BRANCHES_QUERY)
    expect(sent[0].body.variables).toEqual({ owner: 'acme-labs', name: 'widget', first: 100, after: null })
    expect(sent[1].body.variables.after).toBe('cur1')
  })
})

describe('compare', () => {
  it('reads ahead/behind from the REST compare endpoint, branch names encoded', async () => {
    const { forge, sent } = forgeWith(() => ({ body: { ahead_by: 3, behind_by: 7, commits: [] } }))
    expect(await forge.compare('acme-labs/widget', 'dev', 'feat/stream-teeth')).toEqual({ ahead: 3, behind: 7 })
    expect(sent[0].method).toBe('GET')
    expect(sent[0].url).toBe(`${API}/repos/acme-labs/widget/compare/dev...feat%2Fstream-teeth?per_page=1`)
  })
})

describe('checks', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const change: ForgeRef = { forge: 'github', host: 'github.com', repo: 'acme-labs/widget', kind: 'change', id: '412' }

  const route =
    (runs: any[], statuses: any[]) =>
    (req: Sent): Reply => {
      const p = req.url.slice(API.length)
      if (p === '/repos/acme-labs/widget/pulls/412') return { body: { number: 412, head: { sha: SHA } } }
      if (p === '/repos/acme-labs/widget/commits/feat%2Fflange') return { body: { sha: SHA } }
      if (p === `/repos/acme-labs/widget/commits/${SHA}/check-runs?per_page=100`)
        return { body: { total_count: runs.length, check_runs: runs } }
      if (p === `/repos/acme-labs/widget/commits/${SHA}/status?per_page=100`)
        return { body: { state: 'pending', total_count: statuses.length, statuses } }
      return { status: 404, body: { message: 'Not Found' } }
    }

  it('summarises check runs and statuses of the PR head, naming the failures', async () => {
    const { forge, sent } = forgeWith(
      route(
        [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'completed', conclusion: 'timed_out' }
        ],
        [{ context: 'ci/circleci: test', state: 'failure' }]
      )
    )
    expect(await forge.checks(change)).toEqual({ state: 'failing', failed: ['ci/circleci: test', 'lint'] })
    expect(sent.map((s) => s.url.slice(API.length))[0]).toBe('/repos/acme-labs/widget/pulls/412')
  })

  it('pending while any check runs; passing with only success and neutral; none without checks', async () => {
    const pending = forgeWith(route([{ name: 'build', status: 'in_progress' }], [])).forge
    expect(await pending.checks(change)).toEqual({ state: 'pending' })
    const green = forgeWith(
      route(
        [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'docs', status: 'completed', conclusion: 'skipped' }
        ],
        [{ context: 'ci/circleci: test', state: 'success' }]
      )
    ).forge
    expect(await green.checks(change)).toEqual({ state: 'passing' })
    const none = forgeWith(route([], [])).forge
    expect(await none.checks({ ...change, kind: 'branch', id: 'feat/flange' })).toEqual({ state: 'none' })
  })

  it('has no checks for an issue or another forge', async () => {
    const { forge, sent } = forgeWith(route([], []))
    expect(await forge.checks({ ...change, kind: 'issue' })).toBeUndefined()
    expect(await forge.checks({ ...change, forge: 'gitlab' })).toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('fails on an unknown PR', async () => {
    const { forge } = forgeWith(route([], []))
    await expect(forge.checks({ ...change, id: '999' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('comments', () => {
  const issueComments = [
    {
      user: { login: 'sam-reviewer' },
      body: 'Looks close.',
      created_at: '2026-03-01T10:00:00Z',
      html_url: 'https://github.com/acme-labs/widget/pull/412#issuecomment-1'
    }
  ]
  const reviewComments = [
    {
      user: { login: 'jo-maintainer' },
      body: 'Nit: rename.',
      created_at: '2026-02-28T10:00:00Z',
      html_url: 'https://github.com/acme-labs/widget/pull/412#discussion_r2'
    },
    { user: null, body: 'Old note', created_at: '2026-03-02T10:00:00Z' }
  ]

  it('merges issue and review comments of a change, oldest first', async () => {
    const { forge, sent } = forgeWith((req) => {
      if (req.url.includes('/issues/412/comments')) return { body: issueComments }
      if (req.url.includes('/pulls/412/comments')) return { body: reviewComments }
      return { status: 404 }
    })
    const out = await forge.comments({
      forge: 'github',
      host: 'github.com',
      repo: 'acme-labs/widget',
      kind: 'change',
      id: '412'
    })
    expect(out).toEqual([
      {
        author: 'jo-maintainer',
        body: 'Nit: rename.',
        createdAt: '2026-02-28T10:00:00Z',
        url: 'https://github.com/acme-labs/widget/pull/412#discussion_r2'
      },
      {
        author: 'sam-reviewer',
        body: 'Looks close.',
        createdAt: '2026-03-01T10:00:00Z',
        url: 'https://github.com/acme-labs/widget/pull/412#issuecomment-1'
      },
      { author: 'ghost', body: 'Old note', createdAt: '2026-03-02T10:00:00Z' }
    ])
    expect(sent.map((s) => s.url)).toEqual([
      `${API}/repos/acme-labs/widget/issues/412/comments?per_page=100`,
      `${API}/repos/acme-labs/widget/pulls/412/comments?per_page=100`
    ])
  })

  it('reads only issue comments for an issue and follows Link pages', async () => {
    const { forge, sent } = forgeWith((req) =>
      req.url.endsWith('page=2')
        ? { body: [{ user: { login: 'b' }, body: '2', created_at: '2026-03-02T00:00:00Z' }] }
        : {
            body: [{ user: { login: 'a' }, body: '1', created_at: '2026-03-01T00:00:00Z' }],
            headers: { link: `<${API}/repos/acme-labs/widget/issues/377/comments?per_page=100&page=2>; rel="next"` }
          }
    )
    const out = await forge.comments({
      forge: 'github',
      host: 'github.com',
      repo: 'acme-labs/widget',
      kind: 'issue',
      id: '377'
    })
    expect(out.map((c) => c.body)).toEqual(['1', '2'])
    expect(sent).toHaveLength(2)
  })
})

describe('setAssignees', () => {
  const ref: ForgeRef = { forge: 'github', host: 'github.com', repo: 'acme-labs/widget', kind: 'change', id: '412' }

  it('POSTs additions and DELETEs removals on the issue assignees endpoint', async () => {
    const { forge, sent } = forgeWith((req) => ({ status: req.method === 'POST' ? 201 : 200, body: { number: 412 } }))
    await forge.setAssignees(ref, ['hex-agent', 'hex-agent'], ['kit-bot'])
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', `${API}/repos/acme-labs/widget/issues/412/assignees`, { assignees: ['hex-agent'] }],
      ['DELETE', `${API}/repos/acme-labs/widget/issues/412/assignees`, { assignees: ['kit-bot'] }]
    ])
  })

  it('sends nothing when there is nothing to change, and drops a login both added and removed from the removal', async () => {
    const { forge, sent } = forgeWith(() => ({ status: 201, body: {} }))
    await forge.setAssignees(ref, [], [])
    expect(sent).toHaveLength(0)
    await forge.setAssignees({ ...ref, kind: 'issue', id: '377' }, ['a'], ['a'])
    expect(sent.map((s) => s.method)).toEqual(['POST'])
  })

  it('rejects branches and surfaces GitHub errors', async () => {
    const { forge } = forgeWith(() => ({ status: 422, body: { message: 'Validation Failed' } }))
    await expect(forge.setAssignees({ ...ref, kind: 'branch', id: 'dev' }, ['a'], [])).rejects.toThrow(
      /not a GitHub change or issue/
    )
    await expect(forge.setAssignees(ref, ['a'], [])).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/Validation Failed/)
    })
  })
})

describe('identity', () => {
  it('reads /user once and caches the login', async () => {
    const { forge, sent } = forgeWith(() => ({ body: { login: 'hex-agent', id: 1 } }))
    expect(await forge.identity()).toBe('hex-agent')
    expect(await forge.identity()).toBe('hex-agent')
    expect(sent.map((s) => s.url)).toEqual([`${API}/user`])
  })

  it('retries after a failure instead of caching it', async () => {
    let n = 0
    const { forge } = forgeWith(() =>
      n++ === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: { login: 'hex-agent' } }
    )
    await expect(forge.identity()).rejects.toMatchObject({ status: 401 })
    expect(await forge.identity()).toBe('hex-agent')
  })
})

describe('hosts', () => {
  it('derives the ref host from the API base', () => {
    expect(hostForApi('https://api.github.com')).toBe('github.com')
    expect(hostForApi('https://git.example.org/api/v3')).toBe('git.example.org')
    expect(hostForApi('http://localhost:8910')).toBe('github.com')
    expect(createGithubForge({ apiUrl: 'https://git.example.org/api/v3', token: 'x' }).host).toBe('git.example.org')
    expect(createGithubForge({ apiUrl: 'https://git.example.org/api/v3', token: 'x' }).transport.graphqlUrl).toBe(
      'https://git.example.org/api/graphql'
    )
  })
})
