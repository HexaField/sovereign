// Voice Module — REST endpoints

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { VoiceModule } from './voice.js'
import multer from 'multer'

export function createVoiceRoutes(voice: VoiceModule): Router {
  const router = Router()
  const upload = multer({ storage: multer.memoryStorage() })

  router.post('/api/voice/transcribe', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file
      if (!file) {
        res.status(400).json({ error: 'No audio file provided' })
        return
      }
      const result = await voice.transcribe(file.buffer, file.mimetype)
      res.json({ text: result.text })
    } catch (err: any) {
      if (err.message === 'No transcription URL configured') {
        res.status(503).json({ error: 'Transcription service not configured' })
        return
      }
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/api/voice/tts', async (req: Request, res: Response) => {
    try {
      const { text, voice: voiceName, deviceId } = req.body ?? {}
      if (!text) {
        res.status(400).json({ error: 'No text provided' })
        return
      }
      const result = await voice.synthesize(text, voiceName)
      res.set('Content-Type', 'audio/wav')
      if (deviceId) res.set('X-Device-Id', deviceId)
      res.send(result.audio)
    } catch (err: any) {
      if (err.message === 'No TTS URL configured') {
        res.status(503).json({ error: 'TTS service not configured' })
        return
      }
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

// Legacy export for backward compat
const router = Router()
router.post('/api/voice/transcribe', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})
router.post('/api/voice/tts', (_req, res) => {
  res.status(501).json({ error: 'not implemented' })
})
export { router as voiceRoutes }
