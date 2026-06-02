// Membranes — REST routes mounted at `/api`.

import { Router } from 'express'
import type { MembraneManager } from './membranes.js'

export function createMembraneRoutes(
  manager: MembraneManager,
  authMiddleware: (req: any, res: any, next: any) => void
): Router {
  const router = Router()
  router.use(authMiddleware)

  router.get('/membranes', (_req, res) => {
    res.json({ membranes: manager.listMembranes() })
  })

  router.post('/membranes', (req, res) => {
    try {
      const m = manager.createMembrane(req.body)
      res.status(201).json(m)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/membranes/:id', (req, res) => {
    const m = manager.getMembrane(req.params.id)
    if (!m) return res.status(404).json({ error: 'Not found' })
    res.json(m)
  })

  router.put('/membranes/:id', (req, res) => {
    try {
      const m = manager.updateMembrane(req.params.id, req.body)
      res.json(m)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/membranes/:id', (req, res) => {
    try {
      manager.deleteMembrane(req.params.id)
      res.status(204).send()
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/membranes/:id/workspaces/:orgId', (req, res) => {
    try {
      const m = manager.addWorkspace(req.params.id, req.params.orgId)
      res.json(m)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/membranes/:id/workspaces/:orgId', (req, res) => {
    try {
      const m = manager.removeWorkspace(req.params.id, req.params.orgId)
      res.json(m)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  return router
}
