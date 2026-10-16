// GitHub adapter for the Forge interface. Lists come from GraphQL (one page
// holds a PR with its reviews, labels, closing issues, check rollup and
// cross-references); single-item reads and the one write (assignees) use
// REST, whose GETs are ETag-cached so a repeat costs no rate limit.
//
// PR bodies are passed through unchanged: "Paired with: owner/repo#N" blocks
// are read by the work-graph builder, not here.

import type {
  Change,
  ChangeState,
  CheckSummary,
  Forge,
  ForgeBranch,
  ForgeComment,
  ForgeIssue,
  ForgePage,
  ForgeRef,
  ListOpts,
  PageOpts,
  Review,
  ReviewState
} from '@sovereign/core'
import { rollupToChecks, summarizeChecks, toCheckStates } from './checks.js'
import { BRANCHES_QUERY, CHANGES_QUERY, ISSUES_QUERY } from './queries.js'
import { createGithubTransport, GithubError, type GithubTransport, type GithubTransportOpts } from './transport.js'

export interface PageInfo {
  op: 'changes' | 'issues' | 'branches'
  repo: string
  /** Items on the page (before the since/until cut). */
  items: number
  /** GraphQL points the page cost. */
  cost?: number
  ms: number
}

export interface GithubForgeOpts extends GithubTransportOpts {
  /** Host used in ForgeRefs. Default: github.com, or the Enterprise host of an `/api/v3` apiUrl. */
  host?: string
  /** GraphQL page size for changes and issues (default 50 — 100 takes 6–9 s per page on a large repo). */
  pageSize?: number
  /** Stop after this many pages per list (default 100). */
  maxPages?: number
  /** Called after every GraphQL page (timing, cost). */
  onPage?: (info: PageInfo) => void
  /** Use this transport instead of building one from the options. */
  transport?: GithubTransport
}

export interface GithubForge extends Forge {
  transport: GithubTransport
  pageChanges: NonNullable<Forge['pageChanges']>
  pageIssues: NonNullable<Forge['pageIssues']>
}

/** Host for refs, from the REST base: an Enterprise `/api/v3` base names its host; anything else is github.com. */
export function hostForApi(apiUrl: string): string {
  try {
    const u = new URL(apiUrl)
    if (/\/api\/v3\/?$/.test(u.pathname)) return u.hostname
  } catch {
    // fall through
  }
  return 'github.com'
}

function splitRepo(repo: string): { owner: string; name: string } {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo)
  if (!m) throw new Error(`not an owner/name repo: ${repo}`)
  return { owner: m[1], name: m[2] }
}

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed'
}

const login = (actor: any): string => actor?.login ?? actor?.combinedSlug ?? 'ghost'

const nodes = (conn: any): any[] => (Array.isArray(conn?.nodes) ? conn.nodes.filter(Boolean) : [])

export interface MapContext {
  host: string
  repo: string
}

function ref(ctx: MapContext, repo: string, kind: ForgeRef['kind'], id: string | number): ForgeRef {
  return { forge: 'github', host: ctx.host, repo, kind, id: String(id) }
}

/** Items that mention this one, from CROSS_REFERENCED_EVENT timeline items. */
function crossRefs(ctx: MapContext, timeline: any, self: ForgeRef): ForgeRef[] {
  const out = new Map<string, ForgeRef>()
  for (const ev of nodes(timeline)) {
    const s = ev?.source
    const repo = s?.repository?.nameWithOwner
    if (!repo || typeof s.number !== 'number') continue
    const r = ref(ctx, repo, s.__typename === 'PullRequest' ? 'change' : 'issue', s.number)
    if (r.repo === self.repo && r.id === self.id) continue
    out.set(`${r.kind}:${r.repo}#${r.id}`, r)
  }
  return [...out.values()]
}

