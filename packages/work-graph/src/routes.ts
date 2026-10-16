// Forge REST routes.

import express, { Router, type Request, type Response } from 'express'
import type { ForgeView, WorkEdgeKind } from '@sovereign/core'
import { ForgeError, type ForgeService } from './service.js'

type Auth = (req: Request, res: Response, next: () => void) => void

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

function fail(res: Response, err: unknown) {
  if (err instanceof ForgeError) return res.status(err.status).json({ error: err.message })
  const msg = (err as Error)?.message ?? String(err)
  // TaskPort errors name a missing task or a bad link.
  if (/not found/i.test(msg)) return res.status(404).json({ error: msg })
  if (/cycle|own parent|not a work stream/i.test(msg)) return res.status(400).json({ error: msg })
  return res.status(500).json({ error: msg })
}

function membraneOf(req: Request, res: Response): string | undefined {
  const m = str(req.query.membrane) ?? str(req.body?.membrane)
  if (!m) res.status(400).json({ error: 'membrane is required' })
  return m
}

export function createForgeRouter(service: ForgeService, requireAuth: Auth): Router {
  const router = Router()
  const json = express.json({ limit: '1mb' })

  router.get('/api/forge', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json(
        await service.graph(membrane, {
          ...(str(req.query.view) ? { view: str(req.query.view) } : {}),
          ...(str(req.query.since) ? { since: str(req.query.since) } : {}),
          ...(str(req.query.until) ? { until: str(req.query.until) } : {})
        })
      )
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/search', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    const q = str(req.query.q)
    if (!q) return res.status(400).json({ error: 'q is required' })
    try {
      res.json(await service.search(membrane, q))
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/overlay', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json(await service.overlay(membrane))
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/forge/sync', requireAuth, json, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json({ membrane, ...(await service.sync(membrane, 'all')) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/forge/rethink', requireAuth, json, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json({ membrane, ...(await service.rethink(membrane)) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/digest', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json(await service.digest(membrane, str(req.query.since)))
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/events', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      const since = str(req.query.since)
      res.json({ events: service.events(membrane, since ? { since } : {}) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/forge/assign', requireAuth, json, async (req, res) => {
    const b = req.body ?? {}
    const nodeId = str(b.nodeId)
    if (!nodeId) return res.status(400).json({ error: 'nodeId is required' })
    if (b.threadId !== undefined && b.threadId !== null && typeof b.threadId !== 'string') {
      return res.status(400).json({ error: 'threadId must be a string or null' })
    }
    if (b.newThread !== undefined && (typeof b.newThread !== 'object' || b.newThread === null)) {
      return res.status(400).json({ error: 'newThread must be { label }' })
    }
    if (b.prompt !== undefined && typeof b.prompt !== 'string')
      return res.status(400).json({ error: 'prompt must be a string' })
    try {
      res.json(
        await service.assign({
          nodeId,
          ...(str(b.membrane)
            ? { membrane: str(b.membrane) }
            : str(req.query.membrane)
              ? { membrane: str(req.query.membrane) }
              : {}),
          ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
          ...(b.newThread
            ? { newThread: typeof b.newThread.label === 'string' ? { label: b.newThread.label } : {} }
            : {}),
          ...(b.prompt !== undefined ? { prompt: b.prompt } : {})
        })
      )
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/views', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json({ views: await service.getViews(membrane) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.put('/api/forge/views', requireAuth, json, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    const views = req.body?.views
    if (!Array.isArray(views) || views.some((v) => typeof v !== 'object' || v === null)) {
      return res.status(400).json({ error: 'views must be an array of views' })
    }
    try {
      res.json({ views: await service.putViews(membrane, views as ForgeView[]) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/forge/streams', requireAuth, json, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    const name = str(req.body?.name)
    if (!name) return res.status(400).json({ error: 'name is required' })
    const parentId = req.body?.parentId
    if (parentId !== undefined && typeof parentId !== 'string')
      return res.status(400).json({ error: 'parentId must be a string' })
    try {
      res.status(201).json(await service.createStream(membrane, name, parentId))
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/forge/streams/:id/members', requireAuth, json, async (req, res) => {
    const nodeId = str(req.body?.nodeId)
    if (!nodeId) return res.status(400).json({ error: 'nodeId is required' })
    try {
      res.json(
        await service.addMember(String(req.params.id), nodeId, str(req.body?.membrane) ?? str(req.query.membrane))
      )
    } catch (err) {
      fail(res, err)
    }
  })

  router.delete('/api/forge/streams/:id/members', requireAuth, json, async (req, res) => {
    const nodeId = str(req.body?.nodeId) ?? str(req.query.nodeId)
    if (!nodeId) return res.status(400).json({ error: 'nodeId is required' })
    try {
      const removed = await service.removeMember(
        String(req.params.id),
        nodeId,
        str(req.body?.membrane) ?? str(req.query.membrane)
      )
      if (!removed) return res.status(404).json({ error: 'not a member of this stream' })
      res.json({ removed })
    } catch (err) {
      fail(res, err)
    }
  })

  const edgeParams = (req: Request, res: Response) => {
    const kind = String(req.params.kind) as WorkEdgeKind
    if (!EDGE_KINDS.includes(kind)) {
      res.status(400).json({ error: `unknown edge kind: ${kind}` })
      return undefined
    }
    return { from: String(req.params.from), to: String(req.params.to), kind }
  }

  router.post('/api/forge/edges/:from/:to/:kind/accept', requireAuth, json, async (req, res) => {
    const e = edgeParams(req, res)
    if (!e) return
    try {
      const ok = await service.acceptEdge(e.from, e.to, e.kind, str(req.query.membrane) ?? str(req.body?.membrane))
      if (!ok) return res.status(404).json({ error: 'no such suggested edge' })
      res.json({ accepted: true })
    } catch (err) {
      fail(res, err)
    }
  })

  router.delete('/api/forge/edges/:from/:to/:kind', requireAuth, async (req, res) => {
    const e = edgeParams(req, res)
    if (!e) return
    try {
      const ok = await service.deleteEdge(e.from, e.to, e.kind, str(req.query.membrane))
      if (!ok) return res.status(404).json({ error: 'no such suggested edge' })
      res.json({ deleted: true })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/status', requireAuth, async (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    try {
      res.json(await service.status(membrane))
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
