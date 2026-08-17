// Voice Module — REST endpoints

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { VoiceModule } from './voice.js'
import multer from 'multer'

export function createVoiceRoutes(voice: VoiceModule): Router {
  const router = Router()
  const upload = multer({ storage: multer.memoryStorage() })

  router.post('/api/voice/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
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

  // Serve the trained wake word model for remote devices (Android, Pi)
  router.get('/api/voice/wake-model', (_req: Request, res: Response) => {
    const modelPath = join(homedir(), '.sovereign', 'data', 'voice', 'wake_word.onnx')
    if (!existsSync(modelPath)) {
      res.status(404).json({
        error: 'No wake word model available. Train one first: services/wake-word/train.py'
      })
      return
    }
    res.sendFile(modelPath)
  })

  return router
}