/** A GraphQL PullRequest node → Change. */
export function mapChange(ctx: MapContext, pr: any): Change {
  const self = ref(ctx, ctx.repo, 'change', pr.number)
  const state: ChangeState = pr.merged
    ? 'merged'
    : pr.state === 'CLOSED'
      ? 'closed'
      : pr.state === 'MERGED'
        ? 'merged'
        : pr.isDraft
          ? 'draft'
          : 'open'

  const reviewers: Review[] = []
  const seen = new Set<string>()
  // A re-requested review is the current state, so requests go first.
  for (const r of nodes(pr.reviewRequests)) {
    const who = r.requestedReviewer ? login(r.requestedReviewer) : undefined
    if (!who || seen.has(who)) continue
    seen.add(who)
    reviewers.push({ login: who, state: 'requested' })
  }
  for (const r of nodes(pr.latestReviews)) {
    const who = login(r.author)
    const s = REVIEW_STATES[r.state]
    if (!s || seen.has(who)) continue
    seen.add(who)
    reviewers.push({ login: who, state: s })
  }

  const commit = nodes(pr.commits)[0]?.commit
  const checks: CheckSummary | undefined = commit ? rollupToChecks(commit.statusCheckRollup) : undefined
  const headRepo: string | undefined = pr.headRepository?.nameWithOwner

  const extra: Record<string, unknown> = {}
  if (pr.mergedAt) extra.mergedAt = pr.mergedAt
  if (headRepo && headRepo !== ctx.repo) extra.headRepo = headRepo

  return {
    ref: self,
    title: pr.title ?? '',
    body: pr.body ?? '',
    state,
    author: login(pr.author),
    assignees: nodes(pr.assignees).map((a) => a.login),
    reviewers,
    labels: nodes(pr.labels).map((l) => l.name),
    head: { ...(pr.headRefName ? { branch: pr.headRefName } : {}), sha: pr.headRefOid ?? '' },
    base: { branch: pr.baseRefName ?? '' },
    ...(pr.mergeable === 'MERGEABLE'
      ? { mergeable: true }
      : pr.mergeable === 'CONFLICTING'
        ? { mergeable: false }
        : {}),
    closes: nodes(pr.closingIssuesReferences)
      .filter((i) => i.repository?.nameWithOwner)
      .map((i) => ref(ctx, i.repository.nameWithOwner, 'issue', i.number)),
    references: crossRefs(ctx, pr.timelineItems, self),
    ...(checks ? { checks } : {}),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ...(state === 'merged' || state === 'closed' ? { closedAt: pr.mergedAt ?? pr.closedAt ?? undefined } : {}),
    url: pr.url,
    ...(Object.keys(extra).length ? { extra } : {})
  }
}

/** A GraphQL Issue node → ForgeIssue. */
export function mapIssue(ctx: MapContext, issue: any): ForgeIssue {
  const self = ref(ctx, ctx.repo, 'issue', issue.number)
  const closed = issue.state === 'CLOSED'
  const reason =
    closed && issue.stateReason
      ? issue.stateReason === 'COMPLETED'
        ? 'completed'
        : issue.stateReason === 'NOT_PLANNED' || issue.stateReason === 'DUPLICATE'
          ? 'not_planned'
          : undefined
      : undefined
  return {
    ref: self,
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: closed ? 'closed' : 'open',
    ...(reason ? { closedReason: reason } : {}),
    author: login(issue.author),
    assignees: nodes(issue.assignees).map((a) => a.login),
    labels: nodes(issue.labels).map((l) => l.name),
    references: crossRefs(ctx, issue.timelineItems, self),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(closed && issue.closedAt ? { closedAt: issue.closedAt } : {}),
    url: issue.url
  }
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN)

