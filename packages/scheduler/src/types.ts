// Scheduler types

export interface CronSchedule {
  kind: 'cron'
  expr: string
  tz?: string
}
export interface IntervalSchedule {
  kind: 'interval'
  everyMs: number
  anchorMs?: number
}
export interface OneshotSchedule {
  kind: 'oneshot'
  at: string
}

export type Schedule = CronSchedule | IntervalSchedule | OneshotSchedule

export interface Job {
  id: string
  name: string
  schedule: Schedule
  payload: Record<string, unknown>
  enabled: boolean
  tags?: string[]
  concurrency?: number
  deleteAfterRun?: boolean
  createdAt: string
  updatedAt: string
}

export interface RunRecord {
  id: string
  jobId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
  error?: string
}
