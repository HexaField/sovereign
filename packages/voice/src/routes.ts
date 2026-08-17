// Voice Module — REST endpoints

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { VoiceModule } from './voice.js'
import multer from 'multer'

export interface VoiceRouteDeps {
  /** Forward transcribed text into the presence pipeline for the agent to process. */
  forwardToPresence?: (
    text: string,
    opts?: { deviceId?: string; deviceName?: string }
  ) => Promise<{ delivered: boolean }>
}

export function createVoiceRoutes(voice: VoiceModule, deps?: VoiceRouteDeps): Router {
  const router = Router()
  const upload = multer({ storage: multer.memoryStorage() })

  router.post('/api/voice/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file
      if (!file) {
        res.status(400).json({ error: 'No audio file provided' })
        return
      }
      const deviceId = req.body?.deviceId as string | undefined
      const deviceName = req.body?.deviceName as string | undefined
      const result = await voice.transcribe(file.buffer, file.mimetype)
      res.json({ text: result.text })

      // Forward transcription into the presence pipeline so the agent sees it.
      // deviceName carries through to the voice-response pipeline so TTS
      // audio routes back to the originating device via sendToDeviceName.
      if (deps?.forwardToPresence && result.text?.trim()) {
        const opts: { deviceId?: string; deviceName?: string } = {}
        if (deviceId) opts.deviceId = deviceId
        if (deviceName) opts.deviceName = deviceName
        deps
          .forwardToPresence(result.text, opts)
          .catch((err: Error) => console.warn('[voice] presence forward failed:', err.message))
      }
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
    const modelDir = join(homedir(), '.sovereign', 'data', 'voice')
    const modelFile = 'wake_word.onnx'
    if (!existsSync(join(modelDir, modelFile))) {
      res.status(404).json({
        error: 'No wake word model available. Train one first: services/wake-word/train.py'
      })
      return
    }
    // Express 5 sendFile requires root option for path resolution
    res.sendFile(modelFile, { root: modelDir })
  })

  // Serve preprocessor models needed for on-device wake word detection.
  // OpenWakeWord uses a 3-stage pipeline: melspectrogram → embedding → wake word.
  // Remote devices (Android, Pi) need all three to run inference locally.
  router.get('/api/voice/wake-model/:name', (req: Request, res: Response) => {
    const allowed = ['melspectrogram.onnx', 'embedding_model.onnx', 'wake_word.onnx']
    const name = req.params.name
    if (!allowed.includes(name)) {
      res.status(400).json({ error: `Unknown model: ${name}` })
      return
    }
    const modelDir = join(homedir(), '.sovereign', 'data', 'voice')
    if (!existsSync(join(modelDir, name))) {
      res.status(404).json({ error: `Model not found: ${name}` })
      return
    }
    res.sendFile(name, { root: modelDir })
  })

  return router
}