export function createGithubForge(opts: GithubForgeOpts = {}): GithubForge {
  const transport = opts.transport ?? createGithubTransport(opts)
  const host = opts.host ?? hostForApi(transport.apiUrl)
  const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 50))
  const maxPages = opts.maxPages ?? 100
  let me: Promise<string> | undefined

  /** One GraphQL page of a connection ordered by updatedAt desc. */
  async function fetchPage(
    op: 'changes' | 'issues',
    repo: string,
    query: string,
    vars: Record<string, unknown>,
    connection: (data: any) => any,
    after: string | undefined
  ): Promise<{ items: any[]; cursor?: string; hasNext: boolean }> {
    const { owner, name } = splitRepo(repo)
    const started = Date.now()
    const { data, cost } = await transport.graphql(query, {
      owner,
      name,
      first: pageSize,
      after: after ?? null,
      ...vars
    })
    if (!data?.repository) throw new GithubError(`GitHub repo not found: ${repo}`, 404)
    const conn = connection(data.repository)
    const items = nodes(conn)
    opts.onPage?.({ op, repo, items: items.length, cost, ms: Date.now() - started })
    const hasNext = Boolean(conn?.pageInfo?.hasNextPage)
    return { items, hasNext, ...(hasNext && conn.pageInfo.endCursor ? { cursor: conn.pageInfo.endCursor } : {}) }
  }

  /**
   * Page a connection ordered by updatedAt desc. Items updated at or after
   * `until` are skipped; the first item before `since` ends the paging,
   * since every later item is older still.
   */
  async function pageUpdated<T>(
    op: 'changes' | 'issues',
    repo: string,
    query: string,
    vars: Record<string, unknown>,
    connection: (data: any) => any,
    map: (node: any) => T,
    list: ListOpts
  ): Promise<T[]> {
    splitRepo(repo)
    const since = time(list.since)
    const until = time(list.until)
    const out: T[] = []
    let after: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const { items, cursor, hasNext } = await fetchPage(op, repo, query, vars, connection, after)
      let older = false
      for (const node of items) {
        const updated = time(node.updatedAt)
        if (updated < since) {
          older = true
          break
        }
        if (updated >= until) continue
        out.push(map(node))
      }
      if (older || !hasNext || !cursor) break
      after = cursor
    }
    return out
  }

  /** One page for a resumable backfill: all states, items at or after `until` skipped. */
  async function onePage<T>(
    op: 'changes' | 'issues',
    repo: string,
    query: string,
    vars: Record<string, unknown>,
    connection: (data: any) => any,
    map: (node: any) => T,
    page: PageOpts
  ): Promise<ForgePage<T>> {
    const until = time(page.until)
    const { items, cursor, hasNext } = await fetchPage(op, repo, query, vars, connection, page.after)
    return {
      items: items.filter((n) => !(time(n.updatedAt) >= until)).map(map),
      hasNext,
      ...(cursor ? { cursor } : {})
    }
  }

  /** A REST list with `total_count` and an item key (check runs, statuses), paged by `page`. */
  async function listKeyed(apiPath: string, key: string): Promise<any[]> {
    const first = (await transport.rest('GET', `${apiPath}?per_page=100`)).body
    const items: any[] = [...(first?.[key] ?? [])]
    const total: number = first?.total_count ?? items.length
    for (let page = 2; items.length < total && page <= 10; page++) {
      const batch = (await transport.rest('GET', `${apiPath}?per_page=100&page=${page}`)).body?.[key] ?? []
      if (!batch.length) break
      items.push(...batch)
    }
    return items
  }

  function numberOf(r: ForgeRef): number {
    if (r.forge !== 'github' || r.kind === 'branch')
      throw new Error(`not a GitHub change or issue: ${r.forge} ${r.kind}`)
    const n = Number(r.id)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`not a GitHub number: ${r.id}`)
    return n
  }

  const mapComment = (c: any): ForgeComment => ({
    author: login(c.user),
    body: c.body ?? '',
    createdAt: c.created_at,
    ...(c.html_url ? { url: c.html_url } : {})
  })

  const forge: GithubForge = {
    kind: 'github',
    host,
    transport,
    capabilities: { reviews: true, checks: true, labels: true, assignees: true, crossRefs: true },

    listChanges(repo, list = {}) {
      const ctx = { host, repo }
      return pageUpdated(
        'changes',
        repo,
        CHANGES_QUERY,
        { states: list.state === 'open' ? ['OPEN'] : null },
        (r) => r.pullRequests,
        (n) => mapChange(ctx, n),
        list
      )
    },

    listIssues(repo, list = {}) {
      const ctx = { host, repo }
      return pageUpdated(
        'issues',
        repo,
        ISSUES_QUERY,
        { states: list.state === 'open' ? ['OPEN'] : null, since: list.since ?? null },
        (r) => r.issues,
        (n) => mapIssue(ctx, n),
        list
      )
    },

    pageChanges(repo, page = {}) {
      const ctx = { host, repo }
      return onePage(
        'changes',
        repo,
        CHANGES_QUERY,
        { states: null },
        (r) => r.pullRequests,
        (n) => mapChange(ctx, n),
        page
      )
    },

    pageIssues(repo, page = {}) {
      const ctx = { host, repo }
      return onePage(
        'issues',
        repo,
        ISSUES_QUERY,
        { states: null, since: null },
        (r) => r.issues,
        (n) => mapIssue(ctx, n),
        page
      )
    },

    async listBranches(repo) {
      const { owner, name } = splitRepo(repo)
      const out: ForgeBranch[] = []
      let after: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const started = Date.now()
        const { data, cost } = await transport.graphql(BRANCHES_QUERY, {
          owner,
          name,
          first: 100,
          after: after ?? null
        })
        if (!data?.repository) throw new GithubError(`GitHub repo not found: ${repo}`, 404)
        const conn = data.repository.refs
        const items = nodes(conn)
        opts.onPage?.({ op: 'branches', repo, items: items.length, cost, ms: Date.now() - started })
        for (const n of items) out.push({ name: n.name, sha: n.target?.oid ?? '' })
        if (!conn?.pageInfo?.hasNextPage) break
        after = conn.pageInfo.endCursor
      }
      return out
    },

    async compare(repo, base, head) {
      splitRepo(repo)
      const r = await transport.rest(
        'GET',
        `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`
      )
      return { ahead: r.body?.ahead_by ?? 0, behind: r.body?.behind_by ?? 0 }
    },

    async checks(r) {
      if (r.forge !== 'github' || r.kind === 'issue') return undefined
      const sha =
        r.kind === 'change'
          ? (await transport.rest('GET', `repos/${r.repo}/pulls/${numberOf(r)}`)).body?.head?.sha
          : (await transport.rest('GET', `repos/${r.repo}/commits/${encodeURIComponent(r.id)}`)).body?.sha
      if (!sha) return undefined
      const [runs, statuses] = await Promise.all([
        listKeyed(`repos/${r.repo}/commits/${sha}/check-runs`, 'check_runs'),
        listKeyed(`repos/${r.repo}/commits/${sha}/status`, 'statuses')
      ])
      return summarizeChecks(toCheckStates(runs, statuses))
    },

    async comments(r) {
      const n = numberOf(r)
      const lists = await Promise.all([
        transport.restPages(`repos/${r.repo}/issues/${n}/comments?per_page=100`),
        r.kind === 'change' ? transport.restPages(`repos/${r.repo}/pulls/${n}/comments?per_page=100`) : []
      ])
      return lists
        .flat()
        .map(mapComment)
        .sort((a, b) => time(a.createdAt) - time(b.createdAt))
    },

    async setAssignees(r, add, remove) {
      const n = numberOf(r)
      const adding = [...new Set(add)]
      const removing = [...new Set(remove)].filter((l) => !adding.includes(l))
      if (adding.length) await transport.rest('POST', `repos/${r.repo}/issues/${n}/assignees`, { assignees: adding })
      if (removing.length) {
        await transport.rest('DELETE', `repos/${r.repo}/issues/${n}/assignees`, { assignees: removing })
      }
    },

    identity() {
      me ??= transport.rest('GET', 'user').then((r) => {
        const l = r.body?.login
        if (!l) throw new GithubError('GitHub /user returned no login', 500)
        return l as string
      })
      me.catch(() => (me = undefined))
      return me
    }
  }
  return forge
}
