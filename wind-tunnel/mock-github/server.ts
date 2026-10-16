#!/usr/bin/env -S npx tsx
// Mock GitHub API — answers the GraphQL queries and REST endpoints the forge
// adapter (packages/forges) sends, from an in-memory model (model.ts) that
// scenarios seed and mutate through /mock/github/*.
//
// GraphQL: POST /graphql (or /api/graphql), dispatched by operation name:
//   ForgeChanges, ForgeIssues, ForgeBranches.
// REST: GET /user; GET /repos/:o/:r/pulls/:n; GET …/commits/:ref;
//   GET …/commits/:sha/check-runs; GET …/commits/:sha/status;
//   GET …/compare/:base...:head; GET …/issues/:n/comments; GET …/pulls/:n/comments;
//   POST|DELETE …/issues/:n/assignees.
// REST GETs carry an ETag and answer 304 to a matching If-None-Match.
// Every API request needs an `Authorization` header (any token).
//
// Environment:
//   PORT          — listen port (default 8910)
//   MOCK_VERBOSE  — "1" logs every request

import http from 'node:http'
import { GithubModel, MockError, sha, type MockIssue, type MockPr, type MockRepo } from './model.js'

const PORT = Number(process.env.PORT ?? 8910)
const VERBOSE = process.env.MOCK_VERBOSE === '1'

const model = new GithubModel()

interface LogEntry {
  at: string
  method: string
  path: string
  status: number
  operation?: string
  variables?: Record<string, unknown>
  body?: unknown
}
let requestLog: LogEntry[] = []

interface Failure {
  status: number
  count: number
  /** Only requests whose path starts with this (e.g. "/graphql", "/repos/acme/widget"). */
  path?: string
  method?: string
  retryAfter?: number
  message?: string
}
let failures: Failure[] = []

// ── HTTP helpers ─────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve(undefined)
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new MockError(400, 'Problems parsing JSON'))
      }
    })
    req.on('error', reject)
  })
}

interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, body, headers })

// ── GraphQL ──────────────────────────────────────────────────────────

const cursor = (i: number) => Buffer.from(`cursor:${i}`).toString('base64')
const fromCursor = (c: unknown): number => {
  if (typeof c !== 'string' || !c) return -1
  const m = /^cursor:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8'))
  if (!m) throw new MockError(400, `bad cursor ${c}`)
  return Number(m[1])
}

function page<T>(items: T[], first: unknown, after: unknown) {
  const n = Number(first)
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new MockError(400, '`first` must be 1–100')
  const start = fromCursor(after) + 1
  const slice = items.slice(start, start + n)
  return {
    slice,
    pageInfo: {
      hasNextPage: start + n < items.length,
      endCursor: slice.length ? cursor(start + slice.length - 1) : null
    }
  }
}

const byUpdatedDesc = (a: { updatedAt: string; number: number }, b: { updatedAt: string; number: number }) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number

const logins = (xs: string[]) => ({ nodes: xs.map((login) => ({ login })) })
const actor = (login: string | null) => (login ? { login } : null)
const crossRefNodes = (refs: MockPr['crossRefs']) => ({
  nodes: refs.slice(0, 20).map((c) => ({
    source: { __typename: c.type, number: c.number, repository: { nameWithOwner: c.repo } }
  }))
})

function prNode(r: MockRepo, pr: MockPr) {
  const rollup = model.rollup(r.repo, pr.headSha)
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: `https://github.com/${r.repo}/pull/${pr.number}`,
    state: pr.state,
    isDraft: pr.isDraft,
    merged: pr.state === 'MERGED',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    author: actor(pr.author),
    assignees: logins(pr.assignees),
    reviewRequests: {
      nodes: pr.reviewRequests.map((l) => ({
        requestedReviewer: l.includes('/') ? { __typename: 'Team', combinedSlug: l } : { __typename: 'User', login: l }
      }))
    },
    latestReviews: { nodes: model.latestReviews(pr).map((x) => ({ author: { login: x.login }, state: x.state })) },
    labels: { nodes: pr.labels.map((name) => ({ name })) },
    headRefName: pr.head,
    headRefOid: pr.headSha,
    baseRefName: pr.base,
    headRepository: { nameWithOwner: pr.headRepo ?? r.repo },
    mergeable: pr.state === 'OPEN' ? pr.mergeable : 'UNKNOWN',
    closingIssuesReferences: {
      nodes: model.closingIssues(r.repo, pr).map((i) => ({ number: i.number, repository: { nameWithOwner: i.repo } }))
    },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
    timelineItems: crossRefNodes(pr.crossRefs)
  }
}

