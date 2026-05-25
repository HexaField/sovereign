import { Router, type Request, type Response } from 'express'
import type { Scheduler } from './scheduler.js'
import type { CronService } from './cron-service.js'

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

  if (cronService) registerCronManagementRoutes(router, cronService)

  return router
}

/** Derive threadKey from a cron job's sessionTarget or sessionKey. */
function deriveThreadKey(sessionTarget?: string, sessionKey?: string): string | null {
  for (const val of [sessionTarget, sessionKey]) {
    if (!val) continue
    const sessionMatch = val.match(/^session:agent:main:thread:(.+)$/)
    if (sessionMatch) return sessionMatch[1]
    const agentMatch = val.match(/^agent:main:thread:(.+)$/)
    if (agentMatch) return agentMatch[1]
  }
  return null
}

/** Detect well-known issues with a cron job's configuration. */
function detectCronIssues(job: any): string[] {
  const issues: string[] = []
  if (!job.delivery?.channel) {
    issues.push('missing-channel')
  }
  const target = job.sessionTarget || ''
  const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
  if ((target === 'isolated' || target === 'main') && !threadKey) {
    issues.push('wrong-session-target')
  }
  if (threadKey && job.payload?.kind === 'systemEvent') {
    issues.push('system-event-on-thread')
  }
  if (job.enabled === false && job.state?.lastStatus === 'error') {
    issues.push('disabled-after-error')
  }
  if (job.delivery?.channel === 'webchat' && job.delivery?.mode === 'announce') {
    issues.push('no-delivery-channels')
  }
  return issues
}

export function registerCronManagementRoutes(router: Router, cronService: CronService): void {
  // GET /api/crons — list ALL cron jobs with issue detection + threadKey derivation
  router.get('/api/crons', async (_req, res) => {
    try {
      const jobs = await Promise.race([
        cronService.list(true),
        new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('cron list timeout')), 5000))
      ]).catch(() => [] as any[])
      const annotated = jobs.map((j: any) => ({
        ...j,
        threadKey: deriveThreadKey(j.sessionTarget, j.sessionKey),
        issues: detectCronIssues(j)
      }))
      res.json({ crons: annotated })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/crons/:id — update a cron job
  router.patch('/api/crons/:id', async (req, res) => {
    try {
      const result = await cronService.update(req.params.id, req.body)
      res.json({ ok: true, cron: result })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/crons/cleanup — bulk remove disabled+errored+past crons
  router.delete('/api/crons/cleanup', async (_req, res) => {
    try {
      const jobs = await cronService.list(true)
      const toRemove = jobs.filter((j: any) => {
        if (j.enabled === false && j.state?.lastStatus === 'error') return true
        if (j.enabled === false && j.deleteAfterRun === true) return true
        if (j.schedule?.kind === 'oneshot' && j.schedule?.at) {
          const atMs = new Date(j.schedule.at).getTime()
          if (!isNaN(atMs) && atMs < Date.now()) return true
        }
        return false
      })
      let removed = 0
      for (const job of toRemove) {
        try {
          await cronService.remove(job.id)
          removed++
        } catch {
          /* keep going */
        }
      }
      res.json({ ok: true, removed, total: toRemove.length })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/crons/:id — remove a cron job
  router.delete('/api/crons/:id', async (req, res) => {
    try {
      await cronService.remove(req.params.id)
      res.json({ ok: true })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/crons/:id/fix-thread — one-click fix to pin cron to a thread
  router.post('/api/crons/:id/fix-thread', async (req, res) => {
    try {
      const { threadKey } = req.body
      if (!threadKey) {
        return res.status(400).json({ error: 'threadKey is required' })
      }
      const jobs = await cronService.list(true)
      const job = jobs.find((j: any) => j.id === req.params.id)
      if (!job) {
        return res.status(404).json({ error: 'Cron job not found' })
      }
      const patch: Record<string, unknown> = {
        sessionTarget: `session:agent:main:thread:${threadKey}`,
        sessionKey: `agent:main:thread:${threadKey}`,
        delivery: { mode: 'none' },
        enabled: true
      }
      const result = await cronService.update(req.params.id, patch)
      res.json({ ok: true, cron: result })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/crons/:id/toggle — enable/disable toggle
  router.post('/api/crons/:id/toggle', async (req, res) => {
    try {
      const jobs = await cronService.list(true)
      const job = jobs.find((j: any) => j.id === req.params.id)
      if (!job) {
        return res.status(404).json({ error: 'Cron job not found' })
      }
      const result = await cronService.update(req.params.id, { enabled: !job.enabled })
      res.json({ ok: true, cron: result })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/crons/channel-status — check if any delivery channels are configured
  router.get('/api/crons/channel-status', async (_req, res) => {
    try {
      const jobs = await Promise.race([
        cronService.list(true),
        new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]).catch(() => [] as any[])
      const channels = new Set<string>()
      for (const j of jobs) {
        if (j.delivery?.channel) channels.add(j.delivery.channel)
      }
      const realChannels = [...channels].filter((c) => c !== 'webchat')
      const hasRealChannels = realChannels.length > 0
      res.json({
        hasRealChannels,
        channels: [...channels],
        realChannels,
        warning: hasRealChannels
          ? null
          : 'No messaging channels configured. Cron delivery via "webchat" only works during active browser sessions. Configure Telegram, Discord, or another channel for reliable delivery.'
      })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/crons/runs — get cron run history, optionally filtered by thread
  router.get('/api/crons/runs', async (req, res) => {
    try {
      const threadKeyFilter = req.query.threadKey as string | undefined
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
      const entries = await cronService.runs()

      if (!threadKeyFilter) {
        return res.json({ entries: entries.slice(0, limit) })
      }

      const jobs = await cronService.list(true)
      const jobThreadMap = new Map<string, string | null>()
      for (const job of jobs) {
        jobThreadMap.set(job.id, deriveThreadKey(job.sessionTarget, job.sessionKey))
      }
      const filtered = entries.filter((e: any) => jobThreadMap.get(e.jobId) === threadKeyFilter)
      res.json({ entries: filtered.slice(0, limit) })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })
}

export { deriveThreadKey, detectCronIssues }
