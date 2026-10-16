// Forge REST routes.

import express, { Router, type Request, type Response } from 'express'
import type { ForgeView, WorkEdgeKind } from '@sovereign/core'
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
  'related'
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
        ...(str(req.query.until) ? { until: str(req.query.until) } : {})
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
