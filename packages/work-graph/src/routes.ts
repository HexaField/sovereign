// Forge REST routes.

import express, { Router, type Request, type Response } from 'express'
import { EPIC_STATUSES, WORK_CATEGORIES, type EpicStatus, type ForgeView, type WorkEdgeKind } from '@sovereign/core'
import { isWorkCategory } from './category.js'
import { ForgeError, type ForgeService } from './service.js'

export type Auth = (req: Request, res: Response, next: () => void) => void

const EDGE_KINDS: WorkEdgeKind[] = [
  'base',
  'merged-into',
  'closes',
  'references',
  'paired',
  'plans',
  'subtask',
  'related',
  'depends-on'
]

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
/** A string field from the body, else the query. */
const param = (req: Request, k: string) => str(req.body?.[k]) ?? str(req.query[k])

export function fail(res: Response, err: unknown) {
  if (err instanceof ForgeError) return res.status(err.status).json({ error: err.message })
  const msg = (err as Error)?.message ?? String(err)
  // TaskPort errors name a missing task or a bad link.
  if (/not found/i.test(msg)) return res.status(404).json({ error: msg })
  if (/cycle|own parent|not a work stream/i.test(msg)) return res.status(400).json({ error: msg })
  return res.status(500).json({ error: msg })
}

export function requireMembrane(req: Request): string {
  const m = param(req, 'membrane')
  if (!m) throw new ForgeError('membrane is required', 400)
  return m
}

const bad = (message: string) => new ForgeError(message, 400)

/** Sends the handler's result as JSON; a thrown error becomes its status. */
const handle =
  (fn: (req: Request) => unknown, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(req))
    } catch (err) {
      fail(res, err)
    }
  }

function edgeOf(req: Request) {
  const kind = String(req.params.kind) as WorkEdgeKind
  if (!EDGE_KINDS.includes(kind)) throw bad(`unknown edge kind: ${kind}`)
  return { from: String(req.params.from), to: String(req.params.to), kind }
}

