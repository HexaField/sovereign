// Loop 1 sync for one repo, through its forge adapter (scripts only, no LLM).
//
// - First run: open changes + everything updated in the last `windowDays`.
// - Open refresh (every pollOpenMs): every open change again, because a
//   check result does not move a PR's updatedAt; plus whatever changed
//   since the last refresh, so merges and closes land within one poll.
// - All refresh (every pollAllMs): the same, from the last all refresh, plus
//   the branch list.
// - Backfill: older history one page at a time, resumable from a persisted
//   cursor; items it reads raise no events.
// Branch compare runs only for open changes, cached by head + base sha.
// Retries and rate-limit waits come from the adapter.

import { parseRefKey, refKey, type Change, type Forge, type ForgeIssue, type ForgeRef } from '@sovereign/core'
import { parsePaired } from './build.js'
import { admitsEvent } from './trust.js'
import type { RepoCacheStore } from './cache.js'
import { diffChange, diffIssue } from './diff.js'
import type { CachedChange, CachedIssue, ForgeEvent, RepoCache } from './types.js'

export interface RepoSyncDeps {
  forge: Forge
  store: RepoCacheStore
  windowDays: number
  /** Open changes untouched this long raise one `stale` event. */
  staleDays?: number
  /** Node ids whose comments are read each refresh (owned items). */
  watched?: () => Set<string>
  /**
   * forge.trustedAuthors, asked once per job: whether `login` may put an item
   * (or a comment or review on item `nodeId`) into the Forge. An item it
   * refuses is never stored (and leaves the cache), and refused actors' text
   * never reaches an event. Unset: everyone passes.
   */
  trust?: () => (login: string, nodeId: string) => boolean
  now?: () => number
  log?: (msg: string) => void
}

export interface SyncResult {
  events: ForgeEvent[]
  changed: boolean
}

export interface RepoSync {
  readonly key: string
  readonly repo: string
  cache(): RepoCache
  /** Open refresh; the first call runs the window sync. */
  syncOpen(): Promise<SyncResult>
  syncAll(): Promise<SyncResult>
  /**
   * Read these items one by one (tasks on a repo their membrane does not
   * sync). An item's first read sets its baseline and raises no events.
   */
  refreshItems(refs: ForgeRef[]): Promise<SyncResult>
  /** One backfill page. */
  backfillStep(): Promise<{ done: boolean; items: number }>
  backfillDone(): boolean
  /** Persist the cache after an outside edit (an assignee Forge wrote). */
  save(): void
  /** The author of an item `trusted` refused since this process started (by node id). */
  refused(nodeId: string): string | undefined
}

const OVERLAP_MS = 60_000
const isOpen = (c: Change) => c.state === 'open' || c.state === 'draft'

