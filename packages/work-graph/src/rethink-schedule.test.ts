import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createEventBus, type BusEvent } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cronExprFor,
  reconcileRethinkJobs,
  RETHINK_JOB_KIND,
  startRethinkSchedule,
  type RethinkJobPort
} from './rethink-schedule.js'
import { resolveConfig } from './service.js'
import type { ForgeConfig } from './types.js'

function fakeScheduler() {
  let n = 0
  const jobs: Array<{
    id: string
    name: string
    payload: Record<string, unknown>
    schedule: { kind: 'cron'; expr: string }
  }> = []
  const port: RethinkJobPort & { jobs: typeof jobs } = {
    jobs,
    list: () => [...jobs],
    add: (j) => {
      const job = { ...j, id: `job-${++n}` }
      jobs.push(job)
      return job
    },
    remove: (id) => {
      const i = jobs.findIndex((j) => j.id === id)
      if (i >= 0) jobs.splice(i, 1)
    }
  }
  return port
}

describe('rethink schedule', () => {
  it('turns HH:MM into a daily local cron', () => {
    expect(cronExprFor('08:30')).toBe('30 8 * * *')
    expect(cronExprFor('17:05')).toBe('5 17 * * *')
    expect(cronExprFor('24:00')).toBeUndefined()
    expect(cronExprFor('8:30')).toBeUndefined()
  })

  it('reconciles one job per membrane and time, keeping jobs that already match', () => {
    const s = fakeScheduler()
    s.add({
      name: 'user cron',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'sovereign.userMessage' },
      enabled: true
    })
    expect(reconcileRethinkJobs(s, ['acme', 'beta'], ['08:30', '17:30'])).toEqual({ added: 4, removed: 0 })
    const ids = s.jobs.map((j) => j.id)
    expect(reconcileRethinkJobs(s, ['acme', 'beta'], ['08:30', '17:30'])).toEqual({ added: 0, removed: 0 })
    expect(s.jobs.map((j) => j.id)).toEqual(ids)
    expect(s.jobs.find((j) => j.payload.membrane === 'acme' && j.payload.time === '17:30')).toMatchObject({
      schedule: { kind: 'cron', expr: '30 17 * * *' },
      payload: { kind: RETHINK_JOB_KIND }
    })
    // A time changes, a membrane goes away: only those jobs move.
    expect(reconcileRethinkJobs(s, ['acme'], ['08:30', '18:00'])).toEqual({ added: 1, removed: 3 })
    expect(
      s.jobs
        .filter((j) => j.payload.kind === RETHINK_JOB_KIND)
        .map((j) => j.name)
        .sort()
    ).toEqual(['forge-rethink acme 08:30', 'forge-rethink acme 18:00'])
    // A duplicate (e.g. from an older boot) is dropped; the user cron is never touched.
    s.add({
      name: 'dup',
      schedule: { kind: 'cron', expr: '30 8 * * *' },
      payload: { kind: RETHINK_JOB_KIND, membrane: 'acme', time: '08:30', expr: '30 8 * * *' },
      enabled: true
    })
    expect(reconcileRethinkJobs(s, ['acme'], ['08:30', '18:00'])).toEqual({ added: 0, removed: 1 })
    expect(reconcileRethinkJobs(s, [], [])).toEqual({ added: 0, removed: 2 })
    expect(s.jobs.map((j) => j.name)).toEqual(['user cron'])
  })

  describe('startRethinkSchedule', () => {
    let tmp: string
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-sched-'))
    })
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

    it('reschedules on a forge config change and runs a due job as a scheduled rethink', async () => {
      const bus = createEventBus(path.join(tmp, 'bus'))
      const s = fakeScheduler()
      let config: Partial<ForgeConfig> = { enabled: true, rethink: { times: ['08:30'], maxJobs: 6, tokenBudget: 1 } }
      const rethink = vi.fn(async () => ({ ran: true, count: 2, runId: 'r1' }))
      const service = { config: () => resolveConfig(config), membranes: () => ['acme'], rethink }
      const stop = startRethinkSchedule({ scheduler: s, bus, service: () => service, log: () => {} })
      expect(s.jobs.map((j) => j.name)).toEqual(['forge-rethink acme 08:30'])

      config = { ...config, rethink: { times: ['07:00', '19:00'], maxJobs: 6, tokenBudget: 1 } }
      bus.emit({ type: 'config.changed', timestamp: '', source: 'config', payload: { path: 'forge.rethink.times' } })
      expect(s.jobs.map((j) => j.name).sort()).toEqual(['forge-rethink acme 07:00', 'forge-rethink acme 19:00'])
      bus.emit({ type: 'config.changed', timestamp: '', source: 'config', payload: { path: 'voice.tts' } })
      expect(s.jobs).toHaveLength(2)

      const done: BusEvent[] = []
      bus.on('scheduler.job.*', (e) => void done.push(e))
      const job = s.jobs[0]
      bus.emit({ type: 'scheduler.job.due', timestamp: '', source: 'scheduler', payload: { job, runId: 'sched-1' } })
      bus.emit({
        type: 'scheduler.job.due',
        timestamp: '',
        source: 'scheduler',
        payload: { job: { id: 'x', payload: { kind: 'other' } }, runId: 'sched-2' }
      })
      await vi.waitFor(() => expect(done.some((e) => e.type === 'scheduler.job.completed')).toBe(true))
      expect(rethink).toHaveBeenCalledTimes(1)
      expect(rethink).toHaveBeenCalledWith('acme', { trigger: 'schedule' })
      expect(done.find((e) => e.type === 'scheduler.job.completed')!.payload).toMatchObject({
        jobId: job.id,
        runId: 'sched-1'
      })

      rethink.mockRejectedValueOnce(new Error('a rethink run is already in progress for acme'))
      bus.emit({ type: 'scheduler.job.due', timestamp: '', source: 'scheduler', payload: { job, runId: 'sched-3' } })
      await vi.waitFor(() => expect(done.some((e) => e.type === 'scheduler.job.failed')).toBe(true))

      // Forge off: no jobs.
      config = { ...config, enabled: false }
      bus.emit({ type: 'config.changed', timestamp: '', source: 'config', payload: { path: 'forge.enabled' } })
      expect(s.jobs).toHaveLength(0)
      stop()
    })
  })
})
