// Rethink (Loop 2) in the Forge tab: the "Rethink now" status line, the run
// list, and the card's rethink notes. Pure, so it is tested without a DOM.

import type { RethinkNote, WorkEdge } from '@sovereign/core'

/** POST /api/forge/rethink. */
export interface RethinkStart {
  membrane?: string
  ran: boolean
  count: number
  runId?: string
}

/** One entry of GET /api/forge/rethink/runs (server: RethinkRunSummary). */
export interface RethinkRunSummary {
  id: string
  membrane: string
  trigger: 'schedule' | 'manual' | 'chat'
  status: 'running' | 'done' | 'timed-out' | 'failed'
  startedAt: string
  endedAt?: string
  events: number
  /** `epic`: changes to the epics (forge_stream_* tools); absent in reports from before those tools. */
  actions: Record<'relate' | 'stream' | 'dispatch' | 'draft' | 'attention' | 'note' | 'refused', number> & {
    epic?: number
  }
  limitsHit: number
  tokens?: number
  path: string
}

export interface RethinkRuns {
  membrane: string
  threadId: string | null
  active: { id: string; startedAt: string; trigger: RethinkRunSummary['trigger'] } | null
  runs: RethinkRunSummary[]
}

export type RethinkPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running'; runId: string }
  | { phase: 'skipped' }
  | { phase: 'done'; run: RethinkRunSummary }
  | { phase: 'failed'; error: string }

/** After POST /api/forge/rethink. */
export function phaseAfterStart(res: RethinkStart | undefined): RethinkPhase {
  if (!res || !res.ran) return { phase: 'skipped' }
  return res.runId ? { phase: 'running', runId: res.runId } : { phase: 'starting' }
}

/** After a run list refresh: a running phase moves to done once its run has ended. */
export function phaseAfterRuns(current: RethinkPhase, runs: RethinkRuns): RethinkPhase {
  if (current.phase !== 'running' && current.phase !== 'starting' && current.phase !== 'idle') return current
  if (runs.active) return { phase: 'running', runId: runs.active.id }
  if (current.phase === 'idle') return current
  const run = current.phase === 'running' ? runs.runs.find((r) => r.id === current.runId) : runs.runs[0]
  return run && run.status !== 'running' ? { phase: 'done', run } : current
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function actionCount(run: RethinkRunSummary): number {
  const a = run.actions
  return a.relate + a.stream + a.dispatch + a.draft + a.attention + a.note + (a.epic ?? 0)
}

export function phaseLabel(p: RethinkPhase): string | null {
  switch (p.phase) {
    case 'idle':
      return null
    case 'starting':
    case 'running':
      return 'Rethink running…'
    case 'skipped':
      return 'Rethink skipped: nothing new since the last run'
    case 'done': {
      const r = p.run
      const status = r.status === 'done' ? 'done' : r.status === 'timed-out' ? 'timed out' : 'failed'
      return `Rethink ${status}: ${plural(actionCount(r), 'action')}${r.limitsHit ? `, ${plural(r.limitsHit, 'limit')} hit` : ''}`
    }
    case 'failed':
      return `Rethink failed: ${p.error}`
  }
}

/** "Last run" link text. */
export function runLinkLabel(run: RethinkRunSummary): string {
  const when = new Date(run.startedAt)
  const t = Number.isNaN(when.getTime())
    ? run.id
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `Last rethink: ${t}${run.status === 'running' ? ' (running)' : ''}`
}

export interface CardRethinkItem {
  at?: string
  /** Short tag shown before the text. */
  tag: string
  text: string
  /** For a rethink edge: the node at the other end. */
  otherId?: string
  confidence?: number
  runId?: string
}

const TAGS: Record<RethinkNote['kind'], string> = {
  note: 'Note',
  dispatch: 'Job',
  draft: 'Draft',
  attention: 'Told you'
}

/** The card's "Rethink notes": the node's notes (newest first), then its rethink edges. */
export function cardRethinkItems(
  nodeId: string,
  notes: RethinkNote[] | undefined,
  edges: WorkEdge[]
): CardRethinkItem[] {
  const out: CardRethinkItem[] = [...(notes ?? [])]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((n) => ({ at: n.at, tag: TAGS[n.kind] ?? n.kind, text: n.text, ...(n.runId ? { runId: n.runId } : {}) }))
  for (const e of edges) {
    if (e.source !== 'rethink' || (e.from !== nodeId && e.to !== nodeId)) continue
    out.push({
      tag: e.kind,
      text: e.reason ?? '',
      otherId: e.from === nodeId ? e.to : e.from,
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {})
    })
  }
  return out
}
