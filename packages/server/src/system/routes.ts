// System REST endpoints: GET /api/system/architecture, GET /api/system/health

import { Router } from 'express'
import type { SystemModule } from './system.js'

export function createSystemRoutes(system: SystemModule): Router {
  const router = Router()

  router.get('/api/system/architecture', (_req, res) => {
    res.json(system.getArchitecture())
  })

  router.get('/api/system/health', (_req, res) => {
    res.json(system.getHealth())
  })

  return router
}
