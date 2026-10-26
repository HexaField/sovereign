// Bus event → timeline lines. Pure. Only the event types in
// TIMELINE_EVENT_TYPES map to anything; every other event (chat.stream,
// tool calls, per-call metrics, graph refreshes) maps to nothing.
//
// The events carry what a line needs: each emit site adds it (a turn's
// origin, a sync's admitted event count, a rethink run's trigger). Nothing
// here reconstructs it. Forge lines come only from `forge.events`, which the
// work graph emits after its trust filter and triage, so an untrusted
// author's item or text never reaches the timeline.

import { TURN_ORIGINS, type BusEvent, type TimelineEntry, type TurnOrigin } from '@sovereign/core'

export type TimelineDraft = Omit<TimelineEntry, 'id'>

export interface MapContext {
  /** A thread's label, when the thread exists. */
  labelOf(threadId: string): string | undefined
}

/** The longest title or detail kept. */
export const MAX_TEXT = 200

export const clip = (s: string, max = MAX_TEXT): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

type P = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const originOf = (v: unknown): TurnOrigin => (TURN_ORIGINS.includes(v as TurnOrigin) ? (v as TurnOrigin) : 'system')

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** `github:github.com/owner/name#12` → `owner/name#12`; anything else as is. */
export function shortRef(id: string): string {
  const m = /^[a-z]+:[^/]+\/([^#@]+)([#@].+)$/.exec(id)
  return m ? `${m[1]}${m[2]}` : id
}

function finish(d: TimelineDraft): TimelineDraft {
  const out: TimelineDraft = { ...d, title: clip(d.title) }
  if (d.detail !== undefined) {
    const detail = clip(d.detail)
    if (detail) out.detail = detail
    else delete out.detail
  }
  for (const k of Object.keys(out) as (keyof TimelineDraft)[]) if (out[k] === undefined) delete out[k]
  return out
}

const TURN_BY: Record<TurnOrigin, string> = {
  user: '',
  cron: ' by a cron job',
  rethink: ' by Forge rethink',
  agent: ' by another thread',
  subagent: ' by a subagent result',
  system: ' by Sovereign'
}

// ── Forge ──────────────────────────────────────────────────────────────

/** One admitted forge event as `forge.events` carries it (work-graph `timelineEventOf`). */
interface ForgeLine {
  at?: string
  nodeId: string
  type: string
  triage?: string
  ref?: string
  title?: string
  url?: string
  kind?: string
  detail?: P
}

function forgeLine(e: ForgeLine, membrane: string | undefined, at: string): TimelineDraft | undefined {
  const d = (e.detail ?? {}) as P
  const item = e.kind === 'issue' ? 'Issue' : e.kind === 'change' ? 'PR' : 'Item'
  const subject = [e.ref ?? shortRef(e.nodeId), e.title].filter(Boolean).join(' ')
  const base = { at: e.at ?? at, membrane, origin: 'system' as const, url: e.url }
  const line = (action: string, title: string, detail?: string, kind: 'forge' | 'github' = 'forge') =>
    finish({ ...base, kind, action: `forge.${action}`, title, detail })
  switch (e.type) {
    case 'opened':
      return line('opened', `${item} opened: ${subject}`, str(d.author) ? `by ${d.author}` : undefined)
    case 'merged':
      return line('merged', `${item} merged: ${subject}`, str(d.into) ? `into ${d.into}` : undefined)
    case 'closed':
      return line('closed', `${item} closed: ${subject}`, d.reason === 'not_planned' ? 'not planned' : undefined)
    case 'reopened':
      return line('reopened', `${item} reopened: ${subject}`)
    case 'reviewed': {
      const state = str(d.state)?.replace(/_/g, ' ')
      return line('reviewed', `Review: ${subject}`, [state, str(d.login) && `by ${d.login}`].filter(Boolean).join(' '))
    }
    case 'ci_failed':
      return line('ci_failed', `CI failed: ${subject}`, strs(d.failed).join(', ') || undefined, 'github')
    case 'ci_passed':
      return line('ci_passed', `CI passed: ${subject}`, undefined, 'github')
    case 'conflict':
      return line('conflict', `Conflict: ${subject}`, str(d.base) ? `with ${d.base}` : undefined)
    case 'commented': {
      // Only the ones that need an agent; the text itself never leaves the forge.
      if (e.triage !== 'needs-agent') return undefined
      const n = num(d.count) ?? 1
      const by = strs(d.authors)
      return line(
        'commented',
        `Comments need an agent: ${subject}`,
        `${n} new${by.length ? ` by ${by.join(', ')}` : ''}`
      )
    }
    default:
      return undefined
  }
}

function forgeEvents(p: P, at: string): TimelineDraft[] {
  const membrane = str(p.membrane)
  if (!Array.isArray(p.events)) return []
  const events = (p.events as unknown[]).filter(
    (e): e is ForgeLine => !!e && typeof e === 'object' && typeof (e as P).type === 'string'
  )
  const count = num(p.count) ?? events.length
  const out: TimelineDraft[] = []
  const via = str(p.via) ?? 'sync'
  if (count > 0 && via !== 'plans') {
    out.push(
      finish({
        at,
        kind: 'forge',
        action: 'forge.sync',
        title:
          via === 'tracked'
            ? `Forge: ${plural(count, 'new event')} on tracked items${membrane ? ` in ${membrane}` : ''}`
            : `Forge sync: ${plural(count, 'new event')}${membrane ? ` in ${membrane}` : ''}`,
        membrane,
        origin: 'system'
      })
    )
  }
  for (const e of events) {
    const line = forgeLine(e, membrane, at)
    if (line) out.push(line)
  }
  return out
}

const RETHINK_END: Record<string, string> = {
  done: 'done',
  failed: 'failed',
  'timed-out': 'timed out'
}

function rethink(p: P, at: string, ctx: MapContext): TimelineDraft[] {
  const membrane = str(p.membrane)
  const status = str(p.status)
  if (!membrane || !status) return []
  const threadId = str(p.threadId)
  const thread = threadId ? { threadId, threadLabel: ctx.labelOf(threadId) } : {}
  if (status === 'running') {
    return [
      finish({
        at,
        kind: 'forge',
        action: 'rethink.started',
        title: `Rethink started in ${membrane}`,
        detail: str(p.trigger),
        ...thread,
        membrane,
        origin: 'rethink'
      })
    ]
  }
  const actions = num(p.actions)
  const events = num(p.events)
  const detail = [
    str(p.trigger),
    actions !== undefined ? plural(actions, 'action') : undefined,
    events !== undefined ? plural(events, 'event') : undefined,
    str(p.error)
  ]
    .filter(Boolean)
    .join(' · ')
  return [
    finish({
      at,
      kind: 'forge',
      action: `rethink.${status}`,
      title: `Rethink ${RETHINK_END[status] ?? status} in ${membrane}`,
      detail,
      ...thread,
      membrane,
      origin: 'rethink'
    })
  ]
}

function rethinkAction(p: P, at: string): TimelineDraft[] {
  const membrane = str(p.membrane)
  const base = { at, kind: 'forge' as const, membrane, origin: 'rethink' as const, detail: str(p.reason) }
  if (p.action === 'depend') {
    const from = shortRef(str(p.from) ?? '?')
    const to = shortRef(str(p.to) ?? '?')
    return [
      finish({
        ...base,
        action: 'rethink.depend',
        title: p.removed ? `Dependency removed: ${from} no longer needs ${to}` : `Dependency: ${from} needs ${to}`
      })
    ]
  }
  if (p.action === 'supersede') {
    const what = str(p.title) ? `"${p.title}"` : shortRef(str(p.nodeId) ?? '?')
    return [
      finish({ ...base, action: 'rethink.supersede', title: `Superseded: ${what} by ${shortRef(str(p.by) ?? '?')}` })
    ]
  }
  return []
}

// ── The table ──────────────────────────────────────────────────────────

type Mapper = (p: P, at: string, ctx: MapContext) => TimelineDraft[]

function threadOf(p: P, ctx: MapContext) {
  const threadId = str(p.threadId)
  if (!threadId) return { label: undefined, fields: {} }
  const label = ctx.labelOf(threadId)
  return { label: label ?? threadId.slice(0, 8), fields: { threadId, threadLabel: label } }
}

const MAPPERS: Record<string, Mapper> = {
  'chat.turn.started': (p, at, ctx) => {
    const t = threadOf(p, ctx)
    if (!t.label) return []
    const via = originOf(p.via)
    const modality = str(p.modality)
    const how = via === 'user' && modality && modality !== 'text' ? ` (${modality})` : ''
    return [
      finish({
        at,
        kind: 'agent',
        action: 'turn.started',
        title: `${t.label}: turn started${TURN_BY[via]}${how}`,
        detail: str(p.preview),
        ...t.fields,
        origin: via
      })
    ]
  },
  'chat.turn.ended': (p, at, ctx) => {
    const t = threadOf(p, ctx)
    if (!t.label) return []
    const ms = num(p.durationMs)
    const parts = [
      ms !== undefined ? `took ${formatDuration(ms)}` : undefined,
      p.reason === 'stuck' ? 'reset after 30 min without events' : undefined
    ]
    return [
      finish({
        at,
        kind: 'agent',
        action: 'turn.ended',
        title: `${t.label}: turn ended`,
        detail: parts.filter(Boolean).join(' · '),
        ...t.fields,
        origin: originOf(p.via)
      })
    ]
  },
  'chat.compacted': (p, at, ctx) => {
    const t = threadOf(p, ctx)
    if (!t.label) return []
    return [
      finish({
        at,
        kind: 'agent',
        action: 'session.compacted',
        title: `${t.label}: context compacted`,
        ...t.fields,
        origin: 'system'
      })
    ]
  },
  'chat.recycled': (p, at, ctx) => {
    const t = threadOf(p, ctx)
    if (!t.label) return []
    const pre = num(p.preTokens)
    const post = num(p.postTokens)
    const how = p.method === 'auto-recycle' ? 'auto' : str(p.method) ? 'requested' : undefined
    const tokens = pre !== undefined && post !== undefined ? `${kTokens(pre)} → ${kTokens(post)} tokens` : undefined
    return [
      finish({
        at,
        kind: 'agent',
        action: 'session.recycled',
        title: `${t.label}: session recycled`,
        detail: [how, tokens].filter(Boolean).join(' · '),
        ...t.fields,
        origin: 'system'
      })
    ]
  },
  'subagent.spawned': (p, at, ctx) => [
    finish({
      at,
      kind: 'subagent',
      action: 'subagent.spawned',
      title: `Subagent started: ${str(p.label) ?? 'subagent'}`,
      detail: str(p.task) !== str(p.label) ? str(p.task) : undefined,
      ...threadOf(p, ctx).fields,
      origin: 'subagent'
    })
  ],
  'subagent.completed': (p, at, ctx) => {
    const ms = num(p.durationMs)
    return [
      finish({
        at,
        kind: 'subagent',
        action: 'subagent.completed',
        title: `Subagent done: ${str(p.label) ?? 'subagent'}`,
        detail: ms !== undefined ? `took ${formatDuration(ms)}` : undefined,
        ...threadOf(p, ctx).fields,
        origin: 'subagent'
      })
    ]
  },
  'subagent.failed': (p, at, ctx) => {
    const label = str(p.label) ?? 'subagent'
    const stopped = p.ended === 'stopped'
    return [
      finish({
        at,
        kind: 'subagent',
        action: stopped ? 'subagent.stopped' : 'subagent.failed',
        title: stopped
          ? `Subagent stopped: ${label}`
          : p.ended === 'timed-out'
            ? `Subagent timed out: ${label}`
            : `Subagent failed: ${label}`,
        detail: stopped ? undefined : str(p.error),
        ...threadOf(p, ctx).fields,
        origin: 'subagent'
      })
    ]
  },
  'scheduler.job.started': (p, at) => {
    const job = (p.job ?? {}) as P
    const name = str(job.name)
    if (!name) return []
    const system = strs(job.tags).includes('system')
    return [
      finish({
        at,
        kind: 'scheduler',
        action: 'job.fired',
        title: `Job fired: ${name}`,
        origin: system ? 'system' : 'cron'
      })
    ]
  },
  'scheduler.job.failed': (p, at) => {
    const job = (p.job ?? {}) as P
    const name = str(p.jobName) ?? str(job.name) ?? str(p.jobId) ?? 'job'
    return [
      finish({
        at,
        kind: 'scheduler',
        action: 'job.failed',
        title: `Job failed: ${name}`,
        detail: str(p.error),
        origin: strs(job.tags).includes('system') ? 'system' : 'cron'
      })
    ]
  },
  'ci.watch.ended': (p, at, ctx) => {
    const target = str(p.target) ?? str(p.repo)
    if (!target) return []
    const result = str(p.result)
    const base = { at, kind: 'github' as const, ...threadOf(p, ctx).fields, origin: 'system' as const, url: str(p.url) }
    if (result === 'failed')
      return [
        finish({ ...base, action: 'ci.failed', title: `CI failed on ${target}`, detail: strs(p.failed).join(', ') })
      ]
    if (result === 'passed') return [finish({ ...base, action: 'ci.passed', title: `CI passed on ${target}` })]
    return [
      finish({ ...base, action: 'ci.stopped', title: `Stopped watching CI on ${target}`, detail: str(p.message) })
    ]
  },
  'forge.events': (p, at) => forgeEvents(p, at),
  'forge.rethink': (p, at, ctx) => rethink(p, at, ctx),
  'forge.rethink.action': (p, at) => rethinkAction(p, at)
}

/** The bus event types the timeline subscribes to. */
export const TIMELINE_EVENT_TYPES: readonly string[] = Object.keys(MAPPERS)

export function mapEvent(event: BusEvent, ctx: MapContext): TimelineDraft[] {
  const mapper = MAPPERS[event.type]
  const p = event.payload
  if (!mapper || !p || typeof p !== 'object') return []
  try {
    return mapper(p as P, event.timestamp, ctx)
  } catch {
    return []
  }
}
