// Loop 1 event log and triage, and the digest Loop 2 reads.
//
// Every event goes to an append-only <dataDir>/forge/<membrane>/events.jsonl.
// Triage: fixed rules first; the decision model for what the rules leave
// open (needs-agent | info, at least THRESHOLD confident, else needs-agent);
// with no model answer, needs-agent. Coverage per tier is counted.

import fs from 'node:fs'
import path from 'node:path'
import type { WorkNode, WorkStream } from '@sovereign/core'
import type {
  DigestGroup,
  ForgeClassifier,
  ForgeDigest,
  ForgeEvent,
  TriageCoverage,
  TriagedEvent,
  TriageVerdict
} from './types.js'

export const TRIAGE_THRESHOLD = 0.7

export interface TriageContext {
  node?: WorkNode
  /** The node's task has an owner thread. */
  owned: boolean
  /** The node has a task at all (tracked). */
  tracked: (nodeId: string) => boolean
  /** The membrane's forge identity. */
  identity?: string
  /** Extra words that count as a mention. */
  mentions: string[]
}

function mentioned(text: string, ctx: TriageContext): boolean {
  const words = [...(ctx.identity ? [`@${ctx.identity}`] : []), ...ctx.mentions].filter(Boolean)
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\w@])${esc}(?![\\w-])`, 'i').test(text)
  })
}

const approved = (n?: WorkNode) =>
  Boolean(
    n?.reviewers.some((r) => r.state === 'approved') && !n?.reviewers.some((r) => r.state === 'changes_requested')
  )

/** The fixed rules: a verdict, or undefined when they cannot place the event. */
export function ruleTriage(e: ForgeEvent, ctx: TriageContext): TriageVerdict | undefined {
  const d = e.detail as Record<string, any>
  const me = ctx.identity?.toLowerCase()
  switch (e.type) {
    case 'ci_failed':
      return ctx.owned ? 'needs-agent' : 'info'
    case 'reviewed':
      if (d.state === 'changes_requested') return 'needs-agent'
      if (d.state === 'commented' && ctx.owned) return undefined
      return 'info'
    case 'conflict':
      return 'needs-agent'
    case 'behind_base':
      return approved(ctx.node) ? 'needs-agent' : 'info'
    case 'base_merged':
      return ctx.owned ? 'needs-agent' : 'info'
    case 'commented': {
      const text = Array.isArray(d.text) ? d.text.join('\n') : String(d.text ?? '')
      if (mentioned(text, ctx)) return 'needs-agent'
      return ctx.owned ? undefined : 'info'
    }
    case 'referenced':
      return d.byKind === 'issue' && ctx.node?.kind === 'change' && ctx.tracked(e.nodeId) ? 'needs-agent' : 'info'
    case 'assigned': {
      const added: string[] = Array.isArray(d.added) ? d.added : []
      return me && added.some((a) => a.toLowerCase() === me) && !ctx.owned ? 'needs-agent' : 'info'
    }
    case 'review_requested': {
      const who = String(d.login ?? '').toLowerCase()
      if (me && who === me) return 'needs-agent'
      if (ctx.mentions.some((m) => m.toLowerCase() === who)) return 'needs-agent'
      return 'info'
    }
    case 'reopened':
    case 'stale':
      return ctx.owned ? undefined : 'info'
    case 'plan_changed':
      return undefined
    case 'opened':
    case 'merged':
    case 'closed':
    case 'pushed':
    case 'ci_passed':
    case 'labelled':
      return 'info'
  }
}

export function emptyCoverage(): TriageCoverage {
  return { rule: { info: 0, needsAgent: 0 }, model: { info: 0, needsAgent: 0 }, modelLow: 0, unavailable: 0 }
}

export function countTier(cov: TriageCoverage, e: Pick<TriagedEvent, 'tier' | 'triage'>): void {
  if (e.tier === 'rule') cov.rule[e.triage === 'info' ? 'info' : 'needsAgent']++
  else if (e.tier === 'model') cov.model[e.triage === 'info' ? 'info' : 'needsAgent']++
  else if (e.tier === 'model-low') cov.modelLow++
  else cov.unavailable++
}

/** Rules, then the classifier, then needs-agent. */
export async function triage(
  e: ForgeEvent,
  ctx: TriageContext,
  classifier: ForgeClassifier | undefined
): Promise<TriagedEvent> {
  const verdict = ruleTriage(e, ctx)
  if (verdict) return { ...e, triage: verdict, tier: 'rule' }
  let answer: { choice: TriageVerdict; confidence: number } | undefined
  try {
    answer = classifier
      ? await classifier.classify({ event: e, ...(ctx.node ? { node: ctx.node } : {}), owned: ctx.owned })
      : undefined
  } catch {
    answer = undefined
  }
  if (!answer || !Number.isFinite(answer.confidence)) return { ...e, triage: 'needs-agent', tier: 'unavailable' }
  if (answer.confidence < TRIAGE_THRESHOLD) {
    return { ...e, triage: 'needs-agent', tier: 'model-low', confidence: answer.confidence }
  }
  return { ...e, triage: answer.choice, tier: 'model', confidence: answer.confidence }
}

// ── Log ──────────────────────────────────────────────────────────────

export interface EventLog {
  file: string
  append(events: TriagedEvent[]): void
  /** Events after `since` (exclusive ISO time), oldest first. */
  read(opts?: { since?: string; verdict?: TriageVerdict; nodeId?: string }): TriagedEvent[]
  coverage(): TriageCoverage
}

export function safeSegment(s: string): string {
  return s.replace(/[^\w.-]+/g, '_') || '_'
}

export function createEventLog(dataDir: string, membrane: string): EventLog {
  const file = path.join(dataDir, 'forge', safeSegment(membrane), 'events.jsonl')
  const cov = emptyCoverage()
  const readAll = (): TriagedEvent[] => {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: TriagedEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return out
  }
  for (const e of readAll()) countTier(cov, e)
  return {
    file,
    append(events) {
      if (!events.length) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      for (const e of events) countTier(cov, e)
    },
    read(opts = {}) {
      return readAll().filter(
        (e) =>
          (!opts.since || e.at > opts.since) &&
          (!opts.verdict || e.triage === opts.verdict) &&
          (!opts.nodeId || e.nodeId === opts.nodeId)
      )
    },
    coverage: () => structuredClone(cov)
  }
}

// ── Digest ───────────────────────────────────────────────────────────

/**
 * needs-agent events since a cursor, grouped by stream then node, each node
 * with its card data. A node in several streams is listed under its first.
 */
export function buildDigest(
  membrane: string,
  events: TriagedEvent[],
  nodes: Map<string, WorkNode>,
  streams: WorkStream[],
  since?: string
): ForgeDigest {
  const owed = events.filter((e) => e.triage === 'needs-agent' && (!since || e.at > since))
  const streamName = new Map(streams.map((s) => [s.id, s.name]))
  const groups = new Map<string, DigestGroup>()
  const byNode = new Map<string, { group: DigestGroup; index: number }>()
  let count = 0
  for (const e of owed) {
    const node = nodes.get(e.nodeId)
    if (!node) continue
    const sid = node.workstreams.find((w) => streamName.has(w)) ?? null
    const gk = sid ?? ''
    let group = groups.get(gk)
    if (!group) {
      group = { stream: sid ? { id: sid, name: streamName.get(sid)! } : null, nodes: [] }
      groups.set(gk, group)
    }
    let slot = byNode.get(e.nodeId)
    if (!slot) {
      slot = { group, index: group.nodes.push({ node, events: [] }) - 1 }
      byNode.set(e.nodeId, slot)
    }
    slot.group.nodes[slot.index].events.push(e)
    count++
  }
  const ordered = [...groups.values()].sort(
    (a, b) => (a.stream ? 0 : 1) - (b.stream ? 0 : 1) || (a.stream?.name ?? '').localeCompare(b.stream?.name ?? '')
  )
  const last = owed.length ? owed[owed.length - 1].at : since
  return { membrane, ...(since ? { since } : {}), ...(last ? { cursor: last } : {}), count, groups: ordered }
}
