// Loop 2's schedule: one system job per (membrane, time) in the server's
// scheduler (packages/scheduler), cron "MM HH * * *" in local time. The jobs
// are reconciled, not re-created: at start, on a forge config change and
// every few minutes (membranes come and go), so a job that already exists
// keeps its run history. A due job runs service.rethink(membrane, schedule).

import type { BusEvent, EventBus } from '@sovereign/core'
import type { ForgeService } from './service.js'

export const RETHINK_JOB_KIND = 'forge-rethink'

/** The slice of @sovereign/scheduler's Scheduler this needs. */
export interface RethinkJobPort {
  list(): Array<{ id: string; payload: Record<string, unknown> }>
  add(job: {
    name: string
    schedule: { kind: 'cron'; expr: string }
    payload: Record<string, unknown>
    enabled: boolean
    tags?: string[]
  }): { id: string }
  remove(id: string): void
}

/** "08:30" → "30 8 * * *"; undefined for anything that is not HH:MM. */
export function cronExprFor(time: string): string | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  return m ? `${Number(m[2])} ${Number(m[1])} * * *` : undefined
}

/** Make the scheduler hold exactly one job per (membrane, valid time). */
export function reconcileRethinkJobs(
  port: RethinkJobPort,
  membranes: string[],
  times: string[]
): { added: number; removed: number } {
  const want = new Map<string, { membrane: string; time: string; expr: string }>()
  for (const membrane of membranes) {
    for (const time of times) {
      const expr = cronExprFor(time)
      if (expr) want.set(`${membrane}@${time.trim()}`, { membrane, time: time.trim(), expr })
    }
  }
  let removed = 0
  const have = new Set<string>()
  for (const j of port.list()) {
    if (j.payload?.kind !== RETHINK_JOB_KIND) continue
    const key = `${String(j.payload.membrane)}@${String(j.payload.time)}`
    const w = want.get(key)
    if (!w || have.has(key) || j.payload.expr !== w.expr) {
      port.remove(j.id)
      removed++
      continue
    }
    have.add(key)
  }
  let added = 0
  for (const [key, w] of want) {
    if (have.has(key)) continue
    port.add({
      name: `forge-rethink ${w.membrane} ${w.time}`,
      schedule: { kind: 'cron', expr: w.expr },
      payload: { kind: RETHINK_JOB_KIND, membrane: w.membrane, time: w.time, expr: w.expr },
      enabled: true,
      tags: ['system', 'forge']
    })
    added++
  }
  return { added, removed }
}

export interface RethinkScheduleDeps {
  scheduler: RethinkJobPort
  bus: Pick<EventBus, 'on' | 'emit'>
  service: () => Pick<ForgeService, 'config' | 'membranes' | 'rethink'>
  /** Re-reconcile interval (membranes appear and go). Default 5 min. */
  everyMs?: number
  log?: (msg: string) => void
}

/** Start the schedule; returns the stop. */
export function startRethinkSchedule(deps: RethinkScheduleDeps): () => void {
  const log = deps.log ?? ((m: string) => console.log(`[forge-rethink] ${m}`))
  const reconcile = () => {
    try {
      const svc = deps.service()
      const c = svc.config()
      const r = reconcileRethinkJobs(deps.scheduler, c.enabled ? svc.membranes() : [], c.rethink.times)
      if (r.added || r.removed) log(`schedule: +${r.added} −${r.removed} job(s)`)
    } catch (err) {
      log(`schedule: ${(err as Error).message}`)
    }
  }
  reconcile()
  const offs = [
    deps.bus.on('config.changed', (e: BusEvent) => {
      const p = String((e.payload as { path?: string })?.path ?? '')
      if (p === '' || p === 'forge' || p.startsWith('forge.')) reconcile()
    }),
    deps.bus.on('scheduler.job.due', (e: BusEvent) => {
      const { job, runId } = (e.payload ?? {}) as {
        job?: { id: string; payload?: Record<string, unknown> }
        runId?: string
      }
      if (job?.payload?.kind !== RETHINK_JOB_KIND) return
      const membrane = String(job.payload.membrane ?? '')
      const done = (type: 'scheduler.job.completed' | 'scheduler.job.failed', extra: Record<string, unknown>) =>
        deps.bus.emit({
          type,
          timestamp: new Date().toISOString(),
          source: 'forge',
          payload: { jobId: job.id, runId, ...extra }
        })
      deps
        .service()
        .rethink(membrane, { trigger: 'schedule' })
        .then((r) => done('scheduler.job.completed', { result: r }))
        .catch((err) => {
          log(`scheduled run ${membrane}: ${(err as Error).message}`)
          done('scheduler.job.failed', { error: (err as Error).message })
        })
    })
  ]
  const timer = setInterval(reconcile, deps.everyMs ?? 300_000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    for (const off of offs) off()
  }
}
