// Voice Module — REST endpoints

import { Router } from 'express'

const router = Router()

router.post('/api/voice/transcribe', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

router.post('/api/voice/tts', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})

export { router as voiceRoutes }
