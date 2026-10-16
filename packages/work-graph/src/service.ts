// Forge service — one per server. Per membrane: scope, sync loops, plans
// (each a work stream), graph, event log + triage, task sync + notifier,
// assignee sync, overlay + auto-link. Across membranes: tracked items — PR
// and issue tasks whose repo their membrane does not sync (or that have no
// membrane) are read one by one, so their owner threads still hear about CI,
// reviews and merges. That poll runs with `forge.enabled` off too.

import path from 'node:path'
import {
  defaultWorkPrompt,
  parseRefKey,
  type EventBus,
  type Forge,
  type ForgeGraph,
  type ForgeRef,
  type ForgeView,
  type RethinkNote,
  type WorkEdgeKind,
  type WorkNode,
  type WorkStream
} from '@sovereign/core'
import { repoKey, type ForgeRegistry, type ForgeRepo } from '@sovereign/forges'
import type { HostForges } from '@sovereign/orgs'
import { applyView, buildGraph, planRefKey, searchGraph, windowGraph, type BuiltGraph } from './build.js'
import { createRepoCacheStore, readJson, writeJsonAtomic } from './cache.js'
import { buildDigest, createEventLog, safeSegment, triage, type EventLog } from './events.js'
import { buildOverlay, currentBranch, resolveCheckouts, type OverlayResult } from './overlay.js'
import { isPlanPath, scanPlans, type Plan } from './plans.js'
import { resolveScope, type MembraneScope, type ScopeSource } from './scope.js'
import { createRepoSync, type RepoSync } from './sync.js'
import { syncTasks, TERMINAL } from './task-sync.js'
import {
  DEFAULT_FORGE_CONFIG,
  type ActiveCiWatch,
  type ActiveSubagent,
  type CachedChange,
  type CachedIssue,
  type ForgeClassifier,
  type ForgeConfig,
  type ForgeDigest,
  type ForgeEvent,
  type PortTask,
  type RelatedEdgeRecord,
  type RepoCache,
  type RethinkTrigger,
  type TaskInit,
  type TaskPort,
  type ThreadPresence,
  type TriagedEvent
} from './types.js'

/** sourceThreadId of the task writes the work graph makes (the TaskPort's); its own events are not reacted to. */
export const FORGE_SOURCE = 'forge'

export class ForgeError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ForgeServiceDeps {
  dataDir: string
  config: () => Partial<ForgeConfig> | undefined
  scope: ScopeSource
  forgeRegistry: Pick<ForgeRegistry, 'forgeFor'>
  tasks: TaskPort
  bus: EventBus
  threads: {
    createThread(membrane: string, label: string): Promise<string>
    /** A prompt from the user (assign). */
    sendToThread(threadId: string, text: string): Promise<void>
    /** A status notification (CI red, review, merge); default: sendToThread. */
    notify?(threadId: string, text: string): Promise<void>
    presence(threadId: string): ThreadPresence | undefined
  }
  subagents?: { list(): Promise<ActiveSubagent[]> }
  ciWatch?: { list(): ActiveCiWatch[] }
  classifier?: ForgeClassifier
  /** Loop 2. Gets the digest; the run is skipped when it is empty. */
  runRethink?: (
    membrane: string,
    digest: ForgeDigest,
    opts: { trigger: RethinkTrigger }
  ) => Promise<{ runId?: string } | void>
  /** Rethink notes per node id, shown on the cards (graph response). */
  rethinkNotes?: (membrane: string) => Record<string, RethinkNote[]>
  hosts?: HostForges
  branchOf?: (cwd: string) => Promise<string | undefined>
  now?: () => number
  log?: (msg: string) => void
  /** Delay between backfill pages (low priority). Default 3 s. */
  backfillDelayMs?: number
  /** Overlay recompute interval. Default 10 s. */
  overlayPollMs?: number
}

export interface AssignInput {
  membrane?: string
  nodeId: string
  /** null unassigns. */
  threadId?: string | null
  newThread?: { label?: string }
  prompt?: string
}

export interface RepoStatus {
  repo: string
  changes: number
  issues: number
  windowSyncedAt?: string
  lastOpenSyncAt?: string
  lastAllSyncAt?: string
  backfill: RepoCache['backfill']
  error?: string
}

export interface ForgeStatus {
  membrane: string
  enabled: boolean
  syncing: boolean
  lastSyncAt?: string
  lastError?: string
  identity?: string
  repos: RepoStatus[]
  plans: number
  backfill: { done: boolean; pages: number; items: number }
  triage: ReturnType<EventLog['coverage']>
  events: number
}

export interface ForgeService {
  start(): void
  stop(): void
  config(): ForgeConfig
  membranes(): string[]
  graph(membrane: string, opts?: { view?: string; since?: string; until?: string }): Promise<ForgeGraph>
  search(membrane: string, q: string): Promise<{ nodes: WorkNode[]; edges: BuiltGraph['edges'] }>
  overlay(membrane: string): Promise<OverlayResult>
  sync(membrane: string, mode?: 'open' | 'all'): Promise<{ events: number; changed: boolean }>
  backfillStep(membrane: string): Promise<boolean>
  rethink(
    membrane: string,
    opts?: { trigger?: RethinkTrigger }
  ): Promise<{ ran: boolean; count: number; runId?: string }>
  /** A node of the membrane's full history (not only the window). */
  node(membrane: string, nodeId: string): Promise<WorkNode | undefined>
  /** A suggested `related` edge between two nodes of the membrane (shown dashed until accepted). */
  relate(
    membrane: string,
    edge: { from: string; to: string; reason: string; confidence: number; source: 'rethink' }
  ): Promise<RelatedEdgeRecord>
  digest(membrane: string, since?: string): Promise<ForgeDigest>
  events(membrane: string, opts?: { since?: string }): TriagedEvent[]
  assign(input: AssignInput): Promise<{ taskId: string; threadId: string | null; forgeError?: string }>
  /** Re-read a task's forge item now: its membrane's sync when that covers it, else the item alone. */
  pollTask(taskId: string): Promise<void>
  /** Read every tracked item (PR/issue tasks no membrane sync covers) now. */
  pollTracked(): Promise<{ items: number; events: number }>
  getViews(membrane: string): Promise<ForgeView[]>
  putViews(membrane: string, views: ForgeView[]): Promise<ForgeView[]>
  createStream(membrane: string, name: string, parentId?: string): Promise<WorkStream>
  addMember(streamId: string, nodeId: string, membrane?: string): Promise<{ taskId: string }>
  removeMember(streamId: string, nodeId: string, membrane?: string): Promise<boolean>
  acceptEdge(from: string, to: string, kind: WorkEdgeKind, membrane?: string): Promise<boolean>
  deleteEdge(from: string, to: string, kind: WorkEdgeKind, membrane?: string): Promise<boolean>
  status(membrane: string): Promise<ForgeStatus>
}

