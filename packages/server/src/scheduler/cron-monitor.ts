// Cron Monitor — polls gateway for cron run results, emits thread-targeted events,
// and auto-fixes misconfigured crons (webchat delivery → systemEvent on main)

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
  listCronJobs: (includeDisabled?: boolean) => Promise<any[]>
  updateCronJob: (id: string, patch: Record<string, unknown>) => Promise<any>
  /** Send a message into a thread session (for relaying cron results) */
  sendMessage?: (sessionKey: string, text: string) => Promise<void>
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

/**
 * Detect whether a cron job needs auto-fixing.
 *
 * The pattern that WORKS:
 *   agentTurn targeting a thread session with delivery.mode: "none"
 *   → agent runs in the thread session, output stored there, user sees it in UI
 *
 * The patterns that FAIL:
 *   delivery.mode: "announce" + delivery.channel: "webchat"
 *   → "webchat" is not a registered gateway channel, delivery always errors
 *
 *   delivery.mode: "announce" without any channel
 *   → same problem: no configured channels detected
 *
 * Auto-fix changes broken delivery config to mode: "none" so the agent
 * turn runs successfully in the target session without requiring delivery.
 *
 * NOTE: Converting to systemEvent/main was WRONG — events go to the main
 * session, never reaching the target thread. Keep agentTurn + thread target.
 */
function needsAutoFix(job: any): boolean {
  // No delivery config or delivery mode is already 'none' — nothing to fix
  if (!job.delivery || job.delivery.mode === 'none') return false

  // Already using systemEvent on main (working pattern from old fix)
  if (job.sessionTarget === 'main' && job.payload?.kind === 'systemEvent') return false

  // Skip past one-shot 'at' jobs that are already disabled — dead weight
  if (job.schedule?.kind === 'at' && job.deleteAfterRun) {
    const atTime = new Date(job.schedule.at).getTime()
    if (!Number.isNaN(atTime) && atTime < Date.now()) return false
  }

  // Detect broken delivery:
  // 1. agentTurn with webchat delivery channel (channel doesn't exist)
  if (job.payload?.kind === 'agentTurn' && job.delivery?.channel === 'webchat') return true

  // 2. agentTurn with announce delivery mode (no real channels configured)
  if (job.payload?.kind === 'agentTurn' && job.delivery?.mode === 'announce') return true

  return false
}

/**
 * Build the fix patch to convert a failing cron to the working pattern.
 */
/**
 * Build the fix patch for a misconfigured cron.
 *
 * The fix is minimal: just change delivery to mode: "none" so the agent
 * turn runs in the target session without trying to announce via a
 * non-existent channel. Keep sessionTarget, payload, and everything
 * else intact.
 */
function buildFixPatch(_job: any): Record<string, unknown> {
  return {
    // Remove broken delivery config — the only thing that's wrong
    delivery: { mode: 'none' },
    // Re-enable if it was disabled due to the delivery error
    enabled: true
  }
}

export function createCronMonitor(options: CronMonitorOptions) {
  const {
    getCronRuns,
    listCronJobs,
    updateCronJob,
    sendMessage,
    wsHandler,
    pollIntervalMs = 30_000,
    autoFixIntervalMs = 15_000
  } = options

  let lastSeenRunTs = Date.now() - 60_000 // Start from 1 minute ago
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let autoFixTimer: ReturnType<typeof setInterval> | null = null
  let destroyed = false

  // Track which jobs we've already fixed to avoid retry loops
  const fixedJobIds = new Set<string>()

  // Cache of jobId -> job metadata for thread key resolution
  const jobCache = new Map<string, { name: string; threadKey: string | null; sessionTarget?: string }>()

  async function refreshJobCache(): Promise<void> {
    try {
      const jobs = await listCronJobs(true) // include disabled
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

  /**
   * Auto-fix scan: find misconfigured crons and fix them automatically.
   * This runs on its own interval (faster than the run-results poll).
   */
  async function autoFixScan(): Promise<void> {
    if (destroyed) return

    try {
      const jobs = await listCronJobs(true) // include disabled to catch auto-disabled ones

      for (const job of jobs) {
        // Skip jobs we've already fixed this session
        if (fixedJobIds.has(job.id)) continue

        if (needsAutoFix(job)) {
          const patch = buildFixPatch(job)

          try {
            await updateCronJob(job.id, patch)
            fixedJobIds.add(job.id)

            const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
            console.log(
              `[cron-monitor] Auto-fixed cron "${job.name || job.id}" → delivery:none` +
                (threadKey ? ` (thread: ${threadKey})` : '')
            )

            // Notify UI about the auto-fix
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
      }
    } catch {
      // Non-fatal — will retry
    }
  }

  async function poll(): Promise<void> {
    if (destroyed) return

    try {
      const entries = await getCronRuns()

      // Filter to new runs since last poll
      const newRuns = entries.filter((e) => e.ts > lastSeenRunTs)
      if (newRuns.length === 0) return

      console.log(`[cron-monitor] Found ${newRuns.length} new run(s) since ${lastSeenRunTs}`)

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
        // Derive threadKey from job cache OR from the run's own sessionKey
        // (important for deleteAfterRun jobs where the job is gone by poll time)
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

        // Broadcast to all chat subscribers (client filters by threadKey)
        wsHandler.broadcastToChannel('chat', event as any)

        // Relay successful agentTurn results back into the thread via chat.send
        // This makes cron results visible in the thread UI
        if (sendMessage && threadKey && run.status === 'ok' && run.summary) {
          const sessionKey = `agent:main:thread:${threadKey}`
          const jobName = run.jobName || jobMeta?.name || 'Cron job'
          const relayText = `[Cron: ${jobName}] ${run.summary}`
          console.log(`[cron-monitor] Relaying result to thread ${threadKey}: ${relayText.substring(0, 80)}`)
          sendMessage(sessionKey, relayText).catch((err: any) => {
            console.error(`[cron-monitor] Failed to relay result to thread ${threadKey}:`, err.message)
          })
        }
      }
    } catch {
      // Non-fatal — will retry on next poll
    }
  }

  function start(): void {
    if (destroyed || pollTimer) return

    // Initial job cache refresh
    refreshJobCache().catch(() => {})

    // Run auto-fix immediately on start
    autoFixScan().catch(() => {})

    // Poll for run results
    poll().catch(() => {})
    pollTimer = setInterval(() => {
      poll().catch(() => {})
    }, pollIntervalMs)

    // Auto-fix scan on a faster interval
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

  return { start, stop, poll, autoFixScan, getRunsForThread, refreshJobCache }
}
