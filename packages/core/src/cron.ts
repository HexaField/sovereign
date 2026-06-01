// Cron job + run schema, owned by the Sovereign-native scheduler. The
// `CronBridge` extension point for backend-managed cron has been retired
// (OpenClaw was the only consumer).

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