export function createRepoSync(
  target: { forge: RepoCache['forge']; host: string; repo: string },
  deps: RepoSyncDeps
): RepoSync {
  const now = deps.now ?? Date.now
  const staleMs = (deps.staleDays ?? 14) * 86_400_000
  const cache = deps.store.load(target.forge, target.host, target.repo)
  let chain: Promise<unknown> = Promise.resolve()
  const iso = (t: number) => new Date(t).toISOString()
  let trusted: (login: string, nodeId: string) => boolean = () => true
  const refused = new Map<string, string>()

  /** Drop an item `trusted` refuses: out of the cache, remembered by node id. True when it was cached. */
  function refuse(kind: 'changes' | 'issues', item: Change | ForgeIssue | CachedChange | CachedIssue): boolean {
    const id = refKey(item.ref)
    refused.set(id, item.author)
    const was = Boolean(cache[kind][item.ref.id])
    delete cache[kind][item.ref.id]
    cache.stale = cache.stale.filter((s) => s !== id)
    return was
  }

  /** Items cached before the allow list (or before a login left it) leave the cache. */
  function prune(): boolean {
    let changed = false
    for (const c of Object.values(cache.changes))
      if (!trusted(c.author, refKey(c.ref))) changed = refuse('changes', c) || changed
    for (const i of Object.values(cache.issues))
      if (!trusted(i.author, refKey(i.ref))) changed = refuse('issues', i) || changed
    return changed
  }

  /** Events whose item, commenters, reviewer or referencing item `trusted` refuses are dropped. */
  function admitted(events: ForgeEvent[]): ForgeEvent[] {
    const authorOf = (id: string) => {
      const ref = parseRefKey(id, 'change')
      return (ref && (cache.changes[ref.id]?.author ?? cache.issues[ref.id]?.author)) ?? refused.get(id)
    }
    return events.filter((e) => admitsEvent(e, (login) => trusted(login, e.nodeId), authorOf))
  }

  /** A sync job under the allow list: stale entries pruned first (every job saves the cache), its events admitted. */
  async function trustedJob(job: () => Promise<SyncResult>): Promise<SyncResult> {
    trusted = deps.trust?.() ?? (() => true)
    const pruned = prune()
    const r = await job()
    const events = admitted(r.events)
    return { events, changed: r.changed || pruned }
  }

  /** Run one job at a time per repo. */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(job, job)
    chain = run.catch(() => undefined)
    return run
  }

  function ingestChange(c: Change): CachedChange {
    const prev = cache.changes[c.ref.id]
    const { body, ...rest } = c
    const next: CachedChange = { ...rest, body: '', paired: parsePaired(body, c.ref.host) }
    if (prev?.compare) next.compare = prev.compare
    if (prev?.commentCount !== undefined) next.commentCount = prev.commentCount
    if (prev?.failedFor && prev.failedFor === c.head.sha && c.checks?.state === 'failing' && !c.checks.failed) {
      next.checks = { ...c.checks, failed: prev.checks?.failed ?? [] }
      next.failedFor = prev.failedFor
    }
    return next
  }

  function ingestIssue(i: ForgeIssue): CachedIssue {
    const prev = cache.issues[i.ref.id]
    return { ...i, body: '', ...(prev?.commentCount !== undefined ? { commentCount: prev.commentCount } : {}) }
  }

  /** Merge fresh reads into the cache; events unless `quiet`. */
  function merge(changes: Change[], issues: ForgeIssue[], quiet: boolean, events: ForgeEvent[]): boolean {
    let changed = false
    const at = iso(now())
    const seenC = new Set<string>()
    for (const c of changes) {
      if (seenC.has(c.ref.id)) continue
      seenC.add(c.ref.id)
      if (!trusted(c.author, refKey(c.ref))) {
        changed = refuse('changes', c) || changed
        continue
      }
      refused.delete(refKey(c.ref))
      const prev = cache.changes[c.ref.id]
      if (quiet && prev && prev.updatedAt >= c.updatedAt) continue
      const next = ingestChange(c)
      if (!quiet) {
        for (const e of diffChange(prev, next)) events.push({ at, nodeId: refKey(c.ref), ...e })
        if (prev && prev.state !== 'merged' && next.state === 'merged' && next.head.branch) {
          // Changes stacked on this one now sit on a merged base.
          for (const o of Object.values(cache.changes)) {
            if (o.ref.id !== next.ref.id && isOpen(o) && o.base.branch === next.head.branch) {
              events.push({
                at,
                nodeId: refKey(o.ref),
                type: 'base_merged',
                detail: { base: next.head.branch, merged: refKey(next.ref) }
              })
            }
          }
        }
      }
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed = true
      cache.changes[c.ref.id] = next
    }
    const seenI = new Set<string>()
    for (const i of issues) {
      if (seenI.has(i.ref.id)) continue
      seenI.add(i.ref.id)
      if (!trusted(i.author, refKey(i.ref))) {
        changed = refuse('issues', i) || changed
        continue
      }
      refused.delete(refKey(i.ref))
      const prev = cache.issues[i.ref.id]
      if (quiet && prev && prev.updatedAt >= i.updatedAt) continue
      const next = ingestIssue(i)
      if (!quiet) for (const e of diffIssue(prev, next)) events.push({ at, nodeId: refKey(i.ref), ...e })
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed = true
      cache.issues[i.ref.id] = next
    }
    return changed
  }

  /** Failed check names for failing open changes (once per head sha). */
  async function readFailedChecks(events: ForgeEvent[]): Promise<boolean> {
    let changed = false
    for (const c of Object.values(cache.changes)) {
      if (!isOpen(c) || c.checks?.state !== 'failing' || c.failedFor === c.head.sha) continue
      try {
        const s = await deps.forge.checks(c.ref)
        c.failedFor = c.head.sha
        c.checks = { state: 'failing', failed: s?.failed ?? [] }
        changed = true
        // The ci_failed event (raised before the names were known) gets them.
        const ev = events.find((e) => e.type === 'ci_failed' && e.nodeId === refKey(c.ref))
        if (ev) ev.detail = { ...ev.detail, failed: c.checks.failed }
      } catch (err) {
        deps.log?.(`checks ${target.repo}#${c.ref.id}: ${(err as Error).message}`)
      }
    }
    return changed
  }

  /** Ahead/behind against the base, for open changes whose head or base moved. */
  async function compareOpen(events: ForgeEvent[], quiet: boolean): Promise<boolean> {
    let changed = false
    const at = iso(now())
    for (const c of Object.values(cache.changes)) {
      if (!isOpen(c) || !c.head.branch || !c.base.branch || c.extra?.headRepo) continue
      const key = `${c.head.sha}:${cache.branches[c.base.branch] ?? ''}`
      if (c.compare?.key === key) continue
      try {
        const r = await deps.forge.compare(target.repo, c.base.branch, c.head.branch)
        const prevBehind = c.compare?.behind ?? 0
        c.compare = { ahead: r.ahead, behind: r.behind, key }
        changed = true
        if (!quiet && r.behind > prevBehind) {
          events.push({
            at,
            nodeId: refKey(c.ref),
            type: 'behind_base',
            detail: { base: c.base.branch, behind: r.behind }
          })
        }
      } catch (err) {
        deps.log?.(`compare ${target.repo} ${c.base.branch}...${c.head.branch}: ${(err as Error).message}`)
      }
    }
    return changed
  }

  /** Comment counts of watched (owned) items; a rise is a `commented` event. */
  async function readComments(events: ForgeEvent[]): Promise<boolean> {
    const watched = deps.watched?.()
    if (!watched?.size) return false
    let changed = false
    const at = iso(now())
    const items: Array<CachedChange | CachedIssue> = [
      ...Object.values(cache.changes).filter(isOpen),
      ...Object.values(cache.issues).filter((i) => i.state === 'open')
    ]
    for (const item of items) {
      const id = refKey(item.ref)
      if (!watched.has(id)) continue
      try {
        const comments = await deps.forge.comments(item.ref)
        const prev = item.commentCount
        if (prev !== comments.length) changed = true
        item.commentCount = comments.length
        // Comments by logins the allow list refuses count, but their text never enters an event
        const fresh =
          prev !== undefined && comments.length > prev ? comments.slice(prev).filter((c) => trusted(c.author, id)) : []
        if (fresh.length) {
          events.push({
            at,
            nodeId: id,
            type: 'commented',
            detail: {
              count: fresh.length,
              authors: [...new Set(fresh.map((c) => c.author))],
              text: fresh.map((c) => c.body.slice(0, 500))
            }
          })
        }
      } catch (err) {
        deps.log?.(`comments ${target.repo}#${item.ref.id}: ${(err as Error).message}`)
      }
    }
    return changed
  }

  function markStale(events: ForgeEvent[], quiet: boolean): boolean {
    let changed = false
    const t = now()
    const stale = new Set(cache.stale)
    for (const c of Object.values(cache.changes)) {
      const id = refKey(c.ref)
      const old = isOpen(c) && t - Date.parse(c.updatedAt) > staleMs
      if (old && !stale.has(id)) {
        stale.add(id)
        changed = true
        if (!quiet) events.push({ at: iso(t), nodeId: id, type: 'stale', detail: { updatedAt: c.updatedAt } })
      } else if (!old && stale.has(id)) {
        stale.delete(id)
        changed = true
      }
    }
    cache.stale = [...stale]
    return changed
  }

  async function syncBranches(): Promise<boolean> {
    const list = await deps.forge.listBranches(target.repo)
    const next: Record<string, string> = {}
    for (const b of list) next[b.name] = b.sha
    const changed = JSON.stringify(next) !== JSON.stringify(cache.branches)
    cache.branches = next
    cache.branchesSyncedAt = iso(now())
    return changed
  }

  async function windowSync(): Promise<SyncResult> {
    const started = now()
    const since = iso(started - deps.windowDays * 86_400_000)
    const [recent, open, issues, openIssues] = await Promise.all([
      deps.forge.listChanges(target.repo, { since }),
      deps.forge.listChanges(target.repo, { state: 'open' }),
      deps.forge.listIssues(target.repo, { since }),
      deps.forge.listIssues(target.repo, { state: 'open' })
    ])
    const events: ForgeEvent[] = []
    merge([...open, ...recent], [...openIssues, ...issues], false, [])
    try {
      await syncBranches()
    } catch (err) {
      deps.log?.(`branches ${target.repo}: ${(err as Error).message}`)
    }
    await readFailedChecks(events)
    await compareOpen(events, true)
    markStale(events, true)
    cache.windowSyncedAt = iso(now())
    cache.backfillUntil ??= since
    cache.lastOpenSyncAt = iso(started)
    cache.lastAllSyncAt = iso(started)
    deps.store.save(cache)
    return { events: [], changed: true }
  }

  async function refresh(mode: 'open' | 'all'): Promise<SyncResult> {
    if (!cache.windowSyncedAt) return windowSync()
    const started = now()
    const last = mode === 'open' ? cache.lastOpenSyncAt : cache.lastAllSyncAt
    const since = iso(Date.parse(last ?? cache.windowSyncedAt) - OVERLAP_MS)
    const [open, changes, issues] = await Promise.all([
      // Every open change, each time: CI results do not move updatedAt.
      deps.forge.listChanges(target.repo, { state: 'open' }),
      deps.forge.listChanges(target.repo, { since }),
      deps.forge.listIssues(target.repo, { since })
    ])
    const events: ForgeEvent[] = []
    let changed = merge([...changes, ...open], issues, false, events)
    if (mode === 'all') {
      try {
        if (await syncBranches()) changed = true
      } catch (err) {
        deps.log?.(`branches ${target.repo}: ${(err as Error).message}`)
      }
    }
    if (await readFailedChecks(events)) changed = true
    if (await compareOpen(events, false)) changed = true
    if (await readComments(events)) changed = true
    if (markStale(events, false)) changed = true
    // Two events for one cause (a compare and a diff both seeing behind): keep one.
    const unique = dedupe(events)
    // An all refresh covers everything an open one does.
    cache.lastOpenSyncAt = iso(started)
    if (mode === 'all') cache.lastAllSyncAt = iso(started)
    deps.store.save(cache)
    return { events: unique, changed: changed || unique.length > 0 }
  }

  async function refreshItems(refs: ForgeRef[]): Promise<SyncResult> {
    const changes: { known: Change[]; fresh: Change[] } = { known: [], fresh: [] }
    const issues: { known: ForgeIssue[]; fresh: ForgeIssue[] } = { known: [], fresh: [] }
    for (const r of refs) {
      try {
        if (r.kind === 'change') {
          const c = await deps.forge.getChange?.(r)
          if (c) changes[cache.changes[c.ref.id] ? 'known' : 'fresh'].push(c)
        } else if (r.kind === 'issue') {
          const i = await deps.forge.getIssue?.(r)
          if (i) issues[cache.issues[i.ref.id] ? 'known' : 'fresh'].push(i)
        }
      } catch (err) {
        deps.log?.(`read ${target.repo}#${r.id}: ${(err as Error).message}`)
      }
    }
    const events: ForgeEvent[] = []
    let changed = merge(changes.fresh, issues.fresh, true, [])
    if (merge(changes.known, issues.known, false, events)) changed = true
    if (await readFailedChecks(events)) changed = true
    if (await readComments(events)) changed = true
    cache.lastOpenSyncAt = iso(now())
    deps.store.save(cache)
    const unique = dedupe(events)
    return { events: unique, changed: changed || unique.length > 0 }
  }

  async function backfillStep(): Promise<{ done: boolean; items: number }> {
    if (!cache.windowSyncedAt) await windowSync()
    const until = cache.backfillUntil ?? cache.windowSyncedAt
    const bf = cache.backfill
    let items = 0
    if (!bf.changes.done) {
      if (deps.forge.pageChanges) {
        const page = await deps.forge.pageChanges(target.repo, { after: bf.changes.cursor, until })
        merge(page.items, [], true, [])
        items = page.items.length
        bf.changes = {
          cursor: page.cursor,
          done: !page.hasNext || !page.cursor,
          pages: bf.changes.pages + 1,
          items: bf.changes.items + items
        }
      } else {
        const all = await deps.forge.listChanges(target.repo, { until })
        merge(all, [], true, [])
        items = all.length
        bf.changes = { done: true, pages: bf.changes.pages + 1, items: bf.changes.items + items }
      }
    } else if (!bf.issues.done) {
      if (deps.forge.pageIssues) {
        const page = await deps.forge.pageIssues(target.repo, { after: bf.issues.cursor, until })
        merge([], page.items, true, [])
        items = page.items.length
        bf.issues = {
          cursor: page.cursor,
          done: !page.hasNext || !page.cursor,
          pages: bf.issues.pages + 1,
          items: bf.issues.items + items
        }
      } else {
        const all = await deps.forge.listIssues(target.repo, { until })
        merge([], all, true, [])
        items = all.length
        bf.issues = { done: true, pages: bf.issues.pages + 1, items: bf.issues.items + items }
      }
    }
    markStale([], true)
    deps.store.save(cache)
    return { done: bf.changes.done && bf.issues.done, items }
  }

  return {
    key: `${target.forge}:${target.host}/${target.repo}`,
    repo: target.repo,
    cache: () => cache,
    syncOpen: () => serial(() => trustedJob(() => refresh('open'))),
    syncAll: () => serial(() => trustedJob(() => refresh('all'))),
    refreshItems: (refs) => serial(() => trustedJob(() => refreshItems(refs))),
    backfillStep: () =>
      serial(() => {
        trusted = deps.trust?.() ?? (() => true)
        prune()
        return backfillStep()
      }),
    refused: (nodeId) => refused.get(nodeId),
    backfillDone: () => cache.backfill.changes.done && cache.backfill.issues.done,
    save: () => deps.store.save(cache)
  }
}

function dedupe(events: ForgeEvent[]): ForgeEvent[] {
  const seen = new Set<string>()
  return events.filter((e) => {
    const k = `${e.nodeId}\u0000${e.type}\u0000${e.type === 'behind_base' ? '' : JSON.stringify(e.detail)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
