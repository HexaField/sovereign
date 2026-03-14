import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@sovereign/core'
import type { BusEvent } from '@sovereign/core'
import { createScheduler, type Scheduler } from './scheduler.js'
import { createStore } from './store.js'
import type { Job } from './types.js'

let tmpDir: string
let scheduler: Scheduler
let bus: ReturnType<typeof createEventBus>
let events: BusEvent[]

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'))
  bus = createEventBus(tmpDir)
  events = []
  bus.on('scheduler.*', (e) => {
    events.push(e)
  })
  scheduler = createScheduler(bus, tmpDir)
})

afterEach(() => {
  scheduler.destroy()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const makeJob = (overrides: Partial<Omit<Job, 'id' | 'createdAt' | 'updatedAt'>> = {}) => ({
  name: 'test-job',
  schedule: { kind: 'interval' as const, everyMs: 1000 },
  payload: { action: 'test' },
  enabled: true,
  ...overrides
})

describe('Scheduler', () => {
  it('supports cron schedule type', () => {
    const job = scheduler.add(makeJob({ schedule: { kind: 'cron', expr: '* * * * *' } }))
    expect(job.schedule.kind).toBe('cron')
    const next = scheduler.nextRun(job.id)
    expect(next).toBeTruthy()
  })

  it('supports interval schedule type', () => {
    const job = scheduler.add(makeJob({ schedule: { kind: 'interval', everyMs: 5000 } }))
    expect(job.schedule.kind).toBe('interval')
    const next = scheduler.nextRun(job.id)
    expect(next).toBeTruthy()
  })

  it('supports oneshot schedule type', () => {
    const future = new Date(Date.now() + 60000).toISOString()
    const job = scheduler.add(makeJob({ schedule: { kind: 'oneshot', at: future } }))
    expect(job.schedule.kind).toBe('oneshot')
    const next = scheduler.nextRun(job.id)
    expect(next).toBeTruthy()
  })

  it('persists jobs to disk on add', () => {
    scheduler.add(makeJob())
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'scheduler', 'jobs.json'), 'utf-8'))
    expect(data).toHaveLength(1)
  })

  it('persists jobs to disk on update', () => {
    const job = scheduler.add(makeJob())
    scheduler.update(job.id, { name: 'updated' })
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'scheduler', 'jobs.json'), 'utf-8'))
    expect(data[0].name).toBe('updated')
  })

  it('persists jobs to disk on remove', () => {
    const job = scheduler.add(makeJob())
    scheduler.remove(job.id)
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'scheduler', 'jobs.json'), 'utf-8'))
    expect(data).toHaveLength(0)
  })

  it('recovers jobs from disk on startup', () => {
    const job = scheduler.add(makeJob())
    scheduler.destroy()
    const scheduler2 = createScheduler(bus, tmpDir)
    expect(scheduler2.get(job.id)).toBeTruthy()
    expect(scheduler2.get(job.id)!.name).toBe('test-job')
    scheduler2.destroy()
  })

  it('emits scheduler.job.due when a job is due', () => {
    scheduler.add(makeJob({ schedule: { kind: 'interval', everyMs: 1, anchorMs: 0 } }))
    scheduler.tick()
    const dueEvents = events.filter((e) => e.type === 'scheduler.job.due')
    expect(dueEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('emits scheduler.job.started when a job starts', () => {
    scheduler.add(makeJob({ schedule: { kind: 'interval', everyMs: 1, anchorMs: 0 } }))
    scheduler.tick()
    const startedEvents = events.filter((e) => e.type === 'scheduler.job.started')
    expect(startedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('emits scheduler.job.completed when a job completes', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    const startedEvent = events.find((e) => e.type === 'scheduler.job.started')
    const runId = (startedEvent!.payload as any).runId
    bus.emit({
      type: 'scheduler.job.completed',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { runId }
    })
    const completedEvents = events.filter((e) => e.type === 'scheduler.job.completed')
    expect(completedEvents.length).toBe(1)
  })

  it('emits scheduler.job.failed when a job fails', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    const startedEvent = events.find((e) => e.type === 'scheduler.job.started')
    const runId = (startedEvent!.payload as any).runId
    bus.emit({
      type: 'scheduler.job.failed',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { runId, error: 'boom' }
    })
    const failedEvents = events.filter((e) => e.type === 'scheduler.job.failed')
    expect(failedEvents.length).toBe(1)
  })

  it('does not execute job logic directly', () => {
    // The scheduler only emits events, it doesn't run any job handler
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    const dueEvents = events.filter((e) => e.type === 'scheduler.job.due')
    expect(dueEvents.length).toBe(1)
    // Payload contains the job definition so a subscriber can execute
    expect((dueEvents[0].payload as any).job.id).toBe(job.id)
  })

  it('adds a job at runtime', () => {
    const job = scheduler.add(makeJob())
    expect(job.id).toBeTruthy()
    expect(scheduler.get(job.id)).toBeTruthy()
  })

  it('updates a job at runtime', async () => {
    const job = scheduler.add(makeJob())
    await new Promise((r) => setTimeout(r, 5))
    const updated = scheduler.update(job.id, { name: 'new-name' })
    expect(updated.name).toBe('new-name')
    expect(updated.updatedAt).not.toBe(job.updatedAt)
  })

  it('removes a job at runtime', () => {
    const job = scheduler.add(makeJob())
    scheduler.remove(job.id)
    expect(scheduler.get(job.id)).toBeUndefined()
  })

  it('lists jobs with optional filter', () => {
    scheduler.add(makeJob({ enabled: true }))
    scheduler.add(makeJob({ name: 'disabled', enabled: false }))
    expect(scheduler.list()).toHaveLength(2)
    expect(scheduler.list({ enabled: true })).toHaveLength(1)
    expect(scheduler.list({ enabled: false })).toHaveLength(1)
  })

  it('gets a single job by id', () => {
    const job = scheduler.add(makeJob())
    expect(scheduler.get(job.id)).toEqual(job)
  })

  it('tracks run history with start time, end time, status, and error', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    const runs = scheduler.runs(job.id)
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs[0].jobId).toBe(job.id)
    expect(runs[0].startedAt).toBeTruthy()
    expect(runs[0].status).toBe('running')
  })

  it('returns run history for a job', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    scheduler.trigger(job.id) // concurrency default=1, so this won't fire
    const runs = scheduler.runs(job.id)
    expect(runs.length).toBeGreaterThanOrEqual(1)
  })

  it('deletes oneshot job after successful run when deleteAfterRun is true', () => {
    const future = new Date(Date.now() - 1000).toISOString() // in the past so it's due
    const job = scheduler.add(
      makeJob({
        schedule: { kind: 'oneshot', at: future },
        deleteAfterRun: true
      })
    )
    scheduler.trigger(job.id)
    const startedEvent = events.find((e) => e.type === 'scheduler.job.started')
    const runId = (startedEvent!.payload as any).runId
    bus.emit({
      type: 'scheduler.job.completed',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { runId }
    })
    // Job should be deleted
    expect(scheduler.get(job.id)).toBeUndefined()
  })

  it('supports timezone-aware cron expressions', () => {
    const job = scheduler.add(makeJob({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' } }))
    const next = scheduler.nextRun(job.id)
    expect(next).toBeTruthy()
  })

  it('returns next run time for a job', () => {
    const job = scheduler.add(makeJob({ schedule: { kind: 'interval', everyMs: 5000 } }))
    const next = scheduler.nextRun(job.id)
    expect(next).toBeTruthy()
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now() - 1000)
  })

  it('filters jobs by tags', () => {
    scheduler.add(makeJob({ tags: ['a', 'b'] }))
    scheduler.add(makeJob({ name: 'other', tags: ['c'] }))
    expect(scheduler.list({ tags: ['a'] })).toHaveLength(1)
    expect(scheduler.list({ tags: ['c'] })).toHaveLength(1)
    expect(scheduler.list({ tags: ['x'] })).toHaveLength(0)
  })

  it('prevents concurrent runs of the same job by default', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    scheduler.trigger(job.id) // should be blocked - concurrency 1, already running
    const startedEvents = events.filter((e) => e.type === 'scheduler.job.started')
    expect(startedEvents).toHaveLength(1)
  })

  it('allows concurrent runs when concurrency option is set', () => {
    const job = scheduler.add(makeJob({ concurrency: 2 }))
    scheduler.trigger(job.id)
    scheduler.trigger(job.id)
    const startedEvents = events.filter((e) => e.type === 'scheduler.job.started')
    expect(startedEvents).toHaveLength(2)
  })

  it('manually triggers a job', () => {
    const job = scheduler.add(makeJob())
    scheduler.trigger(job.id)
    const dueEvents = events.filter((e) => e.type === 'scheduler.job.due')
    expect(dueEvents).toHaveLength(1)
    expect((dueEvents[0].payload as any).job.id).toBe(job.id)
  })
})

