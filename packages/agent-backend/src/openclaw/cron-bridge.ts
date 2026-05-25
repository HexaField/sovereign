// OpenClaw cron bridge — talks to the gateway's cron RPC. Implements the
// `CronBridge` interface defined in `@sovereign/core`; the Sovereign cron
// service consumes only that interface.

import type { CronBridge, CronJob, CronRunEntry } from '@sovereign/core'

export type { CronJob, CronRunEntry } from '@sovereign/core'

/** @deprecated Use CronBridge from @sovereign/core. Retained for compatibility. */
export type OpenClawCronBridge = CronBridge

export interface BridgeRpcs {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
}

export function createOpenClawCronBridge(rpcs: BridgeRpcs): CronBridge {
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
