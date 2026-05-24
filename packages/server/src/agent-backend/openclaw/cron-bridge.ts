// OpenClaw cron bridge — talks to the gateway's cron RPC. Used by
// Sovereign's CronService when the underlying backend has `cron:
// 'backend-managed'` capability. Also bundles the auto-fix detector for
// misconfigured `delivery: announce`/`webchat` jobs.

export interface CronJob {
  id: string
  name?: string
  enabled?: boolean
  sessionTarget?: string
  sessionKey?: string
  delivery?: { mode?: string; channel?: string }
  payload?: { kind?: string; message?: string; text?: string }
  schedule?: { kind?: string; at?: string }
  deleteAfterRun?: boolean
  state?: { lastStatus?: string }
  [key: string]: unknown
}

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

export interface OpenClawCronBridge {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
  /** Detect whether a cron job needs the announce/webchat auto-fix patch. */
  needsAutoFix(job: CronJob): boolean
  /** Build the patch that converts a broken cron job to `delivery: none`. */
  buildFixPatch(job: CronJob): Record<string, unknown>
}

export interface BridgeRpcs {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
}

export function createOpenClawCronBridge(rpcs: BridgeRpcs): OpenClawCronBridge {
  return {
    list: (includeDisabled = false) => rpcs.list(includeDisabled),
    runs: (jobId) => rpcs.runs(jobId),
    update: (id, patch) => rpcs.update(id, patch),
    remove: (id) => rpcs.remove(id),

    needsAutoFix(job: CronJob): boolean {
      if (!job.delivery || job.delivery.mode === 'none') return false
      if (job.sessionTarget === 'main' && job.payload?.kind === 'systemEvent') return false

      if (job.schedule?.kind === 'at' && job.deleteAfterRun) {
        const atTime = new Date(job.schedule.at ?? '').getTime()
        if (!Number.isNaN(atTime) && atTime < Date.now()) return false
      }

      if (job.payload?.kind === 'agentTurn' && job.delivery?.channel === 'webchat') return true
      if (job.payload?.kind === 'agentTurn' && job.delivery?.mode === 'announce') return true

      return false
    },

    buildFixPatch(_job: CronJob): Record<string, unknown> {
      return {
        delivery: { mode: 'none' },
        enabled: true
      }
    }
  }
}