export function createForgeRouter(service: ForgeService, requireAuth: Auth): Router {
  const router = Router()
  const json = express.json({ limit: '1mb' })

  router.get(
    '/api/forge',
    requireAuth,
    handle((req) =>
      service.graph(requireMembrane(req), {
        ...(str(req.query.view) ? { view: str(req.query.view) } : {}),
        ...(str(req.query.since) ? { since: str(req.query.since) } : {}),
        ...(str(req.query.until) ? { until: str(req.query.until) } : {}),
        ...(req.query.archived === '1' || req.query.archived === 'true' ? { archived: true } : {})
      })
    )
  )

  router.get(
    '/api/forge/search',
    requireAuth,
    handle((req) => {
      const membrane = requireMembrane(req)
      const q = str(req.query.q)
      if (!q) throw bad('q is required')
      return service.search(membrane, q)
    })
  )

  router.get(
    '/api/forge/overlay',
    requireAuth,
    handle((req) => service.overlay(requireMembrane(req)))
  )

  router.post(
    '/api/forge/sync',
    requireAuth,
    json,
    handle(async (req) => {
      const membrane = requireMembrane(req)
      return { membrane, ...(await service.sync(membrane, 'all')) }
    })
  )

  router.post(
    '/api/forge/rethink',
    requireAuth,
    json,
    handle(async (req) => {
      const membrane = requireMembrane(req)
      return { membrane, ...(await service.rethink(membrane)) }
    })
  )

  router.get(
    '/api/forge/digest',
    requireAuth,
    handle((req) => service.digest(requireMembrane(req), str(req.query.since)))
  )

  router.get(
    '/api/forge/events',
    requireAuth,
    handle((req) => {
      const since = str(req.query.since)
      return { events: service.events(requireMembrane(req), since ? { since } : {}) }
    })
  )

  router.post(
    '/api/forge/assign',
    requireAuth,
    json,
    handle((req) => {
      const b = req.body ?? {}
      const nodeId = str(b.nodeId)
      if (!nodeId) throw bad('nodeId is required')
      if (b.threadId !== undefined && b.threadId !== null && typeof b.threadId !== 'string')
        throw bad('threadId must be a string or null')
      if (b.newThread !== undefined && (typeof b.newThread !== 'object' || b.newThread === null))
        throw bad('newThread must be { label }')
      if (b.prompt !== undefined && typeof b.prompt !== 'string') throw bad('prompt must be a string')
      const membrane = param(req, 'membrane')
      return service.assign({
        nodeId,
        ...(membrane ? { membrane } : {}),
        ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
        ...(b.newThread
          ? { newThread: typeof b.newThread.label === 'string' ? { label: b.newThread.label } : {} }
          : {}),
        ...(b.prompt !== undefined ? { prompt: b.prompt } : {})
      })
    })
  )

  router.get(
    '/api/forge/views',
    requireAuth,
    handle(async (req) => ({ views: await service.getViews(requireMembrane(req)) }))
  )

  router.put(
    '/api/forge/views',
    requireAuth,
    json,
    handle(async (req) => {
      const membrane = requireMembrane(req)
      const views = req.body?.views
      if (!Array.isArray(views) || views.some((v) => typeof v !== 'object' || v === null))
        throw bad('views must be an array of views')
      return { views: await service.putViews(membrane, views as ForgeView[]) }
    })
  )

  router.get(
    '/api/forge/streams',
    requireAuth,
    handle(async (req) => ({
      streams: await service.streams(requireMembrane(req), {
        archived: req.query.archived === '1' || req.query.archived === 'true'
      })
    }))
  )

  router.post(
    '/api/forge/streams',
    requireAuth,
    json,
    handle((req) => {
      const membrane = requireMembrane(req)
      const name = str(req.body?.name)
      if (!name) throw bad('name is required')
      const parentId = req.body?.parentId
      if (parentId !== undefined && typeof parentId !== 'string') throw bad('parentId must be a string')
      return service.createStream(membrane, name, parentId)
    }, 201)
  )

  router.post(
    '/api/forge/streams/:id/status',
    requireAuth,
    json,
    handle((req) => {
      const status = req.body?.status
      if (!EPIC_STATUSES.includes(status)) throw bad(`status must be one of ${EPIC_STATUSES.join(', ')}`)
      return service.setStreamStatus(String(req.params.id), status as EpicStatus, param(req, 'membrane'))
    })
  )

  // Pause a PR, issue or task (hidden by default), or resume it.
  router.post(
    '/api/forge/paused',
    requireAuth,
    json,
    handle((req) => {
      const nodeId = str(req.body?.nodeId)
      if (!nodeId) throw bad('nodeId is required')
      if (typeof req.body?.paused !== 'boolean') throw bad('paused must be true or false')
      return service.setPaused(requireMembrane(req), nodeId, req.body.paused)
    })
  )

  // The user's category of a node (a node id is URL-encoded); null clears it, so the rules or rethink decide again.
  router.put(
    '/api/forge/nodes/:id/category',
    requireAuth,
    json,
    handle((req) => {
      const category = req.body?.category
      if (category !== null && !isWorkCategory(category))
        throw bad(`category must be one of ${WORK_CATEGORIES.join(', ')}, or null`)
      return service.setCategory(requireMembrane(req), String(req.params.id), category, 'user')
    })
  )

  // Place a stream in the goal tree: under `parentId` (its one parent), or at the top (null) as a goal.
  router.post(
    '/api/forge/streams/:id/parent',
    requireAuth,
    json,
    handle((req) => {
      const parentId = req.body?.parentId
      if (parentId !== null && !str(parentId)) throw bad('parentId must be a stream id, or null for the top level')
      return service.setStreamParent(String(req.params.id), parentId, param(req, 'membrane'))
    })
  )

  router.post(
    '/api/forge/streams/:id/members',
    requireAuth,
    json,
    handle((req) => {
      const nodeId = str(req.body?.nodeId)
      if (!nodeId) throw bad('nodeId is required')
      return service.addMember(String(req.params.id), nodeId, param(req, 'membrane'))
    })
  )

  router.delete(
    '/api/forge/streams/:id/members',
    requireAuth,
    json,
    handle(async (req) => {
      const nodeId = param(req, 'nodeId')
      if (!nodeId) throw bad('nodeId is required')
      if (!(await service.removeMember(String(req.params.id), nodeId, param(req, 'membrane'))))
        throw new ForgeError('not a member of this stream', 404)
      return { removed: true }
    })
  )

  router.post(
    '/api/forge/edges',
    requireAuth,
    json,
    handle(async (req) => {
      const membrane = requireMembrane(req)
      if (req.body?.kind !== 'depends-on') throw bad("kind must be 'depends-on'")
      const from = str(req.body?.from)
      const to = str(req.body?.to)
      if (!from || !to) throw bad('from and to are required')
      const reason = str(req.body?.reason)
      return service.depend(membrane, { from, to, ...(reason ? { reason } : {}), source: 'user' })
    })
  )

  router.post(
    '/api/forge/edges/:from/:to/:kind/accept',
    requireAuth,
    json,
    handle(async (req) => {
      const e = edgeOf(req)
      if (!(await service.acceptEdge(e.from, e.to, e.kind, param(req, 'membrane'))))
        throw new ForgeError('no such suggested edge', 404)
      return { accepted: true }
    })
  )

  router.delete(
    '/api/forge/edges/:from/:to/:kind',
    requireAuth,
    handle(async (req) => {
      const e = edgeOf(req)
      if (!(await service.deleteEdge(e.from, e.to, e.kind, param(req, 'membrane'))))
        throw new ForgeError('no such suggested edge', 404)
      return { deleted: true }
    })
  )

  router.get(
    '/api/forge/status',
    requireAuth,
    handle((req) => service.status(requireMembrane(req)))
  )

  return router
}