interface MembraneState {
  scope?: MembraneScope
  plans: Plan[]
  plansScanned: boolean
  log: EventLog
  syncing: boolean
  lastSyncAt?: string
  lastOpenAt: number
  lastAllAt: number
  lastError?: string
  repoErrors: Map<string, string>
  overlayJson?: string
}

interface MembraneFile {
  rethinkCursor?: string
  /** nodeId → the login Forge added as assignee (only those may be removed). */
  assignedByForge: Record<string, string>
  /**
   * Plan id → the node ids the plan named at the last scan, and those whose
   * stream membership the plan itself added (only those follow the plan).
   */
  planLinks?: Record<string, { named: string[]; linked: string[] }>
}

export function resolveConfig(c: Partial<ForgeConfig> | undefined): ForgeConfig {
  const d = DEFAULT_FORGE_CONFIG
  return {
    ...d,
    ...c,
    identities: { ...d.identities, ...c?.identities },
    rethink: { ...d.rethink, ...c?.rethink },
    repos: { ...d.repos, ...c?.repos },
    planDirs: c?.planDirs ?? d.planDirs,
    mentions: c?.mentions ?? d.mentions
  }
}

export function createForgeService(deps: ForgeServiceDeps): ForgeService {
  const now = deps.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const log = deps.log ?? ((m: string) => console.log(`[forge] ${m}`))
  const store = createRepoCacheStore(deps.dataDir)
  const syncs = new Map<string, RepoSync>()
  // Tracked items keep their own caches: a membrane that syncs the same repo
  // must still see every change as an event of its own.
  const trackedStore = createRepoCacheStore(deps.dataDir, 'tracked')
  const trackedSyncs = new Map<string, RepoSync>()
  let lastTrackedAt = 0
  const states = new Map<string, MembraneState>()
  const identities = new Map<string, Promise<string | undefined>>()
  const timers: Array<ReturnType<typeof setInterval>> = []
  const disposers: Array<() => void> = []
  let backfillTimer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let watchedIds = new Set<string>()

  const cfg = () => resolveConfig(deps.config())

  function state(membrane: string): MembraneState {
    let s = states.get(membrane)
    if (!s) {
      s = {
        plans: [],
        plansScanned: false,
        log: createEventLog(deps.dataDir, membrane),
        syncing: false,
        lastOpenAt: 0,
        lastAllAt: 0,
        repoErrors: new Map()
      }
      states.set(membrane, s)
    }
    return s
  }

  const fileOf = (membrane: string) => path.join(deps.dataDir, 'forge', safeSegment(membrane), 'state.json')
  const readFile = (membrane: string): MembraneFile => ({
    assignedByForge: {},
    ...readJson<MembraneFile>(fileOf(membrane))
  })
  /** Read, change and write state.json in one synchronous step, so no await in between writes back a stale copy. */
  const updateFile = (membrane: string, change: (f: MembraneFile) => void) => {
    const f = readFile(membrane)
    change(f)
    writeJsonAtomic(fileOf(membrane), f)
  }

  function scopeOf(membrane: string): MembraneScope {
    if (!deps.scope.getMembrane(membrane)) throw new ForgeError(`unknown membrane: ${membrane}`, 404)
    const c = cfg()
    const s = resolveScope(deps.scope, membrane, { planDirs: c.planDirs, repos: c.repos, hosts: deps.hosts })!
    state(membrane).scope = s
    return s
  }

  function forgeOf(r: Pick<ForgeRepo, 'forge' | 'host'>): Forge | undefined {
    return deps.forgeRegistry.forgeFor({ forge: r.forge, host: r.host })
  }

  function repoSync(r: Pick<ForgeRef, 'forge' | 'host' | 'repo'>, tracked = false): RepoSync | undefined {
    const map = tracked ? trackedSyncs : syncs
    const k = repoKey(r)
    let s = map.get(k)
    if (s) return s
    const forge = forgeOf(r)
    if (!forge) return undefined
    s = createRepoSync(
      { forge: r.forge, host: r.host, repo: r.repo },
      {
        forge,
        store: tracked ? trackedStore : store,
        windowDays: cfg().windowDays,
        watched: () => watchedIds,
        now,
        log
      }
    )
    map.set(k, s)
    return s
  }
  const syncOf = (r: ForgeRepo) => repoSync(r)

  const sameRepo = (a: Pick<ForgeRef, 'forge' | 'host' | 'repo'>, b: Pick<ForgeRef, 'forge' | 'host' | 'repo'>) =>
    a.forge === b.forge && a.host === b.host && a.repo.toLowerCase() === b.repo.toLowerCase()

  /** The forge ref of a PR or issue task. */
  function refOfTask(t: PortTask): ForgeRef | undefined {
    if (!t.key || (t.kind !== 'change' && t.kind !== 'issue')) return undefined
    return parseRefKey(t.key, t.kind)
  }

  /** A task whose item its membrane's own sync reads (forge on, membrane synced, repo in scope). */
  function coveredBySync(t: PortTask, ref: ForgeRef, synced: Set<string>): boolean {
    if (!t.membrane || !synced.has(t.membrane)) return false
    return (state(t.membrane).scope ?? scopeOf(t.membrane)).repos.some((r) => sameRepo(r, ref))
  }

  /** Tracked items of a membrane's tasks, as caches holding just those items. */
  function trackedCaches(scope: MembraneScope, tasks: PortTask[]): RepoCache[] {
    const byRepo = new Map<string, RepoCache>()
    for (const t of tasks) {
      const ref = refOfTask(t)
      if (!ref || scope.repos.some((r) => sameRepo(r, ref))) continue
      const c = trackedSyncs.get(repoKey(ref))?.cache()
      const item = c && (ref.kind === 'change' ? c.changes[ref.id] : c.issues[ref.id])
      if (!c || !item) continue
      const k = repoKey(ref)
      let out = byRepo.get(k)
      if (!out) {
        out = { ...c, changes: {}, issues: {} }
        byRepo.set(k, out)
      }
      if (ref.kind === 'change') out.changes[ref.id] = item as CachedChange
      else out.issues[ref.id] = item as CachedIssue
    }
    return [...byRepo.values()]
  }

  function caches(scope: MembraneScope) {
    return scope.repos.map((r) => syncOf(r)?.cache()).filter((c): c is NonNullable<typeof c> => Boolean(c))
  }

  function itemOf(
    scope: MembraneScope,
    nodeId: string
  ): { sync: RepoSync; item: CachedChange | CachedIssue; ref: ForgeRef } | undefined {
    const ref = parseRefKey(nodeId, 'change')
    if (!ref) return undefined
    const r = scope.repos.find((x) => sameRepo(x, ref))
    const sync = r ? syncOf(r) : trackedSyncs.get(repoKey(ref))
    if (!sync) return undefined
    const c = sync.cache()
    const change = c.changes[ref.id]
    if (change) return { sync, item: change, ref: change.ref }
    const issue = c.issues[ref.id]
    if (issue) return { sync, item: issue, ref: issue.ref }
    return undefined
  }

  async function identityFor(r: Pick<ForgeRepo, 'forge' | 'host'>): Promise<string | undefined> {
    const configured = cfg().identities.github
    if (r.forge === 'github' && configured) return configured
    const k = `${r.forge}:${r.host}`
    let p = identities.get(k)
    if (!p) {
      const forge = forgeOf(r)
      p = forge ? forge.identity().catch(() => undefined) : Promise.resolve(undefined)
      identities.set(k, p)
      void p.then((v) => {
        if (!v) identities.delete(k)
      })
    }
    return p
  }

  /** The membrane's forge login (its first repo's forge). */
  const identityOf = (scope: MembraneScope) =>
    scope.repos[0] ? identityFor(scope.repos[0]) : Promise.resolve(cfg().identities.github)

  async function full(
    membrane: string,
    scope = state(membrane).scope ?? scopeOf(membrane)
  ): Promise<{ graph: BuiltGraph; tasks: PortTask[] }> {
    const s = state(membrane)
    if (!s.plansScanned) rescanPlans(membrane, scope)
    const [tasks, related] = await Promise.all([deps.tasks.listByMembrane(membrane), deps.tasks.listRelated(membrane)])
    const repos = [...caches(scope), ...trackedCaches(scope, tasks)]
    return { graph: buildGraph({ repos, plans: s.plans, tasks, related }), tasks }
  }

  /** Rescan plans; plan_changed events for files whose text changed (after the first scan). */
  function rescanPlans(membrane: string, scope: MembraneScope): ForgeEvent[] {
    const s = state(membrane)
    const prev = new Map(s.plans.map((p) => [p.id, p.hash]))
    const plans = scanPlans(
      scope.planDirs,
      scope.repos.map((r) => r.repo)
    )
    const events: ForgeEvent[] = []
    if (s.plansScanned) {
      for (const p of plans) {
        const h = prev.get(p.id)
        if (h === undefined)
          events.push({ at: iso(), nodeId: p.id, type: 'plan_changed', detail: { added: true, file: p.file } })
        else if (h !== p.hash)
          events.push({ at: iso(), nodeId: p.id, type: 'plan_changed', detail: { file: p.file, status: p.status } })
      }
    }
    s.plans = plans
    s.plansScanned = true
    return events
  }

  async function refreshWatched() {
    const ids = new Set<string>()
    for (const t of await deps.tasks.listForgeItems()) if (t.key && t.threadId) ids.add(t.key)
    watchedIds = ids
  }

  async function triageAll(
    events: ForgeEvent[],
    graph: BuiltGraph,
    tasks: PortTask[],
    identity: string | undefined
  ): Promise<TriagedEvent[]> {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    const byKey = new Map(tasks.filter((t) => t.key).map((t) => [t.key!, t]))
    const out: TriagedEvent[] = []
    for (const e of events) {
      const node = nodes.get(e.nodeId)
      out.push(
        await triage(
          e,
          {
            ...(node ? { node } : {}),
            owned: Boolean(byKey.get(e.nodeId)?.threadId),
            tracked: (id) => byKey.has(id),
            ...(identity ? { identity } : {}),
            mentions: cfg().mentions
          },
          deps.classifier
        )
      )
    }
    return out
  }

  async function digest(membrane: string, since?: string): Promise<ForgeDigest> {
    const { graph } = await full(membrane)
    const from = since ?? readFile(membrane).rethinkCursor
    return buildDigest(
      membrane,
      state(membrane).log.read({ verdict: 'needs-agent', ...(from ? { since: from } : {}) }),
      new Map(graph.nodes.map((n) => [n.id, n])),
      await deps.tasks.streamsOf(membrane),
      from
    )
  }

  function emit(type: string, payload: unknown) {
    deps.bus.emit({ type, timestamp: iso(), source: 'forge', payload })
  }

  /** One sync per membrane at a time; a request during one runs after it. */
  const syncChains = new Map<string, Promise<unknown>>()
  function sync(membrane: string, mode: 'open' | 'all' = 'open'): Promise<{ events: number; changed: boolean }> {
    scopeOf(membrane)
    const prev = syncChains.get(membrane) ?? Promise.resolve()
    const run = prev.then(
      () => syncOnce(membrane, mode),
      () => syncOnce(membrane, mode)
    )
    syncChains.set(
      membrane,
      run.catch(() => undefined)
    )
    return run
  }

  /**
   * Membranes that sync the same repo share its RepoSync, so only the one
   * that read a change sees it as an event; the others get it on their next sync.
   */
  const sharedEvents = new Map<string, ForgeEvent[]>()
  function shareEvents(from: string, r: ForgeRepo, events: ForgeEvent[]) {
    for (const m of membranes()) {
      if (m === from || !(state(m).scope ?? scopeOf(m)).repos.some((x) => sameRepo(x, r))) continue
      sharedEvents.set(m, [...(sharedEvents.get(m) ?? []), ...events])
    }
  }

  async function syncOnce(membrane: string, mode: 'open' | 'all') {
    const s = state(membrane)
    const scope = scopeOf(membrane)
    s.syncing = true
    try {
      await refreshWatched().catch(() => undefined)
      const events: ForgeEvent[] = sharedEvents.get(membrane) ?? []
      sharedEvents.delete(membrane)
      let changed = false
      for (const r of scope.repos) {
        const rs = syncOf(r)
        if (!rs) {
          s.repoErrors.set(r.repo, `no adapter for ${r.forge}:${r.host}`)
          continue
        }
        try {
          const res = mode === 'all' ? await rs.syncAll() : await rs.syncOpen()
          events.push(...res.events)
          if (res.events.length) shareEvents(membrane, r, res.events)
          changed ||= res.changed
          s.repoErrors.delete(r.repo)
        } catch (err) {
          s.repoErrors.set(r.repo, (err as Error).message)
          log(`sync ${membrane} ${r.repo}: ${(err as Error).message}`)
        }
      }
      const planEvents = rescanPlans(membrane, scope)
      events.push(...planEvents)
      changed ||= planEvents.length > 0

      let { graph, tasks } = await full(membrane, scope)
      // Plans first: a plan's stream and the tasks it adds get their state in this same sync.
      if (await syncPlanStreams(membrane, graph)) {
        changed = true
        ;({ graph, tasks } = await full(membrane, scope))
      }
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]))

      // Forge-added assignees removed on the forge: forget the marker.
      const gone = (nodeId: string, login: string) => {
        const item = itemOf(scope, nodeId)?.item
        return item && !item.assignees.some((a) => a.toLowerCase() === login.toLowerCase())
      }
      if (Object.entries(readFile(membrane).assignedByForge).some(([id, login]) => gone(id, login))) {
        updateFile(membrane, (f) => {
          for (const [id, login] of Object.entries(f.assignedByForge)) if (gone(id, login)) delete f.assignedByForge[id]
        })
      }

      s.log.append(await triageAll(events, graph, tasks, await identityOf(scope)))

      const ts = await syncTasks(deps.tasks, {
        tasks,
        nodes,
        edges: graph.edges,
        events,
        item: (id) => itemOf(scope, id)?.item,
        now: iso()
      })
      await notifyAll(ts.notifications)
      s.lastSyncAt = iso()
      s.lastError = s.repoErrors.size ? [...s.repoErrors].map(([r, m]) => `${r}: ${m}`).join('; ') : undefined
      if (mode === 'all') s.lastAllAt = now()
      s.lastOpenAt = now()
      if (changed || events.length || ts.updated) emit('forge.updated', { membrane })
      scheduleBackfill()
      return { events: events.length, changed: changed || events.length > 0 }
    } finally {
      s.syncing = false
    }
  }

  async function notifyAll(list: Array<{ threadId: string; text: string }>) {
    for (const n of list) {
      try {
        await (deps.threads.notify ?? deps.threads.sendToThread)(n.threadId, n.text)
      } catch (err) {
        log(`notify ${n.threadId}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Read tracked items: PR and issue tasks whose membrane's sync does not
   * read them (forge off, a repo outside the membrane, no membrane). Open
   * tasks only; `only` reads one task whatever its state.
   */
  let trackedChain: Promise<unknown> = Promise.resolve()
  function pollTracked(only?: string): Promise<{ items: number; events: number }> {
    const run = trackedChain.then(
      () => pollTrackedOnce(only),
      () => pollTrackedOnce(only)
    )
    trackedChain = run.catch(() => undefined)
    return run
  }

  async function pollTrackedOnce(only?: string): Promise<{ items: number; events: number }> {
    lastTrackedAt = now()
    await refreshWatched().catch(() => undefined)
    const synced = new Set(cfg().enabled ? membranes() : [])
    const groups = new Map<string, { ref: ForgeRef; refs: ForgeRef[]; tasks: PortTask[] }>()
    for (const t of await deps.tasks.listForgeItems()) {
      const ref = refOfTask(t)
      if (!ref || (only ? t.id !== only : TERMINAL.includes(t.state))) continue
      if (!only && coveredBySync(t, ref, synced)) continue
      const k = repoKey(ref)
      const g = groups.get(k) ?? { ref, refs: [], tasks: [] }
      g.refs.push(ref)
      g.tasks.push(t)
      groups.set(k, g)
    }
    let items = 0
    let eventCount = 0
    for (const g of groups.values()) {
      try {
        eventCount += await pollGroup(g)
        items += g.refs.length
      } catch (err) {
        log(`tracked ${g.ref.repo}: ${(err as Error).message}`)
      }
    }
    return { items, events: eventCount }
  }

  /** Read one repo's tracked items; returns the event count. */
  async function pollGroup(g: { ref: ForgeRef; refs: ForgeRef[]; tasks: PortTask[] }): Promise<number> {
    const rs = repoSync(g.ref, true)
    if (!rs) throw new Error(`no adapter for ${g.ref.forge}:${g.ref.host}`)
    const res = await rs.refreshItems(g.refs)
    const c = rs.cache()
    const graph = buildGraph({ repos: [c], plans: [], tasks: g.tasks, related: [] })
    const ts = await syncTasks(deps.tasks, {
      tasks: g.tasks,
      nodes: new Map(graph.nodes.map((n) => [n.id, n])),
      edges: graph.edges,
      events: res.events,
      item: (id) => {
        const ref = parseRefKey(id, 'change')
        return ref ? (c.changes[ref.id] ?? c.issues[ref.id]) : undefined
      },
      now: iso()
    })
    await notifyAll(ts.notifications)
    // A membrane's event log and canvas hear about its tracked items too.
    for (const m of new Set(g.tasks.map((t) => t.membrane).filter((m): m is string => Boolean(m)))) {
      if (!deps.scope.getMembrane(m)) continue
      const keys = new Set(g.tasks.filter((t) => t.membrane === m).map((t) => t.key))
      const mine = res.events.filter((e) => keys.has(e.nodeId))
      if (mine.length) state(m).log.append(await triageAll(mine, graph, g.tasks, await identityFor(g.ref)))
      if (res.changed || mine.length || ts.updated) emit('forge.updated', { membrane: m })
    }
    return res.events.length
  }

  async function pollTask(taskId: string): Promise<void> {
    const t = await deps.tasks.get(taskId)
    if (!t) throw new ForgeError(`Task not found: ${taskId}`, 404)
    const ref = refOfTask(t)
    if (!ref) throw new ForgeError(`task ${taskId} has no PR or issue`, 400)
    const synced = new Set(cfg().enabled ? membranes() : [])
    if (coveredBySync(t, ref, synced)) await sync(t.membrane!, 'open')
    else await pollTracked(taskId)
  }

  /**
   * Each plan is a work stream (keyed by the plan id); every item it names
   * gets a task in it. Links the plan added follow the plan: an item it
   * stops naming leaves the stream. Members added by hand are never removed,
   * and an item the user took out stays out while the plan keeps naming it.
   */
  async function syncPlanStreams(membrane: string, graph: BuiltGraph): Promise<boolean> {
    const s = state(membrane)
    const prev = readFile(membrane).planLinks ?? {}
    const next: NonNullable<MembraneFile['planLinks']> = {}
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    let changed = false
    for (const p of s.plans) {
      const stream = await deps.tasks.ensureTask(p.id, { name: p.title, membrane, kind: 'plan', stream: true })
      const was = prev[p.id] ?? { named: [], linked: [] }
      if (!prev[p.id]) changed = true
      const naming = new Map<string, { kind?: 'change' | 'issue'; host: string; repo: string; n: number }>()
      for (const r of p.refs) naming.set(planRefKey(r.host, r.repo, r.number), { ...r, n: r.number })
      const named = was.named.filter((id) => naming.has(id))
      const linked = new Set(was.linked)
      const members = new Set(stream.childIds)
      for (const [id, r] of naming) {
        if (named.includes(id)) continue
        const node = nodes.get(id)
        const kind = node?.kind === 'change' || node?.kind === 'issue' ? node.kind : r.kind
        // Kind unknown (not synced yet, a short reference): try again next scan.
        if (!kind) continue
        const task = node
          ? await taskFor(membrane, node)
          : await deps.tasks.ensureTask(id, { name: `${r.repo}#${r.n}`, membrane, kind })
        if (!members.has(task.id)) {
          await deps.tasks.addToStream(stream.id, task.id)
          members.add(task.id)
          linked.add(id)
          changed = true
        }
        named.push(id)
      }
      for (const id of [...linked]) {
        if (naming.has(id)) continue
        linked.delete(id)
        const t = await deps.tasks.findByKey(id)
        if (t && members.has(t.id)) {
          await deps.tasks.removeFromStream(stream.id, t.id)
          members.delete(t.id)
          changed = true
        }
      }
      next[p.id] = { named, linked: [...linked] }
    }
    // A plan that is gone names nothing: its links go, its stream stays.
    for (const [planId, was] of Object.entries(prev)) {
      if (next[planId] || !was.linked.length) continue
      const stream = await deps.tasks.findByKey(planId)
      for (const id of was.linked) {
        const t = await deps.tasks.findByKey(id)
        if (stream && t && stream.childIds.includes(t.id)) {
          await deps.tasks.removeFromStream(stream.id, t.id)
          changed = true
        }
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) updateFile(membrane, (f) => (f.planLinks = next))
    return changed
  }

  async function backfillStep(membrane: string): Promise<boolean> {
    const scope = state(membrane).scope ?? scopeOf(membrane)
    for (const r of scope.repos) {
      const rs = syncOf(r)
      if (!rs || rs.backfillDone()) continue
      const res = await rs.backfillStep()
      if (res.items) emit('forge.updated', { membrane })
      return true
    }
    return false
  }

  function scheduleBackfill() {
    if (!started || backfillTimer) return
    backfillTimer = setTimeout(async () => {
      backfillTimer = undefined
      let more = false
      for (const m of membranes()) {
        if (state(m).syncing) {
          more = true
          continue
        }
        try {
          if (await backfillStep(m)) {
            more = true
            break
          }
        } catch (err) {
          log(`backfill ${m}: ${(err as Error).message}`)
          more = false
          break
        }
      }
      if (more) scheduleBackfill()
    }, deps.backfillDelayMs ?? 3000)
    backfillTimer.unref?.()
  }

  function membranes(): string[] {
    const c = cfg()
    return deps.scope
      .listMembranes()
      .filter((m) => {
        const s = resolveScope(deps.scope, m.id, { planDirs: c.planDirs, repos: c.repos, hosts: deps.hosts })
        return Boolean(s && (s.repos.length || s.planDirs.length))
      })
      .map((m) => m.id)
  }

  async function tick() {
    const c = cfg()
    if (now() - lastTrackedAt >= c.pollOpenMs) {
      await pollTracked().catch((err) => log(`tracked: ${(err as Error).message}`))
    }
    if (!c.enabled) return
    for (const m of membranes()) {
      const s = state(m)
      if (s.syncing) continue
      const t = now()
      try {
        if (t - s.lastAllAt >= c.pollAllMs) await sync(m, 'all')
        else if (t - s.lastOpenAt >= c.pollOpenMs) await sync(m, 'open')
      } catch (err) {
        log(`tick ${m}: ${(err as Error).message}`)
      }
    }
  }

  async function overlay(membrane: string): Promise<OverlayResult> {
    const { graph, tasks } = await full(membrane)
    const subagents = (await deps.subagents?.list().catch(() => [])) ?? []
    const checkouts = await resolveCheckouts(subagents, deps.branchOf ?? currentBranch)
    return buildOverlay({
      nodes: graph.nodes,
      tasks,
      presence: (id) => deps.threads.presence(id),
      subagents,
      ciWatches: deps.ciWatch?.list() ?? [],
      checkouts
    })
  }

  let overlayBusy = false
  async function pushOverlays() {
    if (overlayBusy || !started || !cfg().enabled) return
    overlayBusy = true
    try {
      for (const m of membranes()) {
        let o = await overlay(m)
        if (await applyClaims(m, o.claims)) o = await overlay(m)
        const json = JSON.stringify(o.overlays)
        const s = state(m)
        if (json !== s.overlayJson) {
          const first = s.overlayJson === undefined
          s.overlayJson = json
          if (!first || o.overlays.length) emit('forge.overlay', { membrane: m, overlays: o.overlays })
        }
      }
    } catch (err) {
      log(`overlay: ${(err as Error).message}`)
    } finally {
      overlayBusy = false
    }
  }

  /** Auto-link: a change a subagent or CI watch works on, with no owner, goes to that thread. */
  async function applyClaims(membrane: string, claims: OverlayResult['claims']): Promise<boolean> {
    let any = false
    for (const c of claims) {
      if (!deps.threads.presence(c.threadId)) continue
      try {
        await api.assign({ membrane, nodeId: c.nodeId, threadId: c.threadId })
        log(`auto-link ${c.nodeId} → ${c.threadId} (${c.by})`)
        any = true
      } catch (err) {
        log(`auto-link ${c.nodeId}: ${(err as Error).message}`)
      }
    }
    return any
  }

  /** A thread took or dropped a task outside Forge (task_update, the tasks API, an import): follow on the forge. */
  async function onReassigned(taskId: string, threadId: string | null) {
    const t = await deps.tasks.get(taskId)
    if (!t?.key || (t.kind !== 'change' && t.kind !== 'issue')) return
    if (threadId && t.state === 'pending') await deps.tasks.setState(t.id, 'in_progress')
    if (threadId) watchedIds.add(t.key)
    await writeAssignee(t.membrane, t.key, t.kind, Boolean(threadId))
    if (t.membrane && deps.scope.getMembrane(t.membrane)) emit('forge.updated', { membrane: t.membrane })
  }

  /** Rescan a membrane's plans after an edit: events, streams, a graph update. */
  async function plansChanged(m: string, events: ForgeEvent[]) {
    const s = state(m)
    const { graph, tasks } = await full(m)
    if (events.length) s.log.append(await triageAll(events, graph, tasks, await identityOf(s.scope ?? scopeOf(m))))
    const linked = await syncPlanStreams(m, graph)
    if (events.length || linked) emit('forge.updated', { membrane: m })
  }

  async function membraneOfNode(nodeId: string, hint?: string): Promise<string> {
    if (hint) {
      scopeOf(hint)
      return hint
    }
    for (const m of membranes()) {
      const { graph } = await full(m)
      if (graph.nodes.some((n) => n.id === nodeId)) return m
    }
    throw new ForgeError(`node not found: ${nodeId}`, 404)
  }

  /** A work stream and its membrane; a stream of another membrane than `hint` is not found. */
  async function streamIn(streamId: string, hint?: string, nodeId?: string) {
    const stream = await deps.tasks.get(streamId)
    if (!stream?.isStream || (hint && stream.membrane && stream.membrane !== hint))
      throw new ForgeError(`not a work stream${hint ? ` of ${hint}` : ''}: ${streamId}`, 404)
    const membrane = stream.membrane ?? hint ?? (nodeId ? await membraneOfNode(nodeId) : undefined)
    if (!membrane) throw new ForgeError(`work stream ${streamId} has no membrane`, 400)
    return { stream, membrane }
  }

  async function nodeIn(membrane: string, nodeId: string): Promise<{ node: WorkNode; tasks: PortTask[] }> {
    const { graph, tasks } = await full(membrane)
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node) throw new ForgeError(`node not found: ${nodeId}`, 404)
    return { node, tasks }
  }

  /**
   * Two-way assignee sync: an owner thread adds the membrane's forge
   * identity as assignee; unassigning removes it only when Forge added it.
   * Returns the forge's error message, if the write failed.
   */
  async function writeAssignee(
    membrane: string | null,
    nodeId: string,
    kind: 'change' | 'issue',
    on: boolean
  ): Promise<string | undefined> {
    const ref = parseRefKey(nodeId, kind)
    if (!ref) return undefined
    const forge = forgeOf(ref)
    if (!forge?.capabilities.assignees) return undefined
    const m = membrane ?? ''
    const scope =
      membrane && deps.scope.getMembrane(membrane) ? (state(membrane).scope ?? scopeOf(membrane)) : undefined
    const found = scope ? itemOf(scope, nodeId) : itemOfTracked(ref)
    try {
      if (on) {
        const identity = await identityFor(ref)
        if (!identity || found?.item.assignees.some((a) => a.toLowerCase() === identity.toLowerCase())) return undefined
        await forge.setAssignees(ref, [identity], [])
        if (found) {
          found.item.assignees = [...found.item.assignees, identity]
          found.sync.save()
        }
        updateFile(m, (f) => (f.assignedByForge[nodeId] = identity))
      } else {
        const login = readFile(m).assignedByForge[nodeId]
        if (!login) return undefined
        await forge.setAssignees(ref, [], [login])
        if (found) {
          found.item.assignees = found.item.assignees.filter((a) => a !== login)
          found.sync.save()
        }
        updateFile(m, (f) => delete f.assignedByForge[nodeId])
      }
      return undefined
    } catch (err) {
      log(`assignee ${nodeId}: ${(err as Error).message}`)
      return (err as Error).message
    }
  }

  function itemOfTracked(ref: ForgeRef): { sync: RepoSync; item: CachedChange | CachedIssue } | undefined {
    const sync = trackedSyncs.get(repoKey(ref))
    const c = sync?.cache()
    const item = c && (c.changes[ref.id] ?? c.issues[ref.id])
    return sync && item ? { sync, item } : undefined
  }

  /** The task behind a node, created when missing. */
  async function taskFor(membrane: string, node: WorkNode): Promise<PortTask> {
    if (node.taskId) {
      const t = await deps.tasks.get(node.taskId)
      if (t) return t
    }
    if (node.kind === 'task' || node.kind === 'branch') throw new ForgeError(`no task can be made for ${node.id}`, 400)
    const init: TaskInit = {
      name: node.number !== undefined ? `${node.repo}#${node.number} ${node.title}` : node.title,
      membrane,
      kind: node.kind,
      ...(node.url ? { url: node.url } : {})
    }
    if (node.kind === 'plan') {
      // The key names the plan: "plan:<project>/<path in its plan dir>".
      const rest = node.id.slice('plan:'.length)
      const project = rest.split('/')[0]
      init.plan = { project, path: rest.slice(project.length + 1) }
      init.stream = true
    } else {
      const ref = parseRefKey(node.id, node.kind)
      if (ref) init.ref = ref
    }
    return deps.tasks.ensureTask(node.id, init)
  }

  const api: ForgeService = {
    start() {
      if (started) return
      started = true
      timers.push(setInterval(() => void tick(), 5000))
      timers.push(setInterval(() => void pushOverlays(), deps.overlayPollMs ?? 10_000))
      for (const t of timers) t.unref?.()
      let debounce: ReturnType<typeof setTimeout> | undefined
      const soon = () => {
        if (debounce) return
        debounce = setTimeout(() => {
          debounce = undefined
          void pushOverlays()
        }, 500)
        debounce.unref?.()
      }
      for (const p of ['chat.status', 'subagent.*', 'task.reassigned']) disposers.push(deps.bus.on(p, soon))
      disposers.push(() => clearTimeout(debounce))
      // Plans: a markdown edit under a plan dir rescans that membrane's plans.
      disposers.push(
        deps.bus.on('file.changed', (e) => {
          const changedPath = (e.payload as { fullPath?: string })?.fullPath
          if (!changedPath) return
          for (const [m, s] of states) {
            if (!s.scope || !isPlanPath(s.scope.planDirs, changedPath)) continue
            const events = rescanPlans(m, s.scope)
            if (!events.length) continue
            void plansChanged(m, events).catch((err) => log(`plans ${m}: ${(err as Error).message}`))
          }
        })
      )
      // Assignment outside Forge sets the forge assignee too; a new imported
      // task gets its first read soon rather than at the next poll.
      let trackedSoon: ReturnType<typeof setTimeout> | undefined
      disposers.push(
        deps.bus.on('task.reassigned', (e) => {
          const p = e.payload as { taskId?: string; sourceThreadId?: string; newThreadId?: string | null }
          if (!p?.taskId || p.sourceThreadId === FORGE_SOURCE) return
          void onReassigned(p.taskId, p.newThreadId ?? null).catch((err) =>
            log(`reassigned ${p.taskId}: ${(err as Error).message}`)
          )
        }),
        deps.bus.on('task.created', (e) => {
          const p = e.payload as { taskId?: string; sourceThreadId?: string; threadId?: string | null }
          if (p?.sourceThreadId === FORGE_SOURCE) return
          // Created already owned (a task made for a thread): the same as an assignment.
          if (p?.taskId && p.threadId)
            void onReassigned(p.taskId, p.threadId).catch((err) =>
              log(`created ${p.taskId}: ${(err as Error).message}`)
            )
          if (trackedSoon) return
          trackedSoon = setTimeout(() => {
            trackedSoon = undefined
            void pollTracked().catch((err) => log(`tracked: ${(err as Error).message}`))
          }, 1000)
          trackedSoon.unref?.()
        }),
        () => clearTimeout(trackedSoon)
      )
      void tick()
    },
    stop() {
      started = false
      for (const t of timers.splice(0)) clearInterval(t)
      for (const d of disposers.splice(0)) d()
      if (backfillTimer) clearTimeout(backfillTimer)
      backfillTimer = undefined
    },
    config: cfg,
    membranes,

    async graph(membrane, opts = {}) {
      const c = cfg()
      const scope = state(membrane).scope ?? scopeOf(membrane)
      const until = opts.until ?? iso()
      const since = opts.since ?? new Date(Date.parse(until) - c.windowDays * 86_400_000).toISOString()
      if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)))
        throw new ForgeError('since/until must be ISO times', 400)
      const { graph } = await full(membrane, scope)
      let view: ForgeView | undefined
      if (opts.view) {
        view = (await deps.tasks.getViews(membrane)).find((v) => v.id === opts.view)
        if (!view && opts.view !== 'all') throw new ForgeError(`unknown view: ${opts.view}`, 404)
      }
      const me = await identityOf(scope)
      const g = windowGraph(applyView(graph, view, { ...(me ? { me } : {}), now: now() }), since, until, now())
      const s = state(membrane)
      const syncs_ = scope.repos.map((r) => syncOf(r)).filter((x): x is RepoSync => Boolean(x))
      const notes = deps.rethinkNotes?.(membrane) ?? {}
      return {
        membrane,
        since,
        until,
        nodes: g.nodes.map((n) => (notes[n.id]?.length ? { ...n, rethink: notes[n.id] } : n)),
        edges: g.edges,
        workstreams: await deps.tasks.streamsOf(membrane),
        ...(cfg().enabled
          ? { syncing: s.syncing || syncs_.some((x) => !x.cache().windowSyncedAt || !x.backfillDone()) }
          : { syncing: false, syncOff: true }),
        ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
        ...(me ? { identity: me } : {})
      }
    },

    async search(membrane, q) {
      const { graph } = await full(membrane)
      return searchGraph(graph, q)
    },

    overlay,
    sync,
    backfillStep,

    digest,

    events(membrane, opts = {}) {
      scopeOf(membrane)
      return state(membrane).log.read(opts)
    },

    async rethink(membrane, opts = {}) {
      if (!deps.runRethink) throw new ForgeError('rethink is not available yet', 501)
      const d = await digest(membrane)
      if (!d.count) return { ran: false, count: 0 }
      const started = await deps.runRethink(membrane, d, { trigger: opts.trigger ?? 'manual' })
      if (d.cursor) updateFile(membrane, (f) => (f.rethinkCursor = d.cursor))
      return { ran: true, count: d.count, ...(started?.runId ? { runId: started.runId } : {}) }
    },

    async node(membrane, nodeId) {
      const { graph } = await full(membrane)
      return graph.nodes.find((n) => n.id === nodeId)
    },

    async relate(membrane, edge) {
      if (edge.from === edge.to) throw new ForgeError('an edge needs two different nodes', 400)
      const { graph } = await full(membrane)
      for (const id of [edge.from, edge.to]) {
        if (!graph.nodes.some((n) => n.id === id)) throw new ForgeError(`node not found: ${id}`, 404)
      }
      if (!(edge.confidence >= 0 && edge.confidence <= 1)) throw new ForgeError('confidence must be 0–1', 400)
      const rec = await deps.tasks.addRelated(membrane, { ...edge, kind: 'related' })
      emit('forge.updated', { membrane })
      return rec
    },

    async assign(input) {
      const membrane = await membraneOfNode(input.nodeId, input.membrane)
      const { node } = await nodeIn(membrane, input.nodeId)
      const task = await taskFor(membrane, node)
      const forgeItem = node.kind === 'change' || node.kind === 'issue' ? node.kind : undefined

      if (input.threadId === null) {
        await deps.tasks.setThread(task.id, null)
        const forgeError = forgeItem ? await writeAssignee(membrane, node.id, forgeItem, false) : undefined
        emit('forge.updated', { membrane })
        return { taskId: task.id, threadId: null, ...(forgeError ? { forgeError } : {}) }
      }

      let threadId = input.threadId ?? undefined
      if (!threadId && input.newThread) {
        threadId = await deps.threads.createThread(membrane, input.newThread.label?.trim() || node.title)
      }
      if (!threadId) throw new ForgeError('threadId or newThread is required', 400)
      await deps.tasks.setThread(task.id, threadId)
      if (task.state === 'pending') await deps.tasks.setState(task.id, 'in_progress')
      const forgeError = forgeItem ? await writeAssignee(membrane, node.id, forgeItem, true) : undefined
      const prompt = input.prompt?.trim() || (input.newThread ? defaultWorkPrompt(node) : undefined)
      if (prompt) await deps.threads.sendToThread(threadId, prompt)
      watchedIds.add(node.id)
      emit('forge.updated', { membrane })
      return { taskId: task.id, threadId, ...(forgeError ? { forgeError } : {}) }
    },

    pollTask,
    pollTracked: () => pollTracked(),

    async getViews(membrane) {
      scopeOf(membrane)
      const views = await deps.tasks.getViews(membrane)
      return views.length ? views : [{ id: 'all', membrane, title: 'All repos', repos: [], filters: {} }]
    },

    async putViews(membrane, views) {
      scopeOf(membrane)
      const seen = new Set<string>()
      const clean = views.map((v, i) => {
        const id = typeof v.id === 'string' && v.id ? v.id : `view-${i + 1}`
        if (seen.has(id)) throw new ForgeError(`duplicate view id: ${id}`, 400)
        seen.add(id)
        return {
          id,
          membrane,
          title: String(v.title ?? id),
          repos: Array.isArray(v.repos) ? v.repos.filter((r) => typeof r === 'string') : [],
          filters: v.filters && typeof v.filters === 'object' ? v.filters : {},
          ...(typeof v.height === 'number' ? { height: v.height } : {})
        }
      })
      const out = await deps.tasks.putViews(membrane, clean)
      emit('forge.updated', { membrane })
      return out
    },

    async createStream(membrane, name, parentId) {
      scopeOf(membrane)
      if (!name.trim()) throw new ForgeError('name is required', 400)
      if (parentId) await streamIn(parentId, membrane)
      const s = await deps.tasks.createStream(membrane, name.trim(), parentId)
      emit('forge.updated', { membrane })
      return s
    },

    async addMember(streamId, nodeId, hint) {
      const { membrane } = await streamIn(streamId, hint, nodeId)
      const { node } = await nodeIn(membrane, nodeId)
      const task = await taskFor(membrane, node)
      await deps.tasks.addToStream(streamId, task.id)
      emit('forge.updated', { membrane })
      return { taskId: task.id }
    },

    async removeMember(streamId, nodeId, hint) {
      const { stream, membrane } = await streamIn(streamId, hint, nodeId)
      const { node } = await nodeIn(membrane, nodeId)
      if (!node.taskId || !stream.childIds.includes(node.taskId)) return false
      await deps.tasks.removeFromStream(streamId, node.taskId)
      emit('forge.updated', { membrane })
      return true
    },

    async acceptEdge(from, to, kind, hint) {
      for (const m of hint ? [hint] : membranes()) {
        if (await deps.tasks.acceptRelated(m, from, to, kind)) {
          emit('forge.updated', { membrane: m })
          return true
        }
      }
      return false
    },

    async deleteEdge(from, to, kind, hint) {
      for (const m of hint ? [hint] : membranes()) {
        if (await deps.tasks.deleteRelated(m, from, to, kind)) {
          emit('forge.updated', { membrane: m })
          return true
        }
      }
      return false
    },

    async status(membrane) {
      const scope = scopeOf(membrane)
      const s = state(membrane)
      if (!s.plansScanned) rescanPlans(membrane, scope)
      const repos: RepoStatus[] = scope.repos.map((r) => {
        const rs = syncOf(r)
        const c = rs?.cache()
        const err = s.repoErrors.get(r.repo)
        return {
          repo: r.repo,
          changes: c ? Object.keys(c.changes).length : 0,
          issues: c ? Object.keys(c.issues).length : 0,
          ...(c?.windowSyncedAt ? { windowSyncedAt: c.windowSyncedAt } : {}),
          ...(c?.lastOpenSyncAt ? { lastOpenSyncAt: c.lastOpenSyncAt } : {}),
          ...(c?.lastAllSyncAt ? { lastAllSyncAt: c.lastAllSyncAt } : {}),
          backfill: c?.backfill ?? {
            changes: { done: false, pages: 0, items: 0 },
            issues: { done: false, pages: 0, items: 0 }
          },
          ...(err ? { error: err } : {})
        }
      })
      const identity = await identityOf(scope)
      return {
        membrane,
        enabled: cfg().enabled,
        syncing: s.syncing,
        ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(identity ? { identity } : {}),
        repos,
        plans: s.plans.length,
        backfill: {
          done: repos.every((r) => r.backfill.changes.done && r.backfill.issues.done),
          pages: repos.reduce((a, r) => a + r.backfill.changes.pages + r.backfill.issues.pages, 0),
          items: repos.reduce((a, r) => a + r.backfill.changes.items + r.backfill.issues.items, 0)
        },
        triage: s.log.coverage(),
        events: s.log.count()
      }
    }
  }
  return api
}
