import { Router, type Request, type Response } from 'express'
import type { Scheduler } from './scheduler.js'

export function createSchedulerRoutes(scheduler: Scheduler): Router {
  const router = Router()

  // GET /api/jobs — list all jobs
  router.get('/api/jobs', (_req: Request, res: Response) => {
    const filter: { tags?: string[]; enabled?: boolean } = {}
    const { tags, enabled } = _req.query
    if (typeof enabled === 'string') filter.enabled = enabled === 'true'
    if (typeof tags === 'string') filter.tags = tags.split(',')
    res.json(scheduler.list(Object.keys(filter).length ? filter : undefined))
  })

  // GET /api/jobs/:id — get single job
  router.get('/api/jobs/:id', (req: Request, res: Response) => {
    const job = scheduler.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({ ...job, nextRun: scheduler.nextRun(job.id), runs: scheduler.runs(job.id, 10) })
  })

  // POST /api/jobs — create job
  router.post('/api/jobs', (req: Request, res: Response) => {
    try {
      const { name, schedule, payload, enabled, tags, concurrency, deleteAfterRun } = req.body
      if (!name || !schedule) return res.status(400).json({ error: 'name and schedule are required' })
      const job = scheduler.add({
        name,
        schedule,
        payload: payload ?? {},
        enabled: enabled ?? true,
        tags,
        concurrency,
        deleteAfterRun
      })
      res.status(201).json(job)
    } catch (err: any) {
      res.status(400).json({ error: err.message })
    }
  })

  // PATCH /api/jobs/:id — update job
  router.patch('/api/jobs/:id', (req: Request, res: Response) => {
    try {
      const job = scheduler.update(req.params.id, req.body)
      res.json(job)
    } catch (err: any) {
      res.status(404).json({ error: err.message })
    }
  })

  // DELETE /api/jobs/:id — delete job
  router.delete('/api/jobs/:id', (req: Request, res: Response) => {
    try {
      scheduler.remove(req.params.id)
      res.status(204).end()
    } catch (err: any) {
      res.status(404).json({ error: err.message })
    }
  })

  // POST /api/jobs/:id/run — trigger immediate run
  router.post('/api/jobs/:id/run', (req: Request, res: Response) => {
    try {
      scheduler.trigger(req.params.id)
      res.json({ ok: true })
    } catch (err: any) {
      res.status(404).json({ error: err.message })
    }
  })

  return router
}
