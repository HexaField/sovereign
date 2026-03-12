// Config REST API router

import { Router, type Request } from 'express'
import type { ConfigStore } from './types.js'

export function createConfigRouter(configStore: ConfigStore): Router {
  const router = Router()

  // GET /api/config — full resolved config
  router.get('/', (_req, res) => {
    res.json(configStore.get())
  })

  // GET /api/config/schema — JSON Schema
  router.get('/schema', (_req, res) => {
    res.json(configStore.getSchema())
  })

  // GET /api/config/history — change history with pagination
  router.get('/history', (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const offset = req.query.offset ? Number(req.query.offset) : undefined
    res.json(configStore.getHistory({ limit, offset }))
  })

  // POST /api/config/export
  router.post('/export', (_req, res) => {
    res.json(configStore.exportConfig())
  })

  // POST /api/config/import
  router.post('/import', (req, res) => {
    try {
      configStore.importConfig(req.body)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // PATCH /api/config — partial update
  router.patch('/', (req, res) => {
    try {
      configStore.patch(req.body)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // GET /api/config/:path — namespaced read (must be after /schema, /history, /export, /import)
  router.get('/*path', (req: Request<{ path: string }>, res) => {
    const value = configStore.get(req.params.path)
    if (value === undefined) {
      res.status(404).json({ error: 'Config path not found' })
    } else {
      res.json(value)
    }
  })

  return router
}
