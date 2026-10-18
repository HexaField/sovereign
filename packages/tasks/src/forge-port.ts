// Forge TaskPort — the work graph's view of the task graph (the TaskPort
// contract in @sovereign/core). Task writes go through TaskService, so each
// one emits the task.* bus events the presence TaskDigest reads; views and
// suggested edges live in the Forge meta store. Both persist in the
// `sovereign-forge` perspective (with outbox and snapshot while AD4M is down).

import type {
  ChangeState,
  ForgeView,
  PortTask,
  PortTaskStatus,
  RelatedEdgeRecord,
  TaskInit,
  TaskPort,
  WorkEdgeKind,
  WorkStream
} from '@sovereign/core'
import { epicStatusOf, parseRefKey } from '@sovereign/core'
import type { ForgeMetaStore, RelatedEdge } from './meta.js'
import type { TaskService } from './service.js'
import type { Task, TaskProvider } from './types.js'
import { parsePlanKey, planKey, providerKey } from './types.js'

export interface ForgeTaskPortDeps {
  service: TaskService
  meta: ForgeMetaStore
  /** sourceThreadId on the events the port's writes emit. Default 'forge'. */
  source?: string
}

const EPOCH = new Date(0).toISOString()
const CHANGE_STATES: ChangeState[] = ['open', 'draft', 'merged', 'closed']

/** The provider's status fields as the work graph reads them. */
export function statusOf(p: TaskProvider | undefined): PortTaskStatus | undefined {
  if (!p) return undefined
  if (p.kind === 'change') {
    return {
      kind: 'change',
      state: p.status,
      checks: p.checksStatus === 'unknown' ? 'none' : p.checksStatus,
      ...(p.failedChecks?.length ? { failedChecks: p.failedChecks } : {}),
      review: p.reviewDecision === 'unknown' ? 'none' : p.reviewDecision,
      unresolvedComments: p.unresolvedComments,
      lastPolledAt: p.lastPolledAt
    }
  }
  if (p.kind === 'issue') {
    return {
      kind: 'issue',
      state: p.issueState === 'closed' ? `closed:${p.closedReason ?? 'completed'}` : 'open',
      ...(p.unresolvedComments !== undefined ? { unresolvedComments: p.unresolvedComments } : {}),
      lastPolledAt: p.lastPolledAt
    }
  }
  return { kind: 'plan', state: p.status, lastPolledAt: EPOCH }
}

/** The provider with a work-graph status written onto it. A field the status leaves out keeps its value. */
export function withStatus(p: TaskProvider, s: PortTaskStatus): TaskProvider {
  if (s.kind !== p.kind) throw new Error(`Status of a ${s.kind} cannot go on a ${p.kind} task`)
  if (p.kind === 'change') {
    const { failedChecks: _old, ...rest } = p
    return {
      ...rest,
      status: CHANGE_STATES.includes(s.state as ChangeState) ? (s.state as ChangeState) : p.status,
      checksStatus: s.checks ? (s.checks === 'none' ? 'unknown' : s.checks) : p.checksStatus,
      reviewDecision: s.review ? (s.review === 'none' ? 'unknown' : s.review) : p.reviewDecision,
      unresolvedComments: s.unresolvedComments ?? p.unresolvedComments,
      ...(s.failedChecks?.length ? { failedChecks: s.failedChecks } : {}),
      lastPolledAt: s.lastPolledAt
    }
  }
  if (p.kind === 'issue') {
    const { closedReason: _old, ...rest } = p
    const closed = s.state.startsWith('closed')
    const unresolvedComments = s.unresolvedComments ?? p.unresolvedComments
    return {
      ...rest,
      issueState: closed ? 'closed' : 'open',
      ...(closed ? { closedReason: s.state === 'closed:not_planned' ? 'not_planned' : 'completed' } : {}),
      ...(unresolvedComments !== undefined ? { unresolvedComments } : {}),
      lastPolledAt: s.lastPolledAt
    }
  }
  const status = s.state === 'done' || s.state === 'in_progress' || s.state === 'planned' ? s.state : p.status
  return { ...p, status }
}

