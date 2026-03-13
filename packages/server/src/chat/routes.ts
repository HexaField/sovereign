// Chat Module — REST endpoints

import { Router } from 'express'

const router = Router()

router.get('/api/chat/status', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.post('/api/chat/sessions', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

export { router as chatRoutes }