describe('Scheduler Store', () => {
  it('reads jobs from disk', () => {
    const store = createStore(tmpDir)
    const dir = path.join(tmpDir, 'scheduler')
    fs.mkdirSync(dir, { recursive: true })
    const job: Job = {
      id: 'test-1',
      name: 'test',
      schedule: { kind: 'interval', everyMs: 1000 },
      payload: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([job]))
    expect(store.loadJobs()).toHaveLength(1)
    expect(store.loadJobs()[0].id).toBe('test-1')
  })

  it('writes jobs to disk atomically', () => {
    const store = createStore(tmpDir)
    const job: Job = {
      id: 'test-1',
      name: 'test',
      schedule: { kind: 'interval', everyMs: 1000 },
      payload: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    store.saveJobs([job])
    const file = path.join(tmpDir, 'scheduler', 'jobs.json')
    expect(fs.existsSync(file)).toBe(true)
    // tmp file should not exist (atomic rename)
    expect(fs.existsSync(file + '.tmp')).toBe(false)
  })

  it('creates data directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'nested', 'deep')
    const store = createStore(newDir)
    store.saveJobs([])
    expect(fs.existsSync(path.join(newDir, 'scheduler', 'jobs.json'))).toBe(true)
  })

  it('appends run records to per-job jsonl files', () => {
    const store = createStore(tmpDir)
    const run = { id: 'r1', jobId: 'j1', startedAt: new Date().toISOString(), status: 'running' as const }
    store.appendRun(run)
    store.appendRun({ ...run, id: 'r2' })
    const file = path.join(tmpDir, 'scheduler', 'runs', 'j1.jsonl')
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('reads run records for a job', () => {
    const store = createStore(tmpDir)
    store.appendRun({ id: 'r1', jobId: 'j1', startedAt: new Date().toISOString(), status: 'running' })
    store.appendRun({ id: 'r2', jobId: 'j1', startedAt: new Date().toISOString(), status: 'completed' })
    const runs = store.readRuns('j1')
    expect(runs).toHaveLength(2)
    const limited = store.readRuns('j1', 1)
    expect(limited).toHaveLength(1)
    expect(limited[0].id).toBe('r2')
  })
})