export function toPortTask(t: Task): PortTask {
  const status = statusOf(t.provider)
  return {
    id: t.id,
    name: t.name,
    state: t.state,
    threadId: t.threadId,
    transientState: t.transientState,
    membrane: t.membrane,
    key: t.provider ? providerKey(t.provider) : null,
    ...(t.provider ? { kind: t.provider.kind } : {}),
    parentIds: t.parentTasks.map((p) => p.id),
    childIds: t.childTasks.map((c) => c.id),
    isStream: t.isStream,
    ...(status ? { status } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt ?? t.createdAt
  }
}

/** A fresh provider for a work-graph key. The key decides: a plan's path comes from it, not from `init`. */
function providerFor(key: string, init: TaskInit): TaskProvider {
  if (init.kind === 'plan') {
    const plan = init.plan && planKey(init.plan.project, init.plan.path) === key ? init.plan : parsePlanKey(key)
    if (!plan) throw new Error(`Not a plan key: ${key}`)
    return { kind: 'plan', project: plan.project, path: plan.path, status: 'planned' }
  }
  const parsed = init.ref ?? parseRefKey(key, init.kind)
  if (!parsed) throw new Error(`Not a forge key: ${key}`)
  const ref = { ...parsed, kind: init.kind }
  const url = init.url ?? ''
  if (init.kind === 'issue') return { kind: 'issue', refs: [ref], url, issueState: 'open', lastPolledAt: EPOCH }
  return {
    kind: 'change',
    refs: [ref],
    url,
    status: 'open',
    checksStatus: 'unknown',
    reviewDecision: 'unknown',
    unresolvedComments: 0,
    lastPolledAt: EPOCH
  }
}

const VIEW_PREFIX = 'forge-view://'

/** Views are stored as forge-view://<membrane>/<id>, so ids the client picks stay unique across membranes. */
function storedViewId(membrane: string, id: string): string {
  return `${VIEW_PREFIX}${encodeURIComponent(membrane)}/${encodeURIComponent(id)}`
}

function viewIdOf(membrane: string, stored: string): string {
  const prefix = `${VIEW_PREFIX}${encodeURIComponent(membrane)}/`
  return stored.startsWith(prefix) ? decodeURIComponent(stored.slice(prefix.length)) : stored
}

function toRecord(e: RelatedEdge): RelatedEdgeRecord {
  return {
    from: e.from,
    to: e.to,
    kind: e.kind,
    ...(e.reason ? { reason: e.reason } : {}),
    confidence: e.confidence,
    source: e.source,
    accepted: e.accepted,
    createdAt: e.createdAt
  }
}

export function createForgeTaskPort(deps: ForgeTaskPortDeps): TaskPort {
  const { service, meta } = deps
  const source = deps.source ?? 'forge'

  async function must(id: string): Promise<Task> {
    const t = await service.get(id)
    if (!t) throw new Error(`Task not found: ${id}`)
    return t
  }

  async function full(ids: string[]): Promise<PortTask[]> {
    const tasks = await Promise.all(ids.map((id) => service.get(id)))
    return tasks.filter((t): t is Task => Boolean(t)).map(toPortTask)
  }

  const getViews = async (membrane: string): Promise<ForgeView[]> =>
    meta.listViews(membrane).map(({ position: _p, ...v }) => ({ ...v, id: viewIdOf(membrane, v.id) }))

  const edgeIn = (membrane: string, from: string, to: string, kind: WorkEdgeKind) =>
    meta.listEdges({ membrane }).find((e) => e.from === from && e.to === to && e.kind === kind)

  return {
    async ensureTask(key, init) {
      const { task } = await service.ensureTask(key, {
        name: init.name,
        membrane: init.membrane,
        autoAssign: false,
        sourceThreadId: source,
        provider: providerFor(key, init),
        ...(init.stream ? { isStream: true } : {})
      })
      // A task imported with no membrane joins the membrane that asks for it.
      const fix = {
        ...(init.stream && !task.isStream ? { isStream: true } : {}),
        ...(!task.membrane && init.membrane ? { membrane: init.membrane } : {})
      }
      return toPortTask(
        Object.keys(fix).length ? await service.update(task.id, { ...fix, sourceThreadId: source }) : task
      )
    },

    async get(id) {
      const t = await service.get(id)
      return t ? toPortTask(t) : undefined
    },

    async findByKey(key) {
      const t = await service.findByProviderKey(key)
      return t ? toPortTask(t) : undefined
    },

    async setThread(id, threadId) {
      const t = await must(id)
      if (t.threadId === threadId) return
      await service.update(id, { threadId, sourceThreadId: source })
    },

    async setState(id, state) {
      const t = await must(id)
      if (t.state === state) return
      await service.update(id, { state, sourceThreadId: source })
    },

    async setTransientState(id, text) {
      const t = await must(id)
      if (t.transientState === text) return
      await service.update(id, { transientState: text, sourceThreadId: source })
    },

    async setStatus(id, status) {
      const t = await must(id)
      if (!t.provider) throw new Error(`Task ${id} has no forge item`)
      await service.update(id, { provider: withStatus(t.provider, status), sourceThreadId: source })
    },

    async listByMembrane(membrane) {
      return full((await service.list({ membrane })).map((t) => t.id))
    },

    async listForgeItems() {
      const [changes, issues] = await Promise.all([
        service.list({ providerKind: 'change' }),
        service.list({ providerKind: 'issue' })
      ])
      return full([...changes, ...issues].map((t) => t.id))
    },

    streamsOf: (membrane) => service.listStreams(membrane),

    async createStream(membrane, name, parentId): Promise<WorkStream> {
      const s = await service.createStream({
        name,
        membrane,
        ...(parentId ? { parentStreamIds: [parentId] } : {}),
        sourceThreadId: source
      })
      return {
        id: s.id,
        name: s.name,
        membrane,
        ...(parentId ? { parentId } : {}),
        memberCount: 0,
        status: epicStatusOf(s.state)
      }
    },

    async setName(id, name) {
      const t = await must(id)
      if (t.name === name) return
      await service.update(id, { name, sourceThreadId: source })
    },

    async setStream(id, isStream) {
      const t = await must(id)
      if (t.isStream === isStream) return
      await service.update(id, { isStream, sourceThreadId: source })
    },

    addToStream: (streamId, taskId) => service.addToStream(streamId, taskId, source),
    removeFromStream: (streamId, taskId) => service.removeFromStream(streamId, taskId, source),

    getViews,

    async putViews(membrane, views) {
      const keep = new Set(views.map((v) => storedViewId(membrane, v.id)))
      for (const v of meta.listViews(membrane)) if (!keep.has(v.id)) meta.deleteView(v.id)
      views.forEach((v, position) =>
        meta.saveView({
          id: storedViewId(membrane, v.id),
          membrane,
          title: v.title,
          repos: v.repos,
          filters: v.filters,
          ...(v.height !== undefined ? { height: v.height } : {}),
          position
        })
      )
      return getViews(membrane)
    },

    async listRelated(membrane) {
      return meta.listEdges({ membrane }).map(toRecord)
    },

    async addRelated(membrane, edge) {
      const existing = edgeIn(membrane, edge.from, edge.to, edge.kind)
      if (existing) return toRecord(existing)
      return toRecord(
        meta.addEdge({
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          reason: edge.reason ?? '',
          ...(edge.confidence !== undefined ? { confidence: edge.confidence } : {}),
          source: edge.source,
          membrane
        })
      )
    },

    async acceptRelated(membrane, from, to, kind) {
      const e = edgeIn(membrane, from, to, kind)
      return e ? meta.acceptEdge(e.id) : false
    },

    async deleteRelated(membrane, from, to, kind) {
      const e = edgeIn(membrane, from, to, kind)
      return e ? meta.deleteEdge(e.id) : false
    }
  }
}
