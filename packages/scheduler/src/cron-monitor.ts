// Cron Monitor — polls Sovereign's CronService for run results, emits
// thread-targeted events, and auto-fixes misconfigured jobs through the
// service. Backend-specific knowledge (gateway auto-fix patterns) lives in
// each adapter's cron-bridge; the monitor itself is backend-agnostic.

import type { WsHandler } from '@sovereign/primitives'
import type { CronRunEntry, CronService } from './cron-service.js'

export type { CronRunEntry } from './cron-service.js'

export interface CronMonitorOptions {
  cronService: CronService
  wsHandler: WsHandler
  pollIntervalMs?: number
  autoFixIntervalMs?: number
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
  const { cronService, wsHandler, pollIntervalMs = 30_000, autoFixIntervalMs = 15_000 } = options

  let lastSeenRunTs = Date.now() - 60_000
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let autoFixTimer: ReturnType<typeof setInterval> | null = null
  let destroyed = false

  const fixedJobIds = new Set<string>()
  const jobCache = new Map<string, { name: string; threadKey: string | null; sessionTarget?: string }>()

  async function refreshJobCache(): Promise<void> {
    try {
      const jobs = await cronService.list(true)
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
      /* non-fatal */
    }
  }

  async function autoFixScan(): Promise<void> {
    if (destroyed) return

    try {
      const jobs = await cronService.list(true)
      for (const job of jobs) {
        if (fixedJobIds.has(job.id)) continue
        if (!cronService.needsAutoFix(job)) continue

        const patch = cronService.buildFixPatch(job)
        try {
          await cronService.update(job.id, patch)
          fixedJobIds.add(job.id)

          const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
          console.log(
            `[cron-monitor] Auto-fixed cron "${job.name || job.id}" → delivery:none` +
              (threadKey ? ` (thread: ${threadKey})` : '')
          )

          wsHandler.broadcastToChannel('chat', {
            type: 'cron.auto-fixed',
            threadKey,
            jobId: job.id,
            jobName: job.name || job.id,
            message: `Auto-fixed cron "${job.name || job.id}": removed broken delivery config (announce/webchat → none)`,
            timestamp: Date.now()
          } as any)
        } catch (err: any) {
          console.error(`[cron-monitor] Failed to auto-fix cron "${job.name || job.id}":`, err.message)
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  async function poll(): Promise<void> {
    if (destroyed) return

    try {
      const entries = await cronService.runs()
      const newRuns = entries.filter((e: CronRunEntry) => e.ts > lastSeenRunTs)
      if (newRuns.length === 0) return

      console.log(`[cron-monitor] Found ${newRuns.length} new run(s) since ${lastSeenRunTs}`)

      const maxTs = Math.max(...newRuns.map((e: CronRunEntry) => e.ts))
      lastSeenRunTs = maxTs

      const unknownJobs = newRuns.filter((r) => !jobCache.has(r.jobId))
      if (unknownJobs.length > 0) {
        await refreshJobCache()
      }

      for (const run of newRuns) {
        const jobMeta = jobCache.get(run.jobId)
        const threadKey = jobMeta?.threadKey ?? deriveThreadKey(undefined, (run as any).sessionKey) ?? null

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

        wsHandler.broadcastToChannel('chat', event as any)

        if (threadKey && run.status === 'ok' && run.summary) {
          const sessionKey = `agent:main:thread:${threadKey}`
          const jobName = run.jobName || jobMeta?.name || 'Cron job'
          const relayText = `[Cron: ${jobName}] ${run.summary}`
          console.log(`[cron-monitor] Relaying result to thread ${threadKey}: ${relayText.substring(0, 80)}`)
          cronService.sendMessage(sessionKey, relayText).catch((err: any) => {
            console.error(`[cron-monitor] Failed to relay result to thread ${threadKey}:`, err.message)
          })
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  function start(): void {
    if (destroyed || pollTimer) return
    refreshJobCache().catch(() => {})
    autoFixScan().catch(() => {})
    poll().catch(() => {})
    pollTimer = setInterval(() => {
      poll().catch(() => {})
    }, pollIntervalMs)
    autoFixTimer = setInterval(() => {
      autoFixScan().catch(() => {})
    }, autoFixIntervalMs)
  }

  function stop(): void {
    destroyed = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (autoFixTimer) {
      clearInterval(autoFixTimer)
      autoFixTimer = null
    }
  }

  async function getRunsForThread(threadKey: string, limit = 10): Promise<CronRunEntry[]> {
    try {
      const entries = await cronService.runs()
      if (jobCache.size === 0) await refreshJobCache()
      return entries.filter((e) => jobCache.get(e.jobId)?.threadKey === threadKey).slice(0, limit)
    } catch {
      return []
    }
  }

  return { start, stop, poll, autoFixScan, getRunsForThread, refreshJobCache }
}

// Re-export for callers that previously imported the type from here.
export type { CronJob } from './cron-service.js'
