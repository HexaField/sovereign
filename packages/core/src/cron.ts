// Cron bridge interface — implemented by agent backends that expose
// backend-managed cron (currently OpenClaw). The Sovereign-native scheduler
// imports only this interface; concrete bridges register themselves via DI.

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

/**
 * Backend-managed cron bridge. The Sovereign scheduler treats every
 * registered bridge as a passthrough source of cron jobs alongside its own
 * native jobs.
 */
export interface CronBridge {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
  /** Detect whether a cron job needs an auto-fix patch. */
  needsAutoFix(job: CronJob): boolean
  /** Build the patch that converts a broken cron job to a working one. */
  buildFixPatch(job: CronJob): Record<string, unknown>
}
