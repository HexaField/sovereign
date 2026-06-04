// Cron job + run schema, owned by the Sovereign-native scheduler. The
// `CronBridge` extension point for backend-managed cron has been retired
// (OpenClaw was the only consumer).

/**
 * Discriminated-union schedule shape. Matches `@sovereign/scheduler`'s
 * `Schedule` type. Lives in `@sovereign/core` so client + server consumers
 * can branch on `kind` without taking a scheduler dependency.
 */
export type CronScheduleShape =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'interval'; everyMs: number; anchorMs?: number }
  | { kind: 'oneshot'; at: string }

export interface CronJob {
  id: string
  name?: string
  enabled?: boolean
  sessionTarget?: string
  sessionKey?: string
  delivery?: { mode?: string; channel?: string }
  payload?: { kind?: string; message?: string; text?: string }
  schedule?: CronScheduleShape
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
