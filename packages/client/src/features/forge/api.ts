// Forge HTTP client. Every call takes a fetch, so tests pass their own.

import type {
  AgentOverlay,
  Decision,
  DecisionDelivery,
  EpicStatus,
  ForgeGraph,
  ForgeView,
  WorkCategory,
  WorkEdge,
  WorkNode,
  WorkStream
} from '@sovereign/core'
import type { AssignBody } from './card-model.js'
import type { RethinkRuns, RethinkStart } from './rethink-model.js'
import { windowQuery, type WindowRequest } from './window-model.js'

type Fetch = typeof fetch

export class ForgeApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      msg = body.error ?? body.message ?? msg
    } catch {
      /* not JSON */
    }
    throw new ForgeApiError(msg, res.status)
  }
  // POSTs may answer 202/204 with no body.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const enc = encodeURIComponent
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function createForgeApi(f: Fetch = (...a) => fetch(...a)) {
  const send = (url: string, method: string, body?: unknown) =>
    f(url, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  return {
    /** `archived` includes archived epics (the Archived status chip). */
    graph: async (
      membrane: string,
      req: WindowRequest,
      view?: string,
      opts: { signal?: AbortSignal; archived?: boolean } = {}
    ): Promise<ForgeGraph> =>
      json(await f(`/api/forge?${windowQuery(membrane, req, view, opts.archived)}`, { signal: opts.signal })),
    search: async (
      membrane: string,
      q: string,
      signal?: AbortSignal
    ): Promise<{ nodes: WorkNode[]; edges: WorkEdge[] }> =>
      json(await f(`/api/forge/search?membrane=${enc(membrane)}&q=${enc(q)}`, { signal })),
    overlay: async (membrane: string): Promise<AgentOverlay[]> =>
      (await json<{ overlays: AgentOverlay[] }>(await f(`/api/forge/overlay?membrane=${enc(membrane)}`))).overlays ??
      [],
    sync: async (membrane: string): Promise<void> => {
      await json(await send(`/api/forge/sync?membrane=${enc(membrane)}`, 'POST'))
    },
    /** Undefined when the server answers without a body. */
    rethink: async (membrane: string): Promise<RethinkStart | undefined> =>
      json(await send(`/api/forge/rethink?membrane=${enc(membrane)}`, 'POST')),
    rethinkRuns: async (membrane: string): Promise<RethinkRuns> =>
      json(await f(`/api/forge/rethink/runs?membrane=${enc(membrane)}`)),
    /** The run report as markdown. */
    rethinkReport: async (membrane: string, id: string): Promise<string> => {
      const res = await f(`/api/forge/rethink/runs/${enc(id)}?membrane=${enc(membrane)}`)
      if (!res.ok) await json(res)
      return res.text()
    },
    assign: async (body: AssignBody): Promise<{ taskId: string; threadId: string }> =>
      json(await send('/api/forge/assign', 'POST', body)),
    views: async (membrane: string): Promise<ForgeView[]> =>
      (await json<{ views: ForgeView[] }>(await f(`/api/forge/views?membrane=${enc(membrane)}`))).views ?? [],
    saveViews: async (membrane: string, views: ForgeView[]): Promise<ForgeView[]> =>
      (await json<{ views: ForgeView[] }>(await send(`/api/forge/views?membrane=${enc(membrane)}`, 'PUT', { views })))
        .views ?? views,
    createStream: async (membrane: string, name: string, parentId?: string): Promise<WorkStream> =>
      json(await send('/api/forge/streams', 'POST', parentId ? { membrane, name, parentId } : { membrane, name })),
    setStreamStatus: async (membrane: string, streamId: string, status: EpicStatus): Promise<WorkStream> =>
      json(await send(`/api/forge/streams/${enc(streamId)}/status`, 'POST', { membrane, status })),
    /** Pause a PR, issue or task, or resume it. */
    setPaused: async (membrane: string, nodeId: string, paused: boolean): Promise<WorkNode> =>
      json(await send('/api/forge/paused', 'POST', { membrane, nodeId, paused })),
    /** The user's category of a node; null clears it, so the rules or rethink decide again. */
    setCategory: async (membrane: string, nodeId: string, category: WorkCategory | null): Promise<WorkNode> =>
      json(await send(`/api/forge/nodes/${enc(nodeId)}/category`, 'PUT', { membrane, category })),
    /** Place a stream in the goal tree: under `parentId`, or at the top (null) as a goal. */
    setStreamParent: async (membrane: string, streamId: string, parentId: string | null): Promise<WorkStream> =>
      json(await send(`/api/forge/streams/${enc(streamId)}/parent`, 'POST', { membrane, parentId })),
    /** Sends the request, with the current epics, to the membrane's forge-rethink thread. */
    refineEpics: async (membrane: string, prompt: string): Promise<{ threadId: string }> =>
      json(await send('/api/forge/epics/refine', 'POST', { membrane, prompt })),
    addMember: async (streamId: string, nodeId: string): Promise<void> => {
      await json(await send(`/api/forge/streams/${enc(streamId)}/members`, 'POST', { nodeId }))
    },
    removeMember: async (streamId: string, nodeId: string): Promise<void> => {
      await json(await send(`/api/forge/streams/${enc(streamId)}/members`, 'DELETE', { nodeId }))
    },
    acceptEdge: async (e: Pick<WorkEdge, 'from' | 'to' | 'kind'>): Promise<void> => {
      await json(await send(`/api/forge/edges/${enc(e.from)}/${enc(e.to)}/${enc(e.kind)}/accept`, 'POST'))
    },
    deleteEdge: async (e: Pick<WorkEdge, 'from' | 'to' | 'kind'>): Promise<void> => {
      await json(await send(`/api/forge/edges/${enc(e.from)}/${enc(e.to)}/${enc(e.kind)}`, 'DELETE'))
    },
    /** The membrane's decisions; `status` 'all' gives open and resolved. */
    decisions: async (membrane: string, status: 'open' | 'resolved' | 'all' = 'all'): Promise<Decision[]> =>
      (
        await json<{ decisions: Decision[] }>(
          await f(`/api/forge/decisions?membrane=${enc(membrane)}&status=${enc(status)}`)
        )
      ).decisions ?? [],
    /** Change a decision's group or thread (null clears), question, context or options. */
    updateDecision: async (
      membrane: string,
      id: string,
      patch: Partial<Record<'group' | 'threadId' | 'context', string | null>> & {
        question?: string
        options?: string[]
      }
    ): Promise<Decision> => json(await send(`/api/forge/decisions/${enc(id)}`, 'PATCH', { membrane, ...patch })),
    /** Set a group and/or a thread on many decisions at once. */
    groupDecisions: async (
      membrane: string,
      ids: string[],
      patch: { group?: string | null; threadId?: string | null }
    ): Promise<Decision[]> =>
      (
        await json<{ decisions: Decision[] }>(
          await send('/api/forge/decisions/group', 'POST', { membrane, ids, ...patch })
        )
      ).decisions ?? [],
    /** Resolve many at once; each receiving thread gets one message. */
    resolveDecisions: async (body: {
      membrane: string
      items: Array<{ id: string; resolution: string }>
    }): Promise<{ resolved: Decision[]; deliveries: DecisionDelivery[] }> =>
      json(await send('/api/forge/decisions/resolve', 'POST', body))
  }
}

export type ForgeApi = ReturnType<typeof createForgeApi>
