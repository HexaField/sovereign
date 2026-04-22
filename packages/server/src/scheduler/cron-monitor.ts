// Cron Monitor — polls gateway for cron run results and emits thread-targeted events

import type { WsHandler } from '../ws/handler.js'

export interface CronRunEntry {
  ts: number
  jobId: string
  action: string
  status: string
  error?: string
  summary?: string
  durationMs?: number
  sessionKey?: string
  jobName?: string
}

export interface CronMonitorOptions {
  getCronRuns: (jobId?: string) => Promise<CronRunEntry[]>
  listCronJobs: () => Promise<any[]>
  wsHandler: WsHandler
  pollIntervalMs?: number
}

/** Derive threadKey from sessionTarget or sessionKey */
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

export function createCronMonitor(options: CronMonitorOptions) {
  const { getCronRuns, listCronJobs, wsHandler, pollIntervalMs = 30_000 } = options

  let lastSeenRunTs = Date.now() - 60_000 // Start from 1 minute ago
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let destroyed = false

  // Cache of jobId -> job metadata for thread key resolution
  const jobCache = new Map<string, { name: string; threadKey: string | null; sessionTarget?: string }>()

  async function refreshJobCache(): Promise<void> {
    try {
      const jobs = await listCronJobs()
      jobCache.clear()
      for (const job of jobs) {
        const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
        jobCache.set(job.id, {
          name: job.name || job.id,
          threadKey,
          sessionTarget: job.sessionTarget
        })
      }
    } catch {
      // Non-fatal — use stale cache
    }
  }

  async function poll(): Promise<void> {
    if (destroyed) return

    try {
      const entries = await getCronRuns()

      // Filter to new runs since last poll
      const newRuns = entries.filter((e) => e.ts > lastSeenRunTs)
      if (newRuns.length === 0) return

      // Update high-water mark
      const maxTs = Math.max(...newRuns.map((e) => e.ts))
      lastSeenRunTs = maxTs

      // Refresh job cache if we have unknown jobs
      const unknownJobs = newRuns.filter((r) => !jobCache.has(r.jobId))
      if (unknownJobs.length > 0) {
        await refreshJobCache()
      }

      // Emit events for each new run
      for (const run of newRuns) {
        const jobMeta = jobCache.get(run.jobId)
        const threadKey = jobMeta?.threadKey ?? null

        const event = {
          type: 'cron.run.completed',
          threadKey,
          jobId: run.jobId,
          jobName: run.jobName || jobMeta?.name || run.jobId,
          status: run.status,
          error: run.error,
          summary: run.summary,
          durationMs: run.durationMs,
          timestamp: run.ts
        }

        // Broadcast to all chat subscribers (client filters by threadKey)
        wsHandler.broadcastToChannel('chat', event as any)
      }
    } catch {
      // Non-fatal — will retry on next poll
    }
  }

  function start(): void {
    if (destroyed || pollTimer) return

    // Initial job cache refresh
    refreshJobCache().catch(() => {})

    // Poll immediately, then on interval
    poll().catch(() => {})
    pollTimer = setInterval(() => {
      poll().catch(() => {})
    }, pollIntervalMs)
  }

  function stop(): void {
    destroyed = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** Get cached cron runs for a specific thread */
  async function getRunsForThread(threadKey: string, limit = 10): Promise<CronRunEntry[]> {
    try {
      const entries = await getCronRuns()

      // Ensure job cache is fresh
      if (jobCache.size === 0) {
        await refreshJobCache()
      }

      // Filter runs that belong to this thread
      return entries
        .filter((e) => {
          const jobMeta = jobCache.get(e.jobId)
          return jobMeta?.threadKey === threadKey
        })
        .slice(0, limit)
    } catch {
      return []
    }
  }

  return { start, stop, poll, getRunsForThread, refreshJobCache }
}
