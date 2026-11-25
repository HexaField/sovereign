import { describe, it, expect } from 'vitest'
import {
  formatSchedule,
  formatNextRun,
  formatLastRun,
  splitInterval,
  formFromJob,
  validateCronForm,
  toLocalInput,
  EMPTY_FORM,
  type CronJob,
  type CronFormValues
} from './cron-model.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: 'j1',
  name: 'Digest',
  enabled: true,
  threadKey: 't1',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload: { message: 'Summarise' },
  ...over
})
const form = (over: Partial<CronFormValues>): CronFormValues => ({ ...EMPTY_FORM, prompt: 'Do it', ...over })

describe('formatSchedule', () => {
  it('shows a cron expression as it is', () => {
    expect(formatSchedule({ kind: 'cron', expr: '*/5 * * * *' })).toBe('*/5 * * * *')
  })
  it('shows an interval in its largest even unit', () => {
    expect(formatSchedule({ kind: 'interval', everyMs: 5 * 60_000 })).toBe('every 5m')
    expect(formatSchedule({ kind: 'interval', everyMs: 2 * 3_600_000 })).toBe('every 2h')
    expect(formatSchedule({ kind: 'interval', everyMs: 86_400_000 })).toBe('every 1d')
    expect(formatSchedule({ kind: 'interval', everyMs: 90 * 60_000 })).toBe('every 90m')
  })
  it('shows a one-shot as once plus the time', () => {
    expect(formatSchedule({ kind: 'oneshot', at: '2026-11-25T09:00:00Z' })).toMatch(/^once /)
    expect(formatSchedule({ kind: 'oneshot', at: 'nonsense' })).toBe('once')
  })
})

describe('splitInterval', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(splitInterval(3_600_000)).toEqual({ every: 1, unit: 'hours' })
    expect(splitInterval(7 * 86_400_000)).toEqual({ every: 7, unit: 'days' })
    expect(splitInterval(61 * 60_000)).toEqual({ every: 61, unit: 'minutes' })
  })
})

describe('formatNextRun / formatLastRun', () => {
  it('reads the next run as a short span, or due now', () => {
    expect(formatNextRun(NOW + 30_000, NOW)).toBe('in <1m')
    expect(formatNextRun(NOW + 10 * 60_000, NOW)).toBe('in 10m')
    expect(formatNextRun(NOW + 3 * 3_600_000, NOW)).toBe('in 3h')
    expect(formatNextRun(NOW + 2 * 86_400_000, NOW)).toBe('in 2d')
    expect(formatNextRun(NOW - 1, NOW)).toBe('due now')
    expect(formatNextRun(undefined, NOW)).toBe('')
  })
  it('reads the last result', () => {
    expect(formatLastRun(undefined, NOW)).toBe('Not run yet')
    expect(formatLastRun({}, NOW)).toBe('Not run yet')
    expect(formatLastRun({ lastRunAtMs: NOW - 5 * 60_000, lastStatus: 'ok' }, NOW)).toBe('Ran 5m ago')
    expect(formatLastRun({ lastRunAtMs: NOW - 2 * 3_600_000, lastStatus: 'error' }, NOW)).toBe('Failed 2h ago')
  })
})

describe('validateCronForm', () => {
  it('builds a cron body and trims the name and message', () => {
    const r = validateCronForm(form({ name: '  Digest ', expr: ' 0  9 * * * ', prompt: ' Do it ' }), NOW)
    expect(r).toEqual({
      ok: true,
      body: { name: 'Digest', schedule: { kind: 'cron', expr: '0 9 * * *' }, prompt: 'Do it' }
    })
  })
  it('leaves the name out when it is blank', () => {
    const r = validateCronForm(form({ expr: '0 9 * * *' }), NOW)
    expect(r.ok && 'name' in r.body).toBe(false)
  })
  it('refuses an expression without 5 or 6 fields', () => {
    const r = validateCronForm(form({ expr: 'every day' }), NOW)
    expect(r).toEqual({ ok: false, errors: { expr: 'Enter 5 fields, like 0 9 * * *' } })
  })
  it('builds an interval in milliseconds', () => {
    const r = validateCronForm(form({ mode: 'interval', every: '2', unit: 'hours' }), NOW)
    expect(r.ok && r.body.schedule).toEqual({ kind: 'interval', everyMs: 7_200_000 })
  })
  it('refuses a zero, negative or fractional interval', () => {
    for (const every of ['0', '-3', '1.5', '', 'abc']) {
      const r = validateCronForm(form({ mode: 'interval', every }), NOW)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.errors.every).toBeTruthy()
    }
  })
  it('builds a one-shot as an ISO time and refuses a missing or past time', () => {
    const future = toLocalInput(new Date(NOW + 3_600_000).toISOString())
    const ok = validateCronForm(form({ mode: 'oneshot', at: future }), NOW)
    expect(ok.ok && ok.body.schedule.kind).toBe('oneshot')
    expect(validateCronForm(form({ mode: 'oneshot', at: '' }), NOW)).toEqual({
      ok: false,
      errors: { at: 'Pick a date and time' }
    })
    const past = toLocalInput(new Date(NOW - 3_600_000).toISOString())
    expect(validateCronForm(form({ mode: 'oneshot', at: past }), NOW)).toEqual({
      ok: false,
      errors: { at: 'Pick a time in the future' }
    })
  })
  it('refuses a blank message and reports every error at once', () => {
    const r = validateCronForm(form({ expr: '', prompt: '  ' }), NOW)
    expect(r).toEqual({
      ok: false,
      errors: { expr: 'Enter 5 fields, like 0 9 * * *', prompt: 'Enter a message' }
    })
  })
})

describe('formFromJob', () => {
  it('starts blank for a new cron', () => {
    expect(formFromJob()).toEqual(EMPTY_FORM)
  })
  it('fills the form from a cron, interval or one-shot job', () => {
    expect(formFromJob(job())).toMatchObject({ mode: 'cron', expr: '0 9 * * *', name: 'Digest', prompt: 'Summarise' })
    expect(formFromJob(job({ schedule: { kind: 'interval', everyMs: 7_200_000 } }))).toMatchObject({
      mode: 'interval',
      every: '2',
      unit: 'hours'
    })
    const at = new Date(NOW + 86_400_000).toISOString()
    const oneshot = formFromJob(job({ schedule: { kind: 'oneshot', at } }))
    expect(oneshot.mode).toBe('oneshot')
    const back = validateCronForm(oneshot, NOW)
    expect(back.ok && new Date(back.body.schedule.at!).getTime()).toBe(new Date(at).getTime())
  })
})
