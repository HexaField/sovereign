// Test helpers: an in-memory Forge with GitHub's list semantics (newest
// updated first, since/until cuts, cursors), item builders, and the server's
// TaskPort without AD4M. Made-up orgs, repos and logins only.

import path from 'node:path'
import {
  createEventBus,
  type Change,
  type CheckSummary,
  type EventBus,
  type Forge,
  type ForgeBranch,
  type ForgeComment,
  type ForgeIssue,
  type ForgePage,
  type ForgeRef,
  type ListOpts,
  type PageOpts,
  type PortTask,
  type TaskPort
} from '@sovereign/core'
import { createForgeMetaStore, createForgeTaskPort, createInMemoryTaskStore, createTaskService } from '@sovereign/tasks'

export const HOST = 'github.com'

export interface TestTaskPort extends TaskPort {
  /** A PR or issue task no membrane holds, as `task_import` from a thread outside every membrane makes. */
  importTask(key: string, kind: 'change' | 'issue', name: string, threadId?: string): Promise<PortTask>
  dispose(): void
}

/** The TaskPort the server binds (TaskService + the Forge meta store), kept in memory and `dir`; task.* events go to `bus`. */
export function createTestTaskPort(dir: string, bus: EventBus = createEventBus(path.join(dir, 'bus'))): TestTaskPort {
  const service = createTaskService({ store: createInMemoryTaskStore(), bus })
  const meta = createForgeMetaStore({ dir, connect: null })
  const port = createForgeTaskPort({ service, meta })
  return {
    ...port,
    async importTask(key, kind, name, threadId) {
      const t = await port.ensureTask(key, { name, membrane: 'import', kind })
      await service.update(t.id, { membrane: null, ...(threadId ? { threadId } : {}), sourceThreadId: 'test' })
      return (await port.get(t.id))!
    },
    dispose: () => meta.dispose()
  }
}

export function ref(repo: string, n: number | string, kind: ForgeRef['kind'] = 'change'): ForgeRef {
  return { forge: 'github', host: HOST, repo, kind, id: String(n) }
}

let clock = Date.parse('2026-10-01T00:00:00Z')
export const at = (iso: string) => new Date(iso).toISOString()

export function change(repo: string, n: number, over: Partial<Change> = {}): Change {
  const t = over.updatedAt ?? new Date((clock += 1000)).toISOString()
  return {
    ref: ref(repo, n),
    title: `Change ${n}`,
    body: '',
    state: 'open',
    author: 'alex-dev',
    assignees: [],
    reviewers: [],
    labels: [],
    head: { branch: `feat/${n}`, sha: `sha-${n}-1` },
    base: { branch: 'dev' },
    closes: [],
    references: [],
    checks: { state: 'passing' },
    createdAt: over.createdAt ?? t,
    updatedAt: t,
    url: `https://${HOST}/${repo}/pull/${n}`,
    ...over
  }
}

export function issue(repo: string, n: number, over: Partial<ForgeIssue> = {}): ForgeIssue {
  const t = over.updatedAt ?? new Date((clock += 1000)).toISOString()
  return {
    ref: ref(repo, n, 'issue'),
    title: `Issue ${n}`,
    body: '',
    state: 'open',
    author: 'sam-reporter',
    assignees: [],
    labels: [],
    references: [],
    createdAt: over.createdAt ?? t,
    updatedAt: t,
    url: `https://${HOST}/${repo}/issues/${n}`,
    ...over
  }
}

export interface FakeForge extends Forge {
  changes: Map<string, Change[]>
  issues: Map<string, ForgeIssue[]>
  branches: Map<string, ForgeBranch[]>
  compares: Map<string, { ahead: number; behind: number }>
  checkResults: Map<string, CheckSummary>
  commentsOf: Map<string, ForgeComment[]>
  calls: Array<{ op: string; repo?: string; opts?: unknown }>
  me: string
  pageSize: number
  /** Upsert by number. */
  put(c: Change | ForgeIssue): void
  failNext?: Error
}

const time = (s?: string) => (s ? Date.parse(s) : NaN)

function listed<T extends { updatedAt: string; state: string }>(items: T[], opts: ListOpts = {}): T[] {
  const since = time(opts.since)
  const until = time(opts.until)
  return [...items]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((x) => !(Date.parse(x.updatedAt) < since) && !(Date.parse(x.updatedAt) >= until))
    .filter((x) => opts.state !== 'open' || x.state === 'open' || x.state === 'draft')
}

