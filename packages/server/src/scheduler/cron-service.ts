// Sovereign-native cron orchestration. Combines two sources:
//
// 1. **Sovereign-managed jobs** — persisted via the existing `Scheduler`
//    (croner-backed, in `scheduler.ts`). Created via `createUserMessageCron`.
//    At fire time the service routes a user-message into the bound thread
//    via `routing.forSession(threadKey).sendMessage(threadKey, …)`. Works
//    identically across OpenClaw, Pi, and Claude Code threads.
//
// 2. **Backend-managed jobs** — OpenClaw's gateway-side cron bridge. Kept as
//    a pass-through so existing OpenClaw deployments don't lose their cron
//    surface.
//
// Modules outside this file talk to `CronService`, never directly to a
// backend's cron RPC or the Scheduler.

import type { EventBus } from '@sovereign/core'
import type { RoutingBackend } from '../agent-backend/factory.js'
import type { OpenClawBackend } from '../agent-backend/openclaw/openclaw.js'
import type { CronJob, CronRunEntry } from '../agent-backend/openclaw/cron-bridge.js'
import type { Job, Schedule } from './types.js'
import type { Scheduler } from './scheduler.js'

export type { CronJob, CronRunEntry } from '../agent-backend/openclaw/cron-bridge.js'

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
  /** Detect whether a backend-managed cron job needs an auto-fix patch. */
  needsAutoFix(job: CronJob): boolean
  /** Build a patch that converts a broken job to the working delivery pattern. */
  buildFixPatch(job: CronJob): Record<string, unknown>
  /** Send a message into a backend session (used by cron-monitor for delivery relay). */
  sendMessage(sessionKey: string, text: string): Promise<void>

  /**
   * Schedule a future user-message into a Sovereign thread. At fire time the
   * cron service resolves `threadKey → backend = routing.forSession(threadKey)`
   * and calls `backend.sendMessage(threadKey, renderedPrompt)`.
   */
  createUserMessageCron(opts: CreateUserMessageCronOpts): { id: string; schedule: string }
}

function openClaw(routing: RoutingBackend): OpenClawBackend | undefined {
  return routing.forKind('openclaw') as OpenClawBackend | undefined
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

function canonicalSessionKey(threadKey: string): string {
  if (threadKey.startsWith('agent:')) return threadKey
  if (threadKey === 'main') return 'agent:main:main'
  return `agent:main:thread:${threadKey}`
}

export interface CronServiceOptions {
  routing: RoutingBackend
  scheduler?: Scheduler
  bus?: EventBus
}

export function createCronService(opts: CronServiceOptions | RoutingBackend): CronService {
  const config: CronServiceOptions = (opts as RoutingBackend).all
    ? { routing: opts as RoutingBackend }
    : (opts as CronServiceOptions)
  const routing = config.routing
  const scheduler = config.scheduler
  const bus = config.bus

  function bridge() {
    const oc = openClaw(routing)
    if (!oc) return null
    return oc.cronBridge
  }

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
      schedule: j.schedule.kind === 'oneshot' ? { kind: 'at', at: j.schedule.at } : { kind: j.schedule.kind },
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
      const sovereign = listSovereignJobs().filter((j) => includeDisabled || j.enabled !== false)
      const b = bridge()
      if (!b) return sovereign
      const backend = await b.list(includeDisabled)
      return [...sovereign, ...backend]
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
      const sovereignFiltered = jobId ? sovereign.filter((r) => r.jobId === jobId) : sovereign
      const b = bridge()
      if (!b) return sovereignFiltered
      const backend = await b.runs(jobId)
      return [...sovereignFiltered, ...backend]
    },
    async update(id, patch) {
      if (scheduler && scheduler.get(id)) {
        return scheduler.update(id, patch as Partial<Job>)
      }
      const b = bridge()
      if (!b) throw new Error('cron: no backend-managed cron available')
      return await b.update(id, patch)
    },
    async remove(id) {
      if (scheduler && scheduler.get(id)) {
        scheduler.remove(id)
        return
      }
      const b = bridge()
      if (!b) throw new Error('cron: no backend-managed cron available')
      await b.remove(id)
    },
    needsAutoFix(job) {
      const b = bridge()
      if (!b) return false
      return b.needsAutoFix(job)
    },
    buildFixPatch(job) {
      const b = bridge()
      if (!b) return {}
      return b.buildFixPatch(job)
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
