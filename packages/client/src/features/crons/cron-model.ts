// Pure helpers for a thread's crons: the job shape the API returns, how a row
// reads, and the add/edit form's values and validation.

export interface CronSchedule {
  kind: string
  expr?: string
  tz?: string
  everyMs?: number
  at?: string
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  threadKey: string
  schedule: CronSchedule
  payload: { message?: string }
  state?: { lastStatus?: string; nextRunAtMs?: number; lastRunAtMs?: number }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type IntervalUnit = 'minutes' | 'hours' | 'days'
const UNIT_MS: Record<IntervalUnit, number> = { minutes: MINUTE, hours: HOUR, days: DAY }
const UNIT_SHORT: Record<IntervalUnit, string> = { minutes: 'm', hours: 'h', days: 'd' }

/** The largest unit that divides the interval evenly. */
export function splitInterval(everyMs: number): { every: number; unit: IntervalUnit } {
  const unit: IntervalUnit = everyMs % DAY === 0 ? 'days' : everyMs % HOUR === 0 ? 'hours' : 'minutes'
  return { every: Math.max(1, Math.round(everyMs / UNIT_MS[unit])), unit }
}

/** `0 9 * * *`, `every 5m`, or `once Nov 25, 09:00`. */
export function formatSchedule(s: CronSchedule): string {
  if (s.kind === 'interval' && s.everyMs) {
    const { every, unit } = splitInterval(s.everyMs)
    return `every ${every}${UNIT_SHORT[unit]}`
  }
  if (s.kind === 'oneshot' && s.at) {
    const when = new Date(s.at)
    if (Number.isNaN(when.getTime())) return 'once'
    return `once ${when.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  return s.expr ?? s.kind
}

function span(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`
  return `${Math.round(ms / DAY)}d`
}

/** `in 3h`, `due now`, or an empty string when nothing is scheduled. */
export function formatNextRun(ms: number | undefined, now: number = Date.now()): string {
  if (!ms) return ''
  const diff = ms - now
  return diff <= 0 ? 'due now' : `in ${span(diff)}`
}

/** `Ran 5m ago`, `Failed 2h ago` or `Not run yet`. */
export function formatLastRun(state: CronJob['state'], now: number = Date.now()): string {
  if (!state?.lastRunAtMs) return 'Not run yet'
  const ago = `${span(Math.max(0, now - state.lastRunAtMs))} ago`
  return state.lastStatus === 'error' ? `Failed ${ago}` : `Ran ${ago}`
}

export type ScheduleMode = 'cron' | 'interval' | 'oneshot'

export interface CronFormValues {
  name: string
  mode: ScheduleMode
  expr: string
  every: string
  unit: IntervalUnit
  /** A `datetime-local` value: `YYYY-MM-DDTHH:mm`, in the browser's time zone. */
  at: string
  prompt: string
}

export type CronFormField = 'expr' | 'every' | 'at' | 'prompt'

export interface CronFormBody {
  name?: string
  schedule: { kind: ScheduleMode; expr?: string; everyMs?: number; at?: string }
  prompt: string
}

export type CronFormResult =
  | { ok: true; body: CronFormBody }
  | { ok: false; errors: Partial<Record<CronFormField, string>> }

export const EMPTY_FORM: CronFormValues = {
  name: '',
  mode: 'cron',
  expr: '',
  every: '1',
  unit: 'hours',
  at: '',
  prompt: ''
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** An ISO time as a `datetime-local` value in the browser's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The form's starting values: blank for a new cron, the cron's own for an edit. */
export function formFromJob(job?: CronJob): CronFormValues {
  if (!job) return { ...EMPTY_FORM }
  const base = { ...EMPTY_FORM, name: job.name, prompt: job.payload?.message ?? '' }
  const s = job.schedule
  if (s.kind === 'interval' && s.everyMs) {
    const { every, unit } = splitInterval(s.everyMs)
    return { ...base, mode: 'interval', every: String(every), unit }
  }
  if (s.kind === 'oneshot') return { ...base, mode: 'oneshot', at: s.at ? toLocalInput(s.at) : '' }
  return { ...base, mode: 'cron', expr: s.expr ?? '' }
}

/** A cron expression has 5 fields, or 6 with seconds. The server checks the rest. */
function looksLikeCron(expr: string): boolean {
  const n = expr.trim().split(/\s+/).length
  return n === 5 || n === 6
}

/** Check the form and build the request body. Each error names the field and the fix. */
export function validateCronForm(v: CronFormValues, now: number = Date.now()): CronFormResult {
  const errors: Partial<Record<CronFormField, string>> = {}
  let schedule: CronFormBody['schedule'] | undefined

  if (v.mode === 'cron') {
    if (looksLikeCron(v.expr)) schedule = { kind: 'cron', expr: v.expr.trim().split(/\s+/).join(' ') }
    else errors.expr = 'Enter 5 fields, like 0 9 * * *'
  } else if (v.mode === 'interval') {
    const every = Number(v.every)
    if (Number.isInteger(every) && every > 0) schedule = { kind: 'interval', everyMs: every * UNIT_MS[v.unit] }
    else errors.every = 'Enter a whole number above 0'
  } else {
    const when = v.at ? new Date(v.at).getTime() : NaN
    if (Number.isNaN(when)) errors.at = 'Pick a date and time'
    else if (when <= now) errors.at = 'Pick a time in the future'
    else schedule = { kind: 'oneshot', at: new Date(when).toISOString() }
  }

  if (!v.prompt.trim()) errors.prompt = 'Enter a message'

  if (!schedule || Object.keys(errors).length > 0) return { ok: false, errors }
  const name = v.name.trim()
  return { ok: true, body: { ...(name ? { name } : {}), schedule, prompt: v.prompt.trim() } }
}
