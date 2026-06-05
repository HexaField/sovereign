// Sovereign-native cron orchestration. Jobs are persisted via the existing
// `Scheduler` (croner-backed, in `scheduler.ts`) and created via
// `createUserMessageCron`. At fire time the service routes a user-message
// into the bound thread via
// `routing.forSession(threadKey).sendMessage(threadKey, …)`.
//
// Modules outside this file talk to `CronService`, never directly to the
// Scheduler.

import type { EventBus, CronJob, CronRunEntry, BackendRouter } from '@sovereign/core'
import type { Job, Schedule } from './types.js'
import type { Scheduler } from './scheduler.js'

// Local alias retained for backwards compatibility with callers that pass a
// full RoutingBackend (agent-backend's superset interface).
type RoutingBackend = BackendRouter

export type { CronJob, CronRunEntry } from '@sovereign/core'

const SOVEREIGN_CRON_JOB_KIND = 'sovereign.userMessage'

export interface CreateUserMessageCronOpts {
  threadKey: string
  schedule: Schedule
  prompt: string
  label?: string
}

export interface CronService {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
  /** Send a message into a backend session (used by cron-monitor for delivery relay). */
  sendMessage(sessionKey: string, text: string): Promise<void>

  /**
   * Schedule a future user-message into a Sovereign thread. At fire time the
   * cron service resolves `threadKey → backend = routing.forSession(threadKey)`
   * and calls `backend.sendMessage(threadKey, renderedPrompt)`.
   */
  createUserMessageCron(opts: CreateUserMessageCronOpts): { id: string; schedule: string }
}

/** Convert a Schedule to a human-readable label for the chip/UI. */
function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'cron':
      return `cron(${s.expr}${s.tz ? `, ${s.tz}` : ''})`
    case 'interval':
      return `every ${Math.round(s.everyMs / 1000)}s`
    case 'oneshot':
      return `at ${s.at}`
  }
}

/**
 * Format the user-message text actually delivered to the agent. Centralised
 * here so every adapter sees the same envelope.
 */
export function formatCronPrompt(label: string | undefined, prompt: string): string {
  const tag = label ? `[Cron: ${label}]` : '[Cron]'
  return `${tag} ${prompt}`
}

// Bare-UUID scheme: the routing layer keys sessions by bare Thread.id. Coerce
// any legacy compound thread key to its bare id before routing a cron fire.
function canonicalSessionKey(threadKey: string): string {
  if (threadKey === 'agent:main:main') return 'main'
  if (threadKey.startsWith('agent:main:thread:')) return threadKey.slice('agent:main:thread:'.length)
  if (threadKey.startsWith('agent:main:subagent:')) return threadKey.slice('agent:main:subagent:'.length)
  return threadKey
}

export interface CronServiceOptions {
  routing: RoutingBackend
  scheduler?: Scheduler
  bus?: EventBus
}

export function createCronService(opts: CronServiceOptions | RoutingBackend): CronService {
  const config: CronServiceOptions = (opts as any).all
    ? { routing: opts as RoutingBackend }
    : (opts as CronServiceOptions)
  const routing = config.routing
  const scheduler = config.scheduler
  const bus = config.bus

  function listSovereignJobs(): CronJob[] {
    if (!scheduler) return []
    const jobs = scheduler.list()
    return jobs
      .filter((j) => (j.payload?.kind as string | undefined) === SOVEREIGN_CRON_JOB_KIND)
      .map((j) => sovereignJobToCronJob(j))
  }

  function sovereignJobToCronJob(j: Job): CronJob {
    const payload = j.payload as Record<string, unknown>
    const threadKey = payload.threadKey as string
    const sessionKey = canonicalSessionKey(threadKey)
    return {
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      sessionTarget: `session:${sessionKey}`,
      sessionKey,
      delivery: { mode: 'none' },
      payload: {
        kind: 'agentTurn',
        message: payload.prompt as string,
        text: payload.prompt as string
      },
      // Pass schedule through verbatim. The previous projection silently
      // dropped `expr` / `tz` / `everyMs` and renamed `oneshot` → `at`, which
      // broke cron_list introspection AND the cleanup route's
      // `kind === 'oneshot'` filter (scheduler/routes.ts:151).
      schedule: { ...j.schedule },
      deleteAfterRun: j.schedule.kind === 'oneshot'
    }
  }

  // ── Sovereign-native cron delivery loop ─────────────────────────────────
  if (scheduler && bus) {
    bus.on('scheduler.job.due', async (event) => {
      const payload = event.payload as { job?: Job; runId?: string }
      const job = payload.job
      const runId = payload.runId
      if (!job || (job.payload?.kind as string | undefined) !== SOVEREIGN_CRON_JOB_KIND) return
      const threadKey = job.payload.threadKey as string
      const prompt = job.payload.prompt as string
      const label = (job.payload.label as string | undefined) ?? job.name
      const sessionKey = canonicalSessionKey(threadKey)
      const text = formatCronPrompt(label, prompt)
      try {
        await routing.forSession(sessionKey).sendMessage(sessionKey, text)
        bus.emit({
          type: 'scheduler.job.completed',
          timestamp: new Date().toISOString(),
          source: 'cron-service',
          payload: { runId, jobId: job.id, jobName: job.name, summary: prompt.slice(0, 120) }
        })
      } catch (err: any) {
        bus.emit({
          type: 'scheduler.job.failed',
          timestamp: new Date().toISOString(),
          source: 'cron-service',
          payload: { runId, jobId: job.id, jobName: job.name, error: err?.message ?? String(err) }
        })
      }
    })
  }

  return {
    async list(includeDisabled = false) {
      return listSovereignJobs().filter((j) => includeDisabled || j.enabled !== false)
    },
    async runs(jobId?: string) {
      const sovereign: CronRunEntry[] = scheduler
        ? scheduler
            .list()
            .filter((j) => (j.payload?.kind as string | undefined) === SOVEREIGN_CRON_JOB_KIND)
            .flatMap((j) =>
              scheduler.runs(j.id).map((r) => ({
                ts: Date.parse(r.startedAt) || Date.now(),
                jobId: r.jobId,
                action: 'fire',
                status: r.status === 'completed' ? 'ok' : r.status,
                error: r.error,
                summary: undefined,
                durationMs: r.completedAt ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : undefined,
                jobName: j.name
              }))
            )
        : []
      return jobId ? sovereign.filter((r) => r.jobId === jobId) : sovereign
    },
    async update(id, patch) {
      if (!scheduler || !scheduler.get(id)) throw new Error(`cron: unknown job '${id}'`)
      return scheduler.update(id, patch as Partial<Job>)
    },
    async remove(id) {
      if (!scheduler || !scheduler.get(id)) throw new Error(`cron: unknown job '${id}'`)
      scheduler.remove(id)
    },
    async sendMessage(sessionKey, text) {
      const target = routing.forSession(sessionKey)
      await target.sendMessage(sessionKey, text)
    },
    createUserMessageCron(input) {
      if (!scheduler) throw new Error('cron: Sovereign-native scheduler not available')
      const job = scheduler.add({
        name: input.label ?? `cron:${input.threadKey}`,
        schedule: input.schedule,
        enabled: true,
        payload: {
          kind: SOVEREIGN_CRON_JOB_KIND,
          threadKey: input.threadKey,
          prompt: input.prompt,
          label: input.label ?? null
        }
      })
      return { id: job.id, schedule: describeSchedule(input.schedule) }
    }
  }
}
