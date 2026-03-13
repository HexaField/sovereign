// Threads — REST API endpoints

import { Router } from 'express'

const router = Router()

router.get('/api/threads', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.get('/api/threads/:key', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.post('/api/threads', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.delete('/api/threads/:key', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.post('/api/threads/:key/entities', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.delete('/api/threads/:key/entities/:entityType/:entityRef', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.post('/api/threads/:key/forward', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.get('/api/threads/:key/events', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

export { router as threadRoutes }