function issueNode(r: MockRepo, i: MockIssue) {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    url: `https://github.com/${r.repo}/issues/${i.number}`,
    state: i.state,
    stateReason: i.stateReason,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
    author: actor(i.author),
    assignees: logins(i.assignees),
    labels: { nodes: i.labels.map((name) => ({ name })) },
    timelineItems: crossRefNodes(i.crossRefs)
  }
}

const RATE = { cost: 1, remaining: 4999, resetAt: '2030-01-01T00:00:00Z' }

function graphql(body: any): { reply: Reply; operation?: string } {
  const query: string = body?.query ?? ''
  const vars: Record<string, any> = body?.variables ?? {}
  const operation = /^\s*query\s+(\w+)/.exec(query)?.[1]
  const gqlError = (type: string, message: string) => json(200, { data: null, errors: [{ type, message }] })
  if (!operation) return { reply: gqlError('PARSE', 'mock-github answers named queries only'), operation }

  const repoName = `${vars.owner}/${vars.name}`
  const r = model.repo(repoName)
  const notFound = () =>
    json(200, {
      data: { rateLimit: RATE, repository: null },
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['repository'],
          message: `Could not resolve to a Repository with the name '${repoName}'.`
        }
      ]
    })

  switch (operation) {
    case 'ForgeChanges': {
      if (!/orderBy:\s*\{\s*field:\s*UPDATED_AT,\s*direction:\s*DESC\s*\}/.test(query)) {
        return { reply: gqlError('MOCK', 'ForgeChanges must order by UPDATED_AT DESC'), operation }
      }
      if (!r) return { reply: notFound(), operation }
      const states: string[] | null = vars.states ?? null
      const all = [...r.pulls.values()].filter((p) => !states || states.includes(p.state)).sort(byUpdatedDesc)
      const { slice, pageInfo } = page(all, vars.first, vars.after)
      return {
        reply: json(200, {
          data: { rateLimit: RATE, repository: { pullRequests: { pageInfo, nodes: slice.map((p) => prNode(r, p)) } } }
        }),
        operation
      }
    }
    case 'ForgeIssues': {
      if (!r) return { reply: notFound(), operation }
      const states: string[] | null = vars.states ?? null
      const since = vars.since ? Date.parse(vars.since) : NaN
      const all = [...r.issues.values()]
        .filter((i) => !states || states.includes(i.state))
        .filter((i) => Number.isNaN(since) || Date.parse(i.updatedAt) >= since)
        .sort(byUpdatedDesc)
      const { slice, pageInfo } = page(all, vars.first, vars.after)
      return {
        reply: json(200, {
          data: { rateLimit: RATE, repository: { issues: { pageInfo, nodes: slice.map((i) => issueNode(r, i)) } } }
        }),
        operation
      }
    }
    case 'ForgeBranches': {
      if (!r) return { reply: notFound(), operation }
      const all = [...r.branches.values()].sort((a, b) => a.name.localeCompare(b.name))
      const { slice, pageInfo } = page(all, vars.first, vars.after)
      return {
        reply: json(200, {
          data: {
            rateLimit: RATE,
            repository: { refs: { pageInfo, nodes: slice.map((b) => ({ name: b.name, target: { oid: b.sha } })) } }
          }
        }),
        operation
      }
    }
    default:
      return { reply: gqlError('MOCK', `mock-github does not answer query ${operation}`), operation }
  }
}

// ── REST ─────────────────────────────────────────────────────────────

function pullJson(r: MockRepo, pr: MockPr) {
  return {
    number: pr.number,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    merged: pr.state === 'MERGED',
    draft: pr.isDraft,
    title: pr.title,
    body: pr.body,
    html_url: `https://github.com/${r.repo}/pull/${pr.number}`,
    user: actor(pr.author),
    assignees: pr.assignees.map((login) => ({ login })),
    head: { ref: pr.head, sha: pr.headSha, repo: { full_name: pr.headRepo ?? r.repo } },
    base: { ref: pr.base },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt
  }
}

function issueJson(r: MockRepo, item: MockPr | MockIssue, isPr: boolean) {
  return {
    number: item.number,
    title: item.title,
    state: item.state === 'OPEN' ? 'open' : 'closed',
    html_url: `https://github.com/${r.repo}/${isPr ? 'pull' : 'issues'}/${item.number}`,
    assignees: item.assignees.map((login) => ({ login })),
    updated_at: item.updatedAt
  }
}

