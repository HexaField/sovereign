import { randomUUID } from 'node:crypto'
import type { EventBus, BusEvent } from '@template/core'
import type { Job, RunRecord } from './types.js'
import { createStore, type SchedulerStore } from './store.js'
import { isDue, nextRunTime } from './cron.js'

export interface Scheduler {
  add(job: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job
  update(jobId: string, patch: Partial<Job>): Job
  remove(jobId: string): void
  get(jobId: string): Job | undefined
  list(filter?: { tags?: string[]; enabled?: boolean }): Job[]
  nextRun(jobId: string): string | null
  runs(jobId: string, limit?: number): RunRecord[]
  trigger(jobId: string): void
  init(): void
  destroy(): void
  tick(): void
}

export function createScheduler(bus: EventBus, dataDir: string, tickIntervalMs = 1000): Scheduler {
  const store: SchedulerStore = createStore(dataDir)
  let jobs: Job[] = store.loadJobs()
  const runningJobs = new Map<string, number>() // jobId -> count of running
  const lastRunTimes = new Map<string, Date>()
  let timer: ReturnType<typeof setInterval> | null = null

  // Reconstruct lastRunTimes from run history
  for (const job of jobs) {
    const runs = store.readRuns(job.id, 1)
    if (runs.length > 0) {
      lastRunTimes.set(job.id, new Date(runs[runs.length - 1].startedAt))
    }
  }

  const save = () => store.saveJobs(jobs)

  const emitEvent = (type: string, payload: unknown) => {
    bus.emit({ type, timestamp: new Date().toISOString(), source: 'scheduler', payload })
  }

  const fireJob = (job: Job) => {
    const concurrencyLimit = job.concurrency ?? 1
    const currentRunning = runningJobs.get(job.id) ?? 0
    if (currentRunning >= concurrencyLimit) return

    const runId = randomUUID()
    const run: RunRecord = {
      id: runId,
      jobId: job.id,
      startedAt: new Date().toISOString(),
      status: 'running'
    }

    runningJobs.set(job.id, currentRunning + 1)
    lastRunTimes.set(job.id, new Date())
    store.appendRun(run)

    emitEvent('scheduler.job.due', { job, runId })
    emitEvent('scheduler.job.started', { job, runId })

    // Listen for completion/failure from bus
    const completionHandler = (event: BusEvent) => {
      const p = event.payload as Record<string, unknown>
      if (p.runId !== runId) return

      const count = runningJobs.get(job.id) ?? 1
      runningJobs.set(job.id, Math.max(0, count - 1))

      if (event.type === 'scheduler.job.completed') {
        const completedRun: RunRecord = { ...run, status: 'completed', completedAt: new Date().toISOString() }
        store.appendRun(completedRun)
        // Delete oneshot after run
        if (job.deleteAfterRun && job.schedule.kind === 'oneshot') {
          jobs = jobs.filter((j) => j.id !== job.id)
          save()
        }
      } else {
        const failedRun: RunRecord = {
          ...run,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: p.error as string
        }
        store.appendRun(failedRun)
      }
    }

    const unsubCompleted = bus.on('scheduler.job.completed', completionHandler)
    const unsubFailed = bus.on('scheduler.job.failed', completionHandler)

    // Auto-cleanup subscriptions after 5 min
    setTimeout(() => {
      unsubCompleted()
      unsubFailed()
    }, 300_000)
  }

  const tick = () => {
    const now = new Date()
    for (const job of Array.from(jobs)) {
      if (!job.enabled) continue
      const lastRun = lastRunTimes.get(job.id) ?? null
      if (isDue(job.schedule, lastRun, now)) {
        fireJob(job)
      }
    }
  }

  return {
    add(input) {
      const now = new Date().toISOString()
      const job: Job = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
      jobs.push(job)
      save()
      return job
    },
    update(jobId, patch) {
      const idx = jobs.findIndex((j) => j.id === jobId)
      if (idx === -1) throw new Error(`Job not found: ${jobId}`)
      jobs[idx] = { ...jobs[idx], ...patch, id: jobId, updatedAt: new Date().toISOString() }
      save()
      return jobs[idx]
    },
    remove(jobId) {
      jobs = jobs.filter((j) => j.id !== jobId)
      save()
    },
    get(jobId) {
      return jobs.find((j) => j.id === jobId)
    },
    list(filter) {
      let result = Array.from(jobs)
      if (filter?.enabled !== undefined) result = result.filter((j) => j.enabled === filter.enabled)
      if (filter?.tags?.length) result = result.filter((j) => filter.tags!.some((t) => j.tags?.includes(t)))
      return result
    },
    nextRun(jobId) {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return null
      const next = nextRunTime(job.schedule)
      return next ? next.toISOString() : null
    },
    runs(jobId, limit?) {
      return store.readRuns(jobId, limit)
    },
    trigger(jobId) {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) throw new Error(`Job not found: ${jobId}`)
      fireJob(job)
    },
    init() {
      jobs = store.loadJobs()
      // Reconstruct lastRunTimes
      for (const job of jobs) {
        const runs = store.readRuns(job.id, 1)
        if (runs.length > 0) {
          lastRunTimes.set(job.id, new Date(runs[runs.length - 1].startedAt))
        }
      }
      timer = setInterval(tick, tickIntervalMs)
    },
    destroy() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    tick
  }
}
