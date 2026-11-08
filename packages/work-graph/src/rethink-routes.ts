// Rethink run reports: GET /api/forge/rethink/runs?membrane= (newest first)
// and GET /api/forge/rethink/runs/:id?membrane= (the markdown report).
// POST /api/forge/epics/refine { membrane, prompt } sends the user's epics
// request to the membrane's forge-rethink thread. POST /api/forge/rethink
// (run now) lives in routes.ts.

import express, { Router } from 'express'
import type { RethinkRunner } from './rethink.js'
import { fail, requireMembrane, type Auth } from './routes.js'
import { ForgeError } from './service.js'

export function createRethinkRouter(runner: RethinkRunner, requireAuth: Auth): Router {
  const router = Router()

  router.post('/api/forge/epics/refine', requireAuth, express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const membrane = requireMembrane(req)
      const prompt = req.body?.prompt
      if (typeof prompt !== 'string' || !prompt.trim()) throw new ForgeError('prompt is required', 400)
      res.json(await runner.refine(membrane, prompt))
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/rethink/runs', requireAuth, (req, res) => {
    try {
      const membrane = requireMembrane(req)
      const active = runner.active(membrane)
      res.json({
        membrane,
        threadId: runner.threadOf(membrane) ?? null,
        active: active ? { id: active.id, startedAt: active.startedAt, trigger: active.trigger } : null,
        runs: runner.runs(membrane)
      })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/forge/rethink/runs/:id', requireAuth, (req, res) => {
    try {
      const md = runner.report(requireMembrane(req), String(req.params.id))
      if (md === undefined) return res.status(404).json({ error: 'no such run' })
      res.type('text/markdown').send(md)
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
