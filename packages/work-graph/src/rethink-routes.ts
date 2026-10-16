// Rethink run reports: GET /api/forge/rethink/runs?membrane= (newest first)
// and GET /api/forge/rethink/runs/:id?membrane= (the markdown report).
// POST /api/forge/rethink (run now) lives in routes.ts.

import { Router, type Request, type Response } from 'express'
import type { RethinkRunner } from './rethink.js'

type Auth = (req: Request, res: Response, next: () => void) => void

export function createRethinkRouter(runner: RethinkRunner, requireAuth: Auth): Router {
  const router = Router()
  const membraneOf = (req: Request, res: Response): string | undefined => {
    const m = typeof req.query.membrane === 'string' && req.query.membrane.trim() ? req.query.membrane : undefined
    if (!m) res.status(400).json({ error: 'membrane is required' })
    return m
  }

  router.get('/api/forge/rethink/runs', requireAuth, (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    const active = runner.active(membrane)
    res.json({
      membrane,
      threadId: runner.threadOf(membrane) ?? null,
      active: active ? { id: active.id, startedAt: active.startedAt, trigger: active.trigger } : null,
      runs: runner.runs(membrane)
    })
  })

  router.get('/api/forge/rethink/runs/:id', requireAuth, (req, res) => {
    const membrane = membraneOf(req, res)
    if (!membrane) return
    const md = runner.report(membrane, String(req.params.id))
    if (md === undefined) return res.status(404).json({ error: 'no such run' })
    res.type('text/markdown').send(md)
  })

  return router
}
