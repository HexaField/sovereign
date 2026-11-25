import { Router, type Request, type Response } from 'express'
import type { Scheduler } from './scheduler.js'
import type { Job } from './types.js'
import {
  toStoredPatch,
  CronNotFoundError,
  CronValidationError,
  SOVEREIGN_CRON_JOB_KIND,
  type CronService
} from './cron-service.js'

const CRON_ONLY = 'cron jobs are created and edited through /api/crons'

/** A cron's target and prompt change only through the cron service, which checks the thread. */
const CRON_OWNED_FIELDS = ['payload', 'sessionKey', 'sessionTarget', 'threadKey', 'prompt']

/** 400 for a caller's mistake, 404 for an unknown cron, else 500. */
function failure(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const status = err instanceof CronNotFoundError ? 404 : err instanceof CronValidationError ? 400 : 500
  res.status(status).json({ error: message })
}

export function createSchedulerRoutes(scheduler: Scheduler, cronService?: CronService): Router {
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
      if (payload?.kind === SOVEREIGN_CRON_JOB_KIND) return res.status(400).json({ error: CRON_ONLY })
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
    const existing = scheduler.get(req.params.id)
    if (!existing) return res.status(404).json({ error: `Job '${req.params.id}' not found` })
    try {
      if (existing.payload?.kind === SOVEREIGN_CRON_JOB_KIND && CRON_OWNED_FIELDS.some((f) => f in req.body)) {
        return res.status(400).json({ error: CRON_ONLY })
      }
      res.json(scheduler.update(req.params.id, toStoredPatch(existing, req.body) as Partial<Job>))
    } catch (err: any) {
      res.status(400).json({ error: err.message })
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

  if (cronService) registerCronManagementRoutes(router, cronService)

  return router
}

export function registerCronManagementRoutes(router: Router, cronService: CronService): void {
  // GET /api/crons — list every cron, each with its threadKey, next run and last result
  router.get('/api/crons', async (_req, res) => {
    try {
      const crons = await Promise.race([
        cronService.list(true),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cron list timeout')), 5000))
      ]).catch(() => [])
      res.json({ crons })
    } catch (err) {
      failure(res, err)
    }
  })

  // POST /api/crons — create a cron on one thread. 400 without a threadKey or for a thread that does not exist.
  router.post('/api/crons', async (req, res) => {
    try {
      const { threadKey, name, schedule, prompt } = req.body ?? {}
      if (typeof threadKey !== 'string' || !threadKey.trim()) {
        return res.status(400).json({ error: 'threadKey is required' })
      }
      const { id } = cronService.createUserMessageCron({
        threadKey,
        schedule,
        prompt,
        label: typeof name === 'string' && name.trim() ? name.trim() : undefined
      })
      const cron = (await cronService.list(true)).find((j) => j.id === id)
      res.status(201).json({ ok: true, cron })
    } catch (err) {
      failure(res, err)
    }
  })

  // PATCH /api/crons/:id — edit name, schedule, prompt, enabled or threadKey
  router.patch('/api/crons/:id', async (req, res) => {
    try {
      const result = await cronService.update(req.params.id, req.body ?? {})
      res.json({ ok: true, cron: result })
    } catch (err) {
      failure(res, err)
    }
  })

  // POST /api/crons/:id/run — fire a cron now
  router.post('/api/crons/:id/run', async (req, res) => {
    try {
      await cronService.run(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      failure(res, err)
    }
  })

  // DELETE /api/crons/:id — remove a cron
  router.delete('/api/crons/:id', async (req, res) => {
    try {
      await cronService.remove(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      failure(res, err)
    }
  })

  // GET /api/crons/runs — run history, optionally for one thread
  router.get('/api/crons/runs', async (req, res) => {
    try {
      const threadKeyFilter = req.query.threadKey as string | undefined
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
      const entries = await cronService.runs()

      if (!threadKeyFilter) {
        return res.json({ entries: entries.slice(0, limit) })
      }

      const jobs = await cronService.list(true)
      const jobThreadMap = new Map(jobs.map((job) => [job.id, job.threadKey]))
      const filtered = entries.filter((e) => jobThreadMap.get(e.jobId) === threadKeyFilter)
      res.json({ entries: filtered.slice(0, limit) })
    } catch (err) {
      failure(res, err)
    }
  })
}
