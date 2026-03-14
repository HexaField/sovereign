// Meeting REST routes — §8.8

import { Router } from 'express'
import type { Request, Response, RequestHandler } from 'express'
import multer from 'multer'
import type { MeetingsService } from './meetings.js'
import type { SpeakerService } from './speakers.js'
import type { ImportHandler } from './import.js'
import type { SummarizationPipeline } from './summarize.js'
import type { RecordingsService } from '../recordings/recordings.js'
import type { TranscriptionQueue } from '../recordings/transcription.js'

export interface MeetingRouteDeps {
  meetings: MeetingsService
  speakers: SpeakerService
  importHandler: ImportHandler
  summarization: SummarizationPipeline
  recordings?: RecordingsService
  transcriptionQueue?: TranscriptionQueue
}

export function registerMeetingRoutes(deps: MeetingRouteDeps): Router {
  const { meetings, speakers, importHandler, summarization, recordings, transcriptionQueue } = deps
  const router = Router()
  const upload = multer({ storage: multer.memoryStorage() })

  // GET /api/orgs/:orgId/meetings — list (paginated, filterable)
  router.get('/api/orgs/:orgId/meetings', (async (req: Request, res: Response) => {
    try {
      const filters = {
        threadKey: req.query.threadKey as string | undefined,
        since: req.query.since as string | undefined,
        until: req.query.until as string | undefined,
        source: req.query.source as 'native' | 'import' | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string) : undefined
      }
      const list = await meetings.list(req.params.orgId, filters)
      res.json(list)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/meetings — create manually
  router.post('/api/orgs/:orgId/meetings', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.create(req.params.orgId, req.body)
      res.status(201).json(meeting)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/meetings/import — import external meeting
  router.post(
    '/api/orgs/:orgId/meetings/import',
    upload.fields([
      { name: 'audio', maxCount: 1 },
      { name: 'transcript', maxCount: 1 }
    ]),
    (async (req: Request, res: Response) => {
      try {
        const files = (req as any).files as Record<string, Express.Multer.File[]> | undefined
        const audioFile = files?.audio?.[0]
        const transcriptFile = files?.transcript?.[0]

        if (!req.body.title) {
          res.status(400).json({ error: 'title is required' })
          return
        }
        if (!audioFile && !transcriptFile) {
          res.status(400).json({ error: 'At least one of audio or transcript file is required' })
          return
        }

        const result = await importHandler.import(req.params.orgId, {
          title: req.body.title,
          threadKey: req.body.threadKey,
          platform: req.body.platform,
          startedAt: req.body.startedAt,
          tags: req.body.tags ? JSON.parse(req.body.tags) : undefined,
          transcriptFilename: transcriptFile?.originalname,
          transcriptContent: transcriptFile?.buffer?.toString('utf-8'),
          audioFilename: audioFile?.originalname,
          audioBuffer: audioFile?.buffer,
          audioMimeType: audioFile?.mimetype
        })

        res.status(201).json(result)
      } catch (err: any) {
        const status = err.status ?? 500
        res.status(status).json({ error: err.message })
      }
    }) as RequestHandler
  )

  // GET /api/orgs/:orgId/meetings/context — aggregated context
  router.get('/api/orgs/:orgId/meetings/context', (async (req: Request, res: Response) => {
    try {
      const since = req.query.since as string | undefined
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined
      const contexts = await summarization.getContext(req.params.orgId, { since, limit })
      res.json({ contexts })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/meetings/:id — detail
  router.get('/api/orgs/:orgId/meetings/:id', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.get(req.params.orgId, req.params.id)
      if (!meeting) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.json(meeting)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // PATCH /api/orgs/:orgId/meetings/:id — update metadata
  router.patch('/api/orgs/:orgId/meetings/:id', (async (req: Request, res: Response) => {
    try {
      const updated = await meetings.update(req.params.orgId, req.params.id, req.body)
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // DELETE /api/orgs/:orgId/meetings/:id
  router.delete('/api/orgs/:orgId/meetings/:id', (async (req: Request, res: Response) => {
    try {
      await meetings.delete(req.params.orgId, req.params.id)
      res.status(204).end()
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/meetings/:id/transcribe — re-trigger transcription
  router.post('/api/orgs/:orgId/meetings/:id/transcribe', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.get(req.params.orgId, req.params.id)
      if (!meeting) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      if (meeting.recordings.length === 0) {
        res.status(400).json({ error: 'No recordings to transcribe' })
        return
      }
      if (transcriptionQueue) {
        for (const recId of meeting.recordings) {
          transcriptionQueue.enqueue(recId, 'high')
        }
      }
      await meetings.update(req.params.orgId, req.params.id, {
        transcript: { status: 'pending' }
      })
      res.json({ status: 'queued' })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // POST /api/orgs/:orgId/meetings/:id/summarize — re-trigger summarization
  router.post('/api/orgs/:orgId/meetings/:id/summarize', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.get(req.params.orgId, req.params.id)
      if (!meeting) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      if (!meeting.transcript?.text) {
        res.status(400).json({ error: 'No transcript available for summarization' })
        return
      }
      await summarization.summarize(req.params.orgId, req.params.id)
      res.json({ status: 'completed' })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // PATCH /api/orgs/:orgId/meetings/:id/speakers — update speaker labels
  router.patch('/api/orgs/:orgId/meetings/:id/speakers', (async (req: Request, res: Response) => {
    try {
      await speakers.setLabels(req.params.orgId, req.params.id, req.body)
      res.json({ status: 'ok' })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/meetings/:id/transcript — full transcript
  router.get('/api/orgs/:orgId/meetings/:id/transcript', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.get(req.params.orgId, req.params.id)
      if (!meeting) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      if (!meeting.transcript) {
        res.status(404).json({ error: 'No transcript' })
        return
      }
      res.json(meeting.transcript)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/meetings/:id/audio — stream merged audio
  router.get('/api/orgs/:orgId/meetings/:id/audio', (async (req: Request, res: Response) => {
    try {
      const meeting = await meetings.get(req.params.orgId, req.params.id)
      if (!meeting) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      if (meeting.recordings.length === 0) {
        res.status(404).json({ error: 'No recordings' })
        return
      }
      // For now, proxy first recording's audio
      if (recordings) {
        const audioPath = recordings.getAudioPath(req.params.orgId, meeting.recordings[0])
        if (audioPath) {
          res.sendFile(audioPath)
          return
        }
      }
      res.status(404).json({ error: 'Audio not available' })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/orgs/:orgId/speakers — org-wide speaker history
  router.get('/api/orgs/:orgId/speakers', (async (req: Request, res: Response) => {
    try {
      const labels = await speakers.getOrgHistory(req.params.orgId)
      res.json(labels)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // Recordings routes (delegate if service provided)
  if (recordings) {
    router.get('/api/orgs/:orgId/recordings', (async (req: Request, res: Response) => {
      try {
        const list = await recordings.list(req.params.orgId)
        res.json(list)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)

    router.get('/api/orgs/:orgId/recordings/:id', (async (req: Request, res: Response) => {
      try {
        const meta = await recordings.get(req.params.orgId, req.params.id)
        if (!meta) {
          res.status(404).json({ error: 'Not found' })
          return
        }
        res.json(meta)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)

    router.get('/api/orgs/:orgId/recordings/:id/audio', (async (req: Request, res: Response) => {
      try {
        const audioPath = recordings.getAudioPath(req.params.orgId, req.params.id)
        if (!audioPath) {
          res.status(404).json({ error: 'Not found' })
          return
        }
        res.sendFile(audioPath)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)

    router.delete('/api/orgs/:orgId/recordings/:id', (async (req: Request, res: Response) => {
      try {
        await recordings.delete(req.params.orgId, req.params.id)
        res.status(204).end()
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)

    router.post('/api/orgs/:orgId/recordings', upload.single('audio'), (async (req: Request, res: Response) => {
      try {
        const file = (req as any).file
        if (!file) {
          res.status(400).json({ error: 'audio file required' })
          return
        }
        const meta = await recordings.create(req.params.orgId, {
          name: req.body?.name || file.originalname || 'recording',
          mimeType: file.mimetype || 'audio/webm',
          audio: file.buffer
        })
        res.status(201).json(meta)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)

    // GET /api/orgs/:orgId/recordings/search — search transcripts
    router.get('/api/orgs/:orgId/recordings/search', (async (req: Request, res: Response) => {
      try {
        const query = req.query.q as string
        if (!query) {
          res.status(400).json({ error: 'q parameter required' })
          return
        }
        const allMeetings = await meetings.list(req.params.orgId, { search: query })
        res.json(
          allMeetings.map((m) => ({
            meetingId: m.id,
            title: m.title,
            transcript: m.transcript?.text?.substring(0, 200)
          }))
        )
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    }) as RequestHandler)
  }

  // GET /api/threads/:key/meetings — meetings bound to a thread
  router.get('/api/threads/:key/meetings', (async (req: Request, res: Response) => {
    try {
      // Thread meetings need orgId — get from query or header
      const orgId = (req.query.orgId as string) ?? (req.headers['x-org-id'] as string)
      if (!orgId) {
        res.status(400).json({ error: 'orgId required' })
        return
      }
      const list = await meetings.list(orgId, { threadKey: req.params.key })
      res.json(list)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  // GET /api/system/transcription/queue — queue status
  router.get('/api/system/transcription/queue', ((_req: Request, res: Response) => {
    try {
      if (!transcriptionQueue) {
        res.json({ pending: 0, active: 0, estimatedWaitMs: 0 })
        return
      }
      res.json(transcriptionQueue.status())
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as RequestHandler)

  return router
}
