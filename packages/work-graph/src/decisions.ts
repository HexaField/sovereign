// Decisions: questions agents leave for the user (decision_open) instead of
// asking in chat. Stored in the Forge meta store through the TaskPort, per
// membrane. Resolving several at once sends ONE message per receiving thread,
// holding every resolution meant for it; a decision with no thread sends
// nothing. Closing (decision_close) records a resolution and sends nothing.

import { randomUUID } from 'node:crypto'
import {
  DECISION_SOURCE_KINDS,
  type Decision,
  type DecisionDelivery,
  type DecisionSource,
  type DecisionStatus,
  type TaskPort
} from '@sovereign/core'

export class DecisionError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const bad = (message: string) => new DecisionError(message, 400)

export interface DecisionInput {
  question: string
  context?: string
  options?: string[]
  source?: DecisionSource
  group?: string
  threadId?: string
  /** A thread id, or 'user'. */
  createdBy?: string
}

/** Fields an edit may change; null (or '') clears group and threadId. */
export interface DecisionPatch {
  question?: string
  context?: string | null
  options?: string[] | null
  group?: string | null
  threadId?: string | null
}

export interface ResolveResult {
  resolved: Decision[]
  /** One per receiving thread, in the order its first decision came in the request. */
  deliveries: DecisionDelivery[]
}

export interface DecisionService {
  /** `status` 'all' (default) lists both; newest first. */
  list(membrane: string, status?: DecisionStatus | 'all'): Promise<Decision[]>
  open(membrane: string, input: DecisionInput): Promise<Decision>
  update(membrane: string, id: string, patch: DecisionPatch): Promise<Decision>
  /** Set a group and/or a thread on many decisions at once. */
  group(
    membrane: string,
    ids: string[],
    patch: { group?: string | null; threadId?: string | null }
  ): Promise<Decision[]>
  /** Resolve each item, then send each receiving thread one message with all of its resolutions. */
  resolve(membrane: string, items: Array<{ id: string; resolution: string }>): Promise<ResolveResult>
  /** Record a resolution reached elsewhere; sends nothing. The membrane, when given, must be the decision's. */
  close(id: string, resolution: string, membrane?: string): Promise<Decision>
}

export interface DecisionServiceDeps {
  tasks: Pick<TaskPort, 'listDecisions' | 'getDecision' | 'putDecision'>
  /** Delivers a message into a thread as a user message (the chat queue). */
  send(threadId: string, text: string): Promise<void>
  /** Called with the membrane after every change (forge.updated). */
  changed(membrane: string): void
  now?: () => number
}

export const DECISION_ID_PREFIX = 'forge-decision://'

export function newDecisionId(membrane: string): string {
  return `${DECISION_ID_PREFIX}${encodeURIComponent(membrane)}/${randomUUID()}`
}

/** One line: whitespace runs, newlines included, become one space. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function cleanOptions(options: unknown): string[] {
  if (options === undefined || options === null) return []
  if (!Array.isArray(options) || options.some((o) => typeof o !== 'string')) throw bad('options must be strings')
  return [...new Set(options.map(oneLine).filter(Boolean))]
}

export function cleanSource(source: unknown): DecisionSource | undefined {
  if (source === undefined || source === null) return undefined
  const s = source as Partial<DecisionSource>
  if (typeof s !== 'object' || !DECISION_SOURCE_KINDS.includes(s.kind as never))
    throw bad(`source.kind must be one of ${DECISION_SOURCE_KINDS.join(', ')}`)
  if (!isText(s.ref)) throw bad('source.ref is required')
  if (s.label !== undefined && typeof s.label !== 'string') throw bad('source.label must be a string')
  return { kind: s.kind!, ref: s.ref.trim(), ...(isText(s.label) ? { label: oneLine(s.label) } : {}) }
}

/** How a decision's source reads in a message. */
export function sourceLabel(source: DecisionSource | undefined): string | undefined {
  return source ? (source.label ?? source.ref) : undefined
}

/**
 * The message a thread gets for its resolved decisions:
 *
 *   [Decisions resolved]
 *   1. <question>
 *      → <resolution>
 *      (source: <label>)
 */
export function formatResolutions(decisions: Array<Pick<Decision, 'question' | 'resolution' | 'source'>>): string {
  const lines = ['[Decisions resolved]']
  decisions.forEach((d, i) => {
    const prefix = `${i + 1}. `
    const pad = ' '.repeat(prefix.length)
    lines.push(`${prefix}${d.question}`)
    lines.push(`${pad}→ ${(d.resolution ?? '').trim().split('\n').join(`\n${pad}  `)}`)
    const label = sourceLabel(d.source)
    if (label) lines.push(`${pad}(source: ${label})`)
  })
  return lines.join('\n')
}