/** Slice a list by ?per_page&page and add a Link header for the next page. */
function paged(url: URL, items: unknown[], wrap?: (slice: unknown[]) => unknown): Reply {
  const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30)))
  const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? 1))
  const slice = items.slice((pageNo - 1) * per, pageNo * per)
  const headers: Record<string, string> = {}
  if (pageNo * per < items.length) {
    const next = new URL(url.toString())
    next.searchParams.set('page', String(pageNo + 1))
    headers.link = `<${next.toString()}>; rel="next"`
  }
  return json(200, wrap ? wrap(slice) : slice, headers)
}

const commentJson =
  (r: MockRepo, n: number, review: boolean) => (c: { id: number; login: string; body: string; createdAt: string }) => ({
    id: c.id,
    user: { login: c.login },
    body: c.body,
    created_at: c.createdAt,
    html_url: `https://github.com/${r.repo}/pull/${n}#${review ? 'discussion_r' : 'issuecomment-'}${c.id}`
  })

async function rest(method: string, url: URL, body: any): Promise<Reply> {
  const p = url.pathname
  if (method === 'GET' && p === '/user') return json(200, { login: model.viewer, id: 1, type: 'User' })

  const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(p)
  if (!m) return json(404, { message: 'Not Found' })
  const r = model.repo(`${m[1]}/${m[2]}`)
  if (!r) return json(404, { message: 'Not Found' })
  const rest = m[3]
  let x: RegExpExecArray | null

  if (method === 'GET' && (x = /^pulls\/(\d+)$/.exec(rest))) {
    const pr = r.pulls.get(Number(x[1]))
    return pr ? json(200, pullJson(r, pr)) : json(404, { message: 'Not Found' })
  }
  if (method === 'GET' && (x = /^commits\/([^/]+)\/check-runs$/.exec(rest))) {
    const c = r.checks.get(decodeURIComponent(x[1]))
    const runs = (c?.runs ?? []).map((run, i) => ({ id: i + 1, ...run }))
    return paged(url, runs, (slice) => ({ total_count: runs.length, check_runs: slice }))
  }
  if (method === 'GET' && (x = /^commits\/([^/]+)\/status$/.exec(rest))) {
    const commit = decodeURIComponent(x[1])
    const statuses = r.checks.get(commit)?.statuses ?? []
    const rollup = model.rollup(r.repo, commit)
    const state = rollup === 'FAILURE' ? 'failure' : rollup === 'SUCCESS' ? 'success' : 'pending'
    return paged(url, statuses, (slice) => ({ state, sha: commit, total_count: statuses.length, statuses: slice }))
  }
  if (method === 'GET' && (x = /^commits\/(.+)$/.exec(rest))) {
    const ref = decodeURIComponent(x[1])
    const commit = model.resolveRef(r.repo, ref)
    return commit
      ? json(200, { sha: commit, commit: { message: `commit ${commit.slice(0, 7)}` } })
      : json(422, { message: `No commit found for SHA: ${ref}` })
  }
  if (method === 'GET' && (x = /^compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
    const base = decodeURIComponent(x[1])
    const head = decodeURIComponent(x[2])
    const hb = r.branches.get(head)
    if (!r.branches.has(base) || !hb) return json(404, { message: 'Not Found' })
    // Branches record ahead/behind against the default branch; that is what the adapter compares to.
    const ahead = head === base ? 0 : hb.ahead
    const behind = head === base ? 0 : hb.behind
    return json(200, {
      status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical',
      ahead_by: ahead,
      behind_by: behind,
      total_commits: ahead,
      commits: []
    })
  }
  if (method === 'GET' && (x = /^issues\/(\d+)\/comments$/.exec(rest))) {
    const t = model.findItem(r.repo, Number(x[1]))
    if (!t) return json(404, { message: 'Not Found' })
    return paged(url, t.item.comments.map(commentJson(r, t.item.number, false)))
  }
  if (method === 'GET' && (x = /^pulls\/(\d+)\/comments$/.exec(rest))) {
    const pr = r.pulls.get(Number(x[1]))
    if (!pr) return json(404, { message: 'Not Found' })
    return paged(url, pr.reviewComments.map(commentJson(r, pr.number, true)))
  }
  if ((method === 'POST' || method === 'DELETE') && (x = /^issues\/(\d+)\/assignees$/.exec(rest))) {
    const list = body?.assignees
    if (!Array.isArray(list) || list.some((a) => typeof a !== 'string')) {
      return json(422, { message: 'Validation Failed', errors: [{ field: 'assignees', code: 'invalid' }] })
    }
    const t = model.setAssignees(r.repo, Number(x[1]), method === 'POST' ? list : [], method === 'DELETE' ? list : [])
    return json(method === 'POST' ? 201 : 200, issueJson(r, t.item, t.kind === 'pr'))
  }
  return json(404, { message: 'Not Found', documentation_url: 'mock-github' })
}

// ── Control API ──────────────────────────────────────────────────────

async function control(method: string, p: string, body: any): Promise<Reply> {
  const action = p.slice('/mock/github/'.length)
  if (method === 'GET' && action === 'log') return json(200, requestLog)
  if (method === 'GET' && action === 'state') return json(200, model.snapshot())
  if (method !== 'POST') return json(405, { error: 'POST only' })
  switch (action) {
    case 'reset':
      model.reset()
      requestLog = []
      failures = []
      return json(200, { ok: true })
    case 'seed':
      model.seed(body ?? {})
      return json(200, model.snapshot())
    case 'repo':
      return json(200, { repo: model.ensureRepo(body.repo, body.defaultBranch).repo })
    case 'pr':
      return json(200, model.upsertPr(body))
    case 'issue':
      return json(200, model.upsertIssue(body))
    case 'branch':
      return json(200, model.upsertBranch(body) ?? { deleted: body.name })
    case 'review':
      return json(200, model.review(body))
    case 'checks':
      return json(200, model.setChecks(body))
    case 'merge':
      return json(200, model.merge(body))
    case 'comment':
      return json(200, model.comment(body))
    case 'assign': {
      const t = model.setAssignees(body.repo, body.number, body.add ?? [], body.remove ?? [])
      return json(200, t.item)
    }
    case 'fail': {
      const f: Failure = {
        status: Number(body?.status ?? 502),
        count: Number(body?.count ?? 1),
        path: body?.path,
        method: body?.method,
        retryAfter: body?.retryAfter,
        message: body?.message
      }
      failures.push(f)
      return json(200, { queued: failures.length })
    }
    default:
      return json(404, { error: `unknown control action ${action}` })
  }
}

function injectedFailure(method: string, p: string): Reply | undefined {
  const f = failures.find((x) => x.count > 0 && (!x.path || p.startsWith(x.path)) && (!x.method || x.method === method))
  if (!f) return undefined
  f.count--
  failures = failures.filter((x) => x.count > 0)
  const headers: Record<string, string> = {}
  if (f.retryAfter !== undefined) headers['retry-after'] = String(f.retryAfter)
  const message =
    f.message ??
    (f.status === 403 || f.status === 429 ? 'You have exceeded a secondary rate limit.' : 'Server Error (mock-github)')
  return json(f.status, { message }, headers)
}

// ── Server ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const p = url.pathname
  let reply: Reply
  let entry: LogEntry | undefined
  try {
    const body = await readBody(req)
    if (p === '/health') {
      reply = json(200, { ok: true })
    } else if (p.startsWith('/mock/github/')) {
      reply = await control(method, p, body)
    } else {
      entry = { at: new Date().toISOString(), method, path: p + url.search, status: 0 }
      if (body !== undefined && p !== '/graphql' && p !== '/api/graphql') entry.body = body
      const auth = req.headers.authorization
      const failure = injectedFailure(method, p)
      if (!auth || !/^(bearer|token)\s+\S+/i.test(auth)) {
        reply = json(401, { message: 'Requires authentication' })
      } else if (failure) {
        reply = failure
      } else if (method === 'POST' && (p === '/graphql' || p === '/api/graphql')) {
        const out = graphql(body)
        reply = out.reply
        entry.operation = out.operation
        entry.variables = body?.variables
      } else {
        reply = await rest(method, url, body)
      }
      // ETags on successful REST GETs.
      if (method === 'GET' && reply.status === 200) {
        const etag = `W/"${sha(JSON.stringify(reply.body))}"`
        reply.headers = { ...reply.headers, etag }
        if (req.headers['if-none-match'] === etag) reply = { status: 304, headers: { etag } }
      }
    }
  } catch (err) {
    const status = err instanceof MockError ? err.status : 500
    reply = json(status, { message: (err as Error).message })
  }
  if (entry) {
    entry.status = reply.status
    requestLog.push(entry)
    if (VERBOSE)
      console.log(
        `[mock-github] ${method} ${entry.path}${entry.operation ? ` (${entry.operation})` : ''} → ${reply.status}`
      )
  }
  res.writeHead(reply.status, {
    ...(reply.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...reply.headers
  })
  res.end(reply.body !== undefined && reply.status !== 304 ? JSON.stringify(reply.body) : undefined)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-github] listening on :${PORT}`)
})
