// Recording REST endpoints — §9.4

import { Router } from 'express'
import type { Request, Response, RequestHandler } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import type { RecordingsService } from './recordings.js'

export function registerRecordingRoutes(recordings: RecordingsService): Router {
  const router = Router()
  const upload = multer({ storage: multer.memoryStorage() })

  // GET /api/orgs/:orgId/recordings — list
  router.get('/api/orgs/:orgId/recordings', (async (req: Request, res: Response) => {
    try {
      const list = await recordings.list(req.params.orgId)
      res.json(list)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/recordings — upload
  router.post('/api/orgs/:orgId/recordings', upload.single('audio'), (async (req: Request, res: Response) => {
    try {
      const file = (req as any).file
      if (!file) {
        res.status(400).json({ error: 'audio file is required' })
        return
      }
      const name = (req.body?.name as string) || file.originalname || 'recording'
      const meta = await recordings.create(req.params.orgId, {
        name,
        mimeType: file.mimetype || 'audio/webm',
        audio: file.buffer
      })
      res.status(201).json(meta)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/recordings/:id — metadata
  router.get('/api/orgs/:orgId/recordings/:id', (async (req: Request, res: Response) => {
    try {
      const meta = await recordings.get(req.params.orgId, req.params.id)
      if (!meta) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.json(meta)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/recordings/:id/audio — download
  router.get('/api/orgs/:orgId/recordings/:id/audio', (async (req: Request, res: Response) => {
    try {
      const audioPath = recordings.getAudioPath(req.params.orgId, req.params.id)
      if (!fs.existsSync(audioPath)) {
        res.status(404).json({ error: 'Audio not found' })
        return
      }
      res.sendFile(audioPath)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/recordings/:id/transcript
  router.get('/api/orgs/:orgId/recordings/:id/transcript', (async (req: Request, res: Response) => {
    try {
      const transcript = await recordings.getTranscript(req.params.orgId, req.params.id)
      if (transcript === null) {
        res.status(404).json({ error: 'No transcript available' })
        return
      }
      res.json({ transcript })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // DELETE /api/orgs/:orgId/recordings/:id
  router.delete('/api/orgs/:orgId/recordings/:id', (async (req: Request, res: Response) => {
    try {
      await recordings.delete(req.params.orgId, req.params.id)
      res.status(204).end()
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/recordings/:id/transcribe
  router.post('/api/orgs/:orgId/recordings/:id/transcribe', (async (req: Request, res: Response) => {
    try {
      await recordings.transcribe(req.params.orgId, req.params.id)
      res.json({ status: 'transcription started' })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  return router
}
