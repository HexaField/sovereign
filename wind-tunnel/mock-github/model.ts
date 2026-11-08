// Mock GitHub — the in-memory model. Repos hold pull requests and issues
// (one number sequence, as on GitHub), branches, check runs / statuses per
// commit, and comments. Scenarios seed and mutate it through the control
// API in server.ts; the GraphQL and REST handlers there read it.

import crypto from 'node:crypto'

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type ReviewStateGql = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

export interface ItemRef {
  repo: string
  number: number
}

export interface CrossRef extends ItemRef {
  type: 'PullRequest' | 'Issue'
}

export interface MockComment {
  id: number
  login: string
  body: string
  createdAt: string
}

export interface MockPr {
  number: number
  title: string
  body: string
  state: PrState
  isDraft: boolean
  author: string | null
  assignees: string[]
  /** Logins (users) or "org/team" (teams). */
  reviewRequests: string[]
  reviews: Array<{ login: string; state: ReviewStateGql; at: string }>
  labels: string[]
  head: string
  headSha: string
  base: string
  /** "owner/name" of a fork head; default: the repo itself. */
  headRepo?: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** Issues the PR closes (besides the "Closes #N" keywords in its body). */
  closes: ItemRef[]
  crossRefs: CrossRef[]
  comments: MockComment[]
  reviewComments: MockComment[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  mergedAt: string | null
}

export interface MockIssue {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | 'DUPLICATE' | null
  author: string | null
  assignees: string[]
  labels: string[]
  crossRefs: CrossRef[]
  comments: MockComment[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface MockBranch {
  name: string
  sha: string
  /** Commits ahead of / behind the default branch (for compare). */
  ahead: number
  behind: number
}

export interface CheckRun {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: string | null
  html_url?: string
  output?: { title?: string }
}

export interface CommitStatus {
  context: string
  state: 'pending' | 'success' | 'failure' | 'error'
  target_url?: string
  description?: string
}

export interface MockRepo {
  repo: string
  defaultBranch: string
  branches: Map<string, MockBranch>
  pulls: Map<number, MockPr>
  issues: Map<number, MockIssue>
  checks: Map<string, { runs: CheckRun[]; statuses: CommitStatus[] }>
  nextNumber: number
}

export const sha = (seed: string) => crypto.createHash('sha1').update(seed).digest('hex')

export class GithubModel {
  viewer = 'hex-agent'
  repos = new Map<string, MockRepo>()
  private lastTime = 0
  private commentId = 1000

  reset() {
    this.viewer = 'hex-agent'
    this.repos.clear()
    this.lastTime = 0
    this.commentId = 1000
  }

  /** A timestamp strictly after the previous one, so updatedAt order is stable. */
  tick(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1000)
    return new Date(this.lastTime).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  /** Keep the clock past a seeded time. */
  private observe(iso: string | null | undefined) {
    const t = iso ? Date.parse(iso) : NaN
    if (!Number.isNaN(t) && t > this.lastTime) this.lastTime = t
  }

  repo(name: string): MockRepo | undefined {
    return this.repos.get(name.toLowerCase())
  }

  need(name: string): MockRepo {
    const r = this.repo(name)
    if (!r) throw new MockError(404, `no repo ${name}`)
    return r
  }

  ensureRepo(name: string, defaultBranch = 'main'): MockRepo {
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) throw new MockError(400, `repo must be owner/name: ${name}`)
    let r = this.repo(name)
    if (!r) {
      r = {
        repo: name,
        defaultBranch,
        branches: new Map(),
        pulls: new Map(),
        issues: new Map(),
        checks: new Map(),
        nextNumber: 1
      }
      r.branches.set(defaultBranch, { name: defaultBranch, sha: sha(`${name}:${defaultBranch}`), ahead: 0, behind: 0 })
      this.repos.set(name.toLowerCase(), r)
    }
    return r
  }

  /** Replace whole repos (and optionally the viewer). */
  seed(input: { viewer?: string; repos?: any[] }) {
    if (input.viewer) this.viewer = input.viewer
    for (const spec of input.repos ?? []) {
      this.repos.delete(String(spec.repo).toLowerCase())
      this.ensureRepo(spec.repo, spec.defaultBranch ?? 'main')
      for (const b of spec.branches ?? []) this.upsertBranch({ repo: spec.repo, ...b })
      // Issues first, so PR bodies that reference them cross-link.
      for (const i of spec.issues ?? []) this.upsertIssue({ repo: spec.repo, ...i })
      for (const p of spec.pulls ?? []) this.upsertPr({ repo: spec.repo, ...p })
      for (const c of spec.checks ?? []) this.setChecks({ repo: spec.repo, ...c })
    }
  }

  upsertBranch(b: { repo: string; name: string; sha?: string; ahead?: number; behind?: number; delete?: boolean }) {
    const r = this.need(b.repo)
    if (b.delete) {
      r.branches.delete(b.name)
      return undefined
    }
    const prev = r.branches.get(b.name)
    const next: MockBranch = {
      name: b.name,
      sha: b.sha ?? prev?.sha ?? sha(`${b.repo}:${b.name}:${this.tick()}`),
      ahead: b.ahead ?? prev?.ahead ?? 0,
      behind: b.behind ?? prev?.behind ?? 0
    }
    r.branches.set(b.name, next)
    return next
  }

  private takeNumber(r: MockRepo, n?: number): number {
    const num = n ?? r.nextNumber
    if (num >= r.nextNumber) r.nextNumber = num + 1
    return num
  }

  upsertIssue(spec: any): MockIssue {
    const r = this.need(spec.repo)
    const prev = spec.number ? r.issues.get(spec.number) : undefined
    if (spec.number && !prev && r.pulls.has(spec.number)) throw new MockError(422, `#${spec.number} is a pull request`)
    const now = spec.updatedAt ?? this.tick()
    const state = spec.state ?? prev?.state ?? 'OPEN'
    const issue: MockIssue = {
      number: prev?.number ?? this.takeNumber(r, spec.number),
      title: spec.title ?? prev?.title ?? 'Untitled issue',
      body: spec.body ?? prev?.body ?? '',
      state,
      stateReason:
        spec.stateReason ?? (state === 'CLOSED' ? (prev?.stateReason ?? 'COMPLETED') : (prev?.stateReason ?? null)),
      author: spec.author !== undefined ? spec.author : (prev?.author ?? this.viewer),
      assignees: spec.assignees ?? prev?.assignees ?? [],
      labels: spec.labels ?? prev?.labels ?? [],
      crossRefs: spec.crossRefs ?? prev?.crossRefs ?? [],
      comments: prev?.comments ?? [],
      createdAt: spec.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now,
      closedAt: state === 'CLOSED' ? (spec.closedAt ?? prev?.closedAt ?? now) : null
    }
    for (const t of [issue.createdAt, issue.updatedAt, issue.closedAt]) this.observe(t)
    r.issues.set(issue.number, issue)
    this.linkMentions(r.repo, issue.number, 'Issue', issue.body)
    return issue
  }

  upsertPr(spec: any): MockPr {
    const r = this.need(spec.repo)
    const prev = spec.number ? r.pulls.get(spec.number) : undefined
    if (spec.number && !prev && r.issues.has(spec.number)) throw new MockError(422, `#${spec.number} is an issue`)
    const now = spec.updatedAt ?? this.tick()
    const number = prev?.number ?? this.takeNumber(r, spec.number)
    const head = spec.head ?? prev?.head ?? `feature/${number}`
    const branch = r.branches.get(head) ?? this.upsertBranch({ repo: r.repo, name: head, sha: spec.headSha, ahead: 1 })!
    const state: PrState = spec.state ?? prev?.state ?? 'OPEN'
    const pr: MockPr = {
      number,
      title: spec.title ?? prev?.title ?? `Change ${number}`,
      body: spec.body ?? prev?.body ?? '',
      state,
      isDraft: spec.isDraft ?? prev?.isDraft ?? false,
      author: spec.author !== undefined ? spec.author : (prev?.author ?? this.viewer),
      assignees: spec.assignees ?? prev?.assignees ?? [],
      reviewRequests: spec.reviewRequests ?? prev?.reviewRequests ?? [],
      reviews: spec.reviews ?? prev?.reviews ?? [],
      labels: spec.labels ?? prev?.labels ?? [],
      head,
      headSha: spec.headSha ?? branch.sha,
      base: spec.base ?? prev?.base ?? r.defaultBranch,
      headRepo: spec.headRepo ?? prev?.headRepo,
      mergeable: spec.mergeable ?? prev?.mergeable ?? 'MERGEABLE',
      closes: spec.closes ?? prev?.closes ?? [],
      crossRefs: spec.crossRefs ?? prev?.crossRefs ?? [],
      comments: prev?.comments ?? [],
      reviewComments: prev?.reviewComments ?? [],
      createdAt: spec.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now,
      closedAt: state === 'OPEN' ? null : (spec.closedAt ?? prev?.closedAt ?? now),
      mergedAt: state === 'MERGED' ? (spec.mergedAt ?? prev?.mergedAt ?? spec.closedAt ?? now) : null
    }
    if (spec.headSha) branch.sha = spec.headSha
    for (const t of [pr.createdAt, pr.updatedAt, pr.closedAt, pr.mergedAt]) this.observe(t)
    r.pulls.set(number, pr)
    this.linkMentions(r.repo, number, 'PullRequest', pr.body)
    return pr
  }

  /** "#N", "owner/repo#N" and issue/PR URLs in a body cross-reference their target, as on GitHub. */
  private linkMentions(repo: string, number: number, type: CrossRef['type'], body: string) {
    for (const t of mentions(repo, body)) {
      if (t.repo.toLowerCase() === repo.toLowerCase() && t.number === number) continue
      const target = this.findItem(t.repo, t.number)
      if (!target) continue
      if (target.item.crossRefs.some((c) => c.repo === repo && c.number === number)) continue
      target.item.crossRefs.push({ repo, number, type })
    }
  }

  findItem(
    repo: string,
    number: number
  ): { kind: 'pr'; item: MockPr } | { kind: 'issue'; item: MockIssue } | undefined {
    const r = this.repo(repo)
    if (!r) return undefined
    const pr = r.pulls.get(number)
    if (pr) return { kind: 'pr', item: pr }
    const issue = r.issues.get(number)
    return issue ? { kind: 'issue', item: issue } : undefined
  }

  /** Issues a PR closes: explicit `closes` + closing keywords in its body. */
  closingIssues(repo: string, pr: MockPr): ItemRef[] {
    const out = new Map<string, ItemRef>()
    const add = (ref: ItemRef) => {
      const t = this.findItem(ref.repo, ref.number)
      if (t?.kind === 'issue')
        out.set(`${t.item.number}@${ref.repo.toLowerCase()}`, { repo: this.repo(ref.repo)!.repo, number: ref.number })
    }
    for (const c of pr.closes) add(c)
    const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi
    let m
    while ((m = re.exec(pr.body)) !== null) {
      const [, ref] = m
      const [r, n] = ref.includes('/') ? ref.split('#') : [repo, ref.slice(1)]
      add({ repo: r, number: Number(n) })
    }
    return [...out.values()]
  }

  review(spec: { repo: string; number: number; login: string; state: ReviewStateGql | 'REQUESTED' }) {
    const pr = this.needPr(spec.repo, spec.number)
    if (spec.state === 'REQUESTED') {
      if (!pr.reviewRequests.includes(spec.login)) pr.reviewRequests.push(spec.login)
    } else {
      pr.reviewRequests = pr.reviewRequests.filter((l) => l !== spec.login)
      pr.reviews.push({ login: spec.login, state: spec.state, at: this.tick() })
    }
    pr.updatedAt = this.tick()
    return pr
  }

  /** Latest non-pending review per author, in submission order. */
  latestReviews(pr: MockPr) {
    const latest = new Map<string, MockPr['reviews'][number]>()
    for (const r of pr.reviews) {
      if (r.state === 'PENDING') continue
      latest.delete(r.login)
      latest.set(r.login, r)
    }
    return [...latest.values()]
  }

  needPr(repo: string, number: number): MockPr {
    const pr = this.need(repo).pulls.get(Number(number))
    if (!pr) throw new MockError(404, `no pull request ${repo}#${number}`)
    return pr
  }

  needItem(repo: string, number: number) {
    const t = this.findItem(repo, Number(number))
    if (!t) throw new MockError(404, `no issue or pull request ${repo}#${number}`)
    return t
  }

  /** Resolve a branch name or a sha to a commit sha. */
  resolveRef(repo: string, ref: string): string | undefined {
    const r = this.need(repo)
    const b = r.branches.get(ref)
    if (b) return b.sha
    if (/^[0-9a-f]{7,40}$/.test(ref)) return ref
    return undefined
  }

  setChecks(spec: {
    repo: string
    sha?: string
    branch?: string
    pr?: number
    runs?: CheckRun[]
    statuses?: CommitStatus[]
    append?: boolean
  }) {
    const r = this.need(spec.repo)
    const commit =
      spec.sha ??
      (spec.branch ? r.branches.get(spec.branch)?.sha : spec.pr ? this.needPr(spec.repo, spec.pr).headSha : undefined)
    if (!commit) throw new MockError(400, 'checks need sha, branch or pr')
    const prev = r.checks.get(commit)
    const next = spec.append
      ? {
          runs: [...(prev?.runs ?? []), ...(spec.runs ?? [])],
          statuses: [...(prev?.statuses ?? []), ...(spec.statuses ?? [])]
        }
      : { runs: spec.runs ?? prev?.runs ?? [], statuses: spec.statuses ?? prev?.statuses ?? [] }
    // As on GitHub, a check result does not touch the PR's updatedAt.
    r.checks.set(commit, next)
    return { sha: commit, ...next }
  }

  /** GraphQL statusCheckRollup.state for a commit, or null without checks. */
  rollup(repo: string, commit: string): string | null {
    const c = this.need(repo).checks.get(commit)
    if (!c || (!c.runs.length && !c.statuses.length)) return null
    const failed = new Set([
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
      'startup_failure',
      'stale',
      'error'
    ])
    const states = [
      ...c.runs.map((x) =>
        x.status !== 'completed' ? 'pending' : failed.has(x.conclusion ?? '') ? 'failure' : 'success'
      ),
      ...c.statuses.map((s) => (s.state === 'pending' ? 'pending' : s.state === 'success' ? 'success' : 'failure'))
    ]
    if (states.includes('failure')) return 'FAILURE'
    if (states.includes('pending')) return 'PENDING'
    return 'SUCCESS'
  }

  merge(spec: { repo: string; number: number; deleteBranch?: boolean }) {
    const r = this.need(spec.repo)
    const pr = this.needPr(spec.repo, spec.number)
    if (pr.state !== 'OPEN') throw new MockError(405, `pull request ${spec.repo}#${spec.number} is not open`)
    const now = this.tick()
    pr.state = 'MERGED'
    pr.isDraft = false
    pr.mergedAt = now
    pr.closedAt = now
    pr.updatedAt = now
    // Merging into the default branch closes the linked issues.
    if (pr.base === r.defaultBranch) {
      for (const ref of this.closingIssues(r.repo, pr)) {
        const t = this.findItem(ref.repo, ref.number)
        if (t?.kind !== 'issue' || t.item.state === 'CLOSED') continue
        t.item.state = 'CLOSED'
        t.item.stateReason = 'COMPLETED'
        t.item.closedAt = now
        t.item.updatedAt = this.tick()
      }
    }
    if (spec.deleteBranch) r.branches.delete(pr.head)
    return pr
  }

  comment(spec: { repo: string; number: number; login?: string; body: string; review?: boolean }) {
    const t = this.needItem(spec.repo, spec.number)
    const c: MockComment = {
      id: this.commentId++,
      login: spec.login ?? this.viewer,
      body: spec.body,
      createdAt: this.tick()
    }
    if (spec.review) {
      if (t.kind !== 'pr') throw new MockError(422, 'review comments need a pull request')
      t.item.reviewComments.push(c)
    } else {
      t.item.comments.push(c)
    }
    t.item.updatedAt = this.tick()
    this.linkMentions(this.need(spec.repo).repo, spec.number, t.kind === 'pr' ? 'PullRequest' : 'Issue', spec.body)
    return c
  }

  setAssignees(repo: string, number: number, add: string[], remove: string[]) {
    const t = this.needItem(repo, number)
    const before = t.item.assignees.join(',')
    const next = t.item.assignees.filter((a) => !remove.includes(a))
    for (const a of add) if (!next.includes(a)) next.push(a)
    t.item.assignees = next
    if (next.join(',') !== before) t.item.updatedAt = this.tick()
    return t
  }

  snapshot() {
    return {
      viewer: this.viewer,
      repos: [...this.repos.values()].map((r) => ({
        repo: r.repo,
        defaultBranch: r.defaultBranch,
        branches: [...r.branches.values()],
        pulls: [...r.pulls.values()],
        issues: [...r.issues.values()],
        checks: Object.fromEntries(r.checks)
      }))
    }
  }
}

export class MockError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** References in a body: "#N", "owner/repo#N", and github.com issue/PR URLs. */
export function mentions(repo: string, body: string): ItemRef[] {
  const out: ItemRef[] = []
  const url = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g
  let m
  while ((m = url.exec(body)) !== null) out.push({ repo: m[1], number: Number(m[2]) })
  const short = /(^|[^\w/])((?:[\w.-]+\/[\w.-]+)?)#(\d+)\b/g
  while ((m = short.exec(body)) !== null) out.push({ repo: m[2] || repo, number: Number(m[3]) })
  return out
}
