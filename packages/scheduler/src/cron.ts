import { Cron } from 'croner'
import type { Schedule } from './types.js'

export function nextRunTime(schedule: Schedule, from: Date = new Date()): Date | null {
  switch (schedule.kind) {
    case 'cron': {
      const job = new Cron(schedule.expr, { timezone: schedule.tz })
      const next = job.nextRun(from)
      return next
    }
    case 'interval': {
      const anchor = schedule.anchorMs ?? 0
      const now = from.getTime()
      const elapsed = now - anchor
      const next = anchor + Math.ceil(elapsed / schedule.everyMs) * schedule.everyMs
      // If next === now, push to next interval
      return new Date(next <= now ? next + schedule.everyMs : next)
    }
    case 'oneshot': {
      const at = new Date(schedule.at)
      return at.getTime() > from.getTime() ? at : null
    }
  }
}

export function isDue(schedule: Schedule, lastRun: Date | null, now: Date = new Date()): boolean {
  switch (schedule.kind) {
    case 'cron': {
      const job = new Cron(schedule.expr, { timezone: schedule.tz })
      // The next run after lastRun should be <= now for the job to be due
      const ref = lastRun ?? new Date(0)
      const next = job.nextRun(ref)
      if (!next) return false
      return next.getTime() <= now.getTime()
    }
    case 'interval': {
      const anchor = schedule.anchorMs ?? 0
      const nowMs = now.getTime()
      const elapsed = nowMs - anchor
      if (elapsed < 0) return false
      // Current interval boundary
      const currentBoundary = anchor + Math.floor(elapsed / schedule.everyMs) * schedule.everyMs
      if (!lastRun) return currentBoundary <= nowMs
      return currentBoundary > lastRun.getTime()
    }
    case 'oneshot': {
      const at = new Date(schedule.at).getTime()
      if (now.getTime() < at) return false
      // Due if never run
      if (!lastRun) return true
      return false
    }
  }
}