export function createDecisionService(deps: DecisionServiceDeps): DecisionService {
  const now = deps.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const needMembrane = (membrane: string) => {
    if (!isText(membrane)) throw bad('membrane is required')
    return membrane
  }
  const find = async (membrane: string, id: string): Promise<Decision> => {
    const d = await deps.tasks.getDecision(id)
    if (!d || d.membrane !== membrane) throw new DecisionError(`no decision ${id} in ${membrane}`, 404)
    return d
  }
  const text = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw bad(`${name} must be a string`)
    return v.trim() || undefined
  }
  /** Applies a nullable string field: undefined keeps it, null or '' clears it. */
  const apply = <K extends 'group' | 'threadId' | 'context'>(d: Decision, key: K, v: unknown) => {
    if (v === undefined) return
    const raw = text(v, key)
    const t = raw && key !== 'context' ? oneLine(raw) : raw
    if (t) d[key] = t
    else delete d[key]
  }

  return {
    async list(membrane, status = 'all') {
      const all = await deps.tasks.listDecisions(needMembrane(membrane))
      return all
        .filter((d) => status === 'all' || d.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async open(membrane, input) {
      needMembrane(membrane)
      if (!isText(input.question)) throw bad('question is required')
      const options = cleanOptions(input.options)
      const source = cleanSource(input.source)
      const d: Decision = {
        id: newDecisionId(membrane),
        membrane,
        question: oneLine(input.question),
        status: 'open',
        createdAt: iso()
      }
      apply(d, 'context', input.context)
      if (options.length) d.options = options
      if (source) d.source = source
      apply(d, 'group', input.group)
      apply(d, 'threadId', input.threadId)
      const by = text(input.createdBy, 'createdBy')
      if (by) d.createdBy = by
      const saved = await deps.tasks.putDecision(d)
      deps.changed(membrane)
      return saved
    },

    async update(membrane, id, patch) {
      const d = await find(needMembrane(membrane), id)
      if (patch.question !== undefined) {
        if (!isText(patch.question)) throw bad('question cannot be empty')
        d.question = oneLine(patch.question)
      }
      apply(d, 'context', patch.context)
      if (patch.options !== undefined) {
        const options = cleanOptions(patch.options)
        if (options.length) d.options = options
        else delete d.options
      }
      apply(d, 'group', patch.group)
      apply(d, 'threadId', patch.threadId)
      const saved = await deps.tasks.putDecision(d)
      deps.changed(membrane)
      return saved
    },

    async group(membrane, ids, patch) {
      needMembrane(membrane)
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => !isText(id))) throw bad('ids must be decision ids')
      if (patch.group === undefined && patch.threadId === undefined) throw bad('give a group, a threadId, or both')
      const found = await Promise.all([...new Set(ids)].map((id) => find(membrane, id)))
      const out: Decision[] = []
      for (const d of found) {
        apply(d, 'group', patch.group)
        apply(d, 'threadId', patch.threadId)
        out.push(await deps.tasks.putDecision(d))
      }
      deps.changed(membrane)
      return out
    },

    async resolve(membrane, items) {
      needMembrane(membrane)
      if (!Array.isArray(items) || !items.length) throw bad('items must be [{ id, resolution }]')
      const seen = new Set<string>()
      for (const it of items) {
        if (!it || !isText(it.id)) throw bad('every item needs an id')
        if (!isText(it.resolution)) throw bad(`a resolution is required for ${it.id}`)
        if (seen.has(it.id)) throw bad(`${it.id} is listed twice`)
        seen.add(it.id)
      }
      // Check every item before changing any, so a bad one leaves the rest open.
      const found = await Promise.all(items.map((it) => find(membrane, it.id)))
      const done = found.find((d) => d.status === 'resolved')
      if (done) throw new DecisionError(`already resolved: ${done.question}`, 409)

      const at = iso()
      const resolved: Decision[] = []
      for (let i = 0; i < found.length; i++) {
        const d: Decision = { ...found[i], status: 'resolved', resolution: items[i].resolution.trim(), resolvedAt: at }
        resolved.push(await deps.tasks.putDecision(d))
      }
      deps.changed(membrane)

      const byThread = new Map<string, Decision[]>()
      for (const d of resolved) {
        if (!d.threadId) continue
        byThread.set(d.threadId, [...(byThread.get(d.threadId) ?? []), d])
      }
      const deliveries: DecisionDelivery[] = []
      for (const [threadId, list] of byThread) {
        const ids = list.map((d) => d.id)
        try {
          await deps.send(threadId, formatResolutions(list))
          deliveries.push({ threadId, ids, sent: true })
        } catch (err) {
          deliveries.push({ threadId, ids, sent: false, error: (err as Error)?.message ?? String(err) })
        }
      }
      return { resolved, deliveries }
    },

    async close(id, resolution, membrane) {
      if (!isText(id)) throw bad('id is required')
      if (!isText(resolution)) throw bad('resolution is required')
      const d = await deps.tasks.getDecision(id)
      if (!d || (membrane !== undefined && d.membrane !== membrane))
        throw new DecisionError(`no decision ${id}${membrane ? ` in ${membrane}` : ''}`, 404)
      if (d.status === 'resolved') throw new DecisionError(`already resolved: ${d.question}`, 409)
      const saved = await deps.tasks.putDecision({
        ...d,
        status: 'resolved',
        resolution: resolution.trim(),
        resolvedAt: iso()
      })
      deps.changed(d.membrane)
      return saved
    }
  }
}