function paged<T extends { updatedAt: string; state: string }>(
  items: T[],
  size: number,
  opts: PageOpts = {}
): ForgePage<T> {
  const all = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const start = opts.after ? Number(opts.after) : 0
  const slice = all.slice(start, start + size)
  const next = start + size
  const until = time(opts.until)
  return {
    items: slice.filter((x) => !(Date.parse(x.updatedAt) >= until)),
    hasNext: next < all.length,
    ...(next < all.length ? { cursor: String(next) } : {})
  }
}

export function createFakeForge(opts: { paging?: boolean; me?: string } = {}): FakeForge {
  const f: FakeForge = {
    kind: 'github',
    host: HOST,
    capabilities: { reviews: true, checks: true, labels: true, assignees: true, crossRefs: true },
    changes: new Map(),
    issues: new Map(),
    branches: new Map(),
    compares: new Map(),
    checkResults: new Map(),
    commentsOf: new Map(),
    calls: [],
    me: opts.me ?? 'hex-agent',
    pageSize: 2,
    put(item) {
      const isChange = 'head' in item
      const map = (isChange ? f.changes : f.issues) as Map<string, Array<Change | ForgeIssue>>
      const list = map.get(item.ref.repo) ?? []
      const i = list.findIndex((x) => x.ref.id === item.ref.id)
      if (i >= 0) list[i] = item
      else list.push(item)
      map.set(item.ref.repo, list)
    },
    async listChanges(repo, o) {
      f.calls.push({ op: 'listChanges', repo, opts: o })
      if (f.failNext) {
        const e = f.failNext
        f.failNext = undefined
        throw e
      }
      return structuredClone(listed(f.changes.get(repo) ?? [], o))
    },
    async listIssues(repo, o) {
      f.calls.push({ op: 'listIssues', repo, opts: o })
      return structuredClone(listed(f.issues.get(repo) ?? [], o))
    },
    async getChange(r) {
      f.calls.push({ op: 'getChange', repo: r.repo, opts: r.id })
      if (f.failNext) {
        const e = f.failNext
        f.failNext = undefined
        throw e
      }
      const c = (f.changes.get(r.repo) ?? []).find((x) => x.ref.id === r.id)
      return c && structuredClone(c)
    },
    async getIssue(r) {
      f.calls.push({ op: 'getIssue', repo: r.repo, opts: r.id })
      const i = (f.issues.get(r.repo) ?? []).find((x) => x.ref.id === r.id)
      return i && structuredClone(i)
    },
    async listBranches(repo) {
      f.calls.push({ op: 'listBranches', repo })
      return structuredClone(f.branches.get(repo) ?? [])
    },
    async compare(repo, base, head) {
      f.calls.push({ op: 'compare', repo, opts: { base, head } })
      return f.compares.get(`${repo}:${base}...${head}`) ?? { ahead: 1, behind: 0 }
    },
    async checks(r) {
      f.calls.push({ op: 'checks', repo: r.repo, opts: r.id })
      return f.checkResults.get(`${r.repo}#${r.id}`)
    },
    async comments(r) {
      f.calls.push({ op: 'comments', repo: r.repo, opts: r.id })
      return structuredClone(f.commentsOf.get(`${r.repo}#${r.id}`) ?? [])
    },
    async setAssignees(r, add, remove) {
      f.calls.push({ op: 'setAssignees', repo: r.repo, opts: { id: r.id, add, remove } })
      for (const list of [f.changes.get(r.repo) ?? [], f.issues.get(r.repo) ?? []] as Array<
        Array<Change | ForgeIssue>
      >) {
        const item = list.find((x) => x.ref.id === r.id)
        if (item)
          item.assignees = [
            ...item.assignees.filter((a) => !remove.includes(a)),
            ...add.filter((a) => !item.assignees.includes(a))
          ]
      }
    },
    async identity() {
      return f.me
    }
  }
  if (opts.paging !== false) {
    f.pageChanges = async (repo, o) => {
      f.calls.push({ op: 'pageChanges', repo, opts: o })
      return structuredClone(paged(f.changes.get(repo) ?? [], f.pageSize, o))
    }
    f.pageIssues = async (repo, o) => {
      f.calls.push({ op: 'pageIssues', repo, opts: o })
      return structuredClone(paged(f.issues.get(repo) ?? [], f.pageSize, o))
    }
  }
  return f
}
