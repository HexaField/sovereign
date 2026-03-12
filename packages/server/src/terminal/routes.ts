import { Router } from 'express'
import type { TerminalManager } from './terminal.js'

export function createTerminalRoutes(manager: TerminalManager): Router {
  const router = Router()

  router.get('/sessions', (_req, res) => {
    res.json(manager.list())
  })

  router.get('/sessions/:id', (req, res) => {
    const session = manager.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(session)
  })

  router.delete('/sessions/:id', (req, res) => {
    const session = manager.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'not found' })
      return
    }
    manager.close(req.params.id)
    res.json({ ok: true })
  })

  router.post('/sessions', (req, res) => {
    try {
      const { cwd, shell, cols, rows } = req.body ?? {}
      const session = manager.create({ cwd, shell, cols, rows })
      res.status(201).json(session)
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'failed' })
    }
  })

  return router
}
