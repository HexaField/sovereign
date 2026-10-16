// Node card model — pure. What the card shows, and the assign request it sends.

import type { AgentOverlay, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { EDGE_LABELS, EDGE_LABELS_IN } from './style.js'

export interface LinkedItem {
  id: string
  node?: WorkNode
  edge: WorkEdge
  /** 'out' = this node is the edge's `from`. */
  direction: 'out' | 'in'
}

export interface LinkedGroup {
  key: string
  label: string
  items: LinkedItem[]
}

const GROUP_ORDER: WorkEdge['kind'][] = [
  'base',
  'paired',
  'closes',
  'merged-into',
  'plans',
  'subtask',
  'references',
  'related'
]

/** Linked nodes, grouped by edge kind and direction, in a fixed order. Self-loops skipped. */
export function linkedGroups(nodeId: string, edges: WorkEdge[], nodesById: Map<string, WorkNode>): LinkedGroup[] {
  const groups = new Map<string, LinkedGroup>()
  for (const e of edges) {
    if (e.from === e.to) continue
    let direction: 'out' | 'in'
    if (e.from === nodeId) direction = 'out'
    else if (e.to === nodeId) direction = 'in'
    else continue
    // "Paired" and "related" read the same both ways.
    const symmetric = e.kind === 'paired' || e.kind === 'related'
    const key = symmetric ? e.kind : `${e.kind}:${direction}`
    const label = direction === 'out' || symmetric ? EDGE_LABELS[e.kind] : EDGE_LABELS_IN[e.kind]
    const id = direction === 'out' ? e.to : e.from
    let g = groups.get(key)
    if (!g) {
      g = { key, label, items: [] }
      groups.set(key, g)
    }
    if (!g.items.some((i) => i.id === id)) g.items.push({ id, node: nodesById.get(id), edge: e, direction })
  }
  const rank = (key: string): number => {
    const [kind, dir] = key.split(':')
    return GROUP_ORDER.indexOf(kind as WorkEdge['kind']) * 2 + (dir === 'in' ? 1 : 0)
  }
  const out = [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key))
  for (const g of out) g.items.sort((a, b) => (a.node?.number ?? 0) - (b.node?.number ?? 0) || (a.id < b.id ? -1 : 1))
  return out
}

/** "coasys/ad4m#12" → "ad4m#12"; plans and tasks by title. */
export function shortRef(n: WorkNode): string {
  if (n.number !== undefined && n.repo) return `${n.repo.split('/').pop()}#${n.number}`
  if (n.kind === 'branch' && n.branch) return n.branch.head
  return n.title
}

export function kindLabel(n: WorkNode): string {
  return { change: 'Pull request', issue: 'Issue', branch: 'Branch', plan: 'Plan', task: 'Task' }[n.kind]
}

/** The "New thread" label prefilled from the node. */
export function defaultThreadLabel(n: WorkNode): string {
  const base = n.number !== undefined && n.repo ? `${shortRef(n)} ${n.title}` : n.title
  return base.length > 60 ? `${base.slice(0, 59)}…` : base
}

/** The assign prompt's default text (plan §8). */
export function defaultPrompt(n: WorkNode): string {
  const target = n.url ?? (n.kind === 'plan' ? `the plan "${n.title}" (${n.id.replace(/^plan:/, '')})` : `"${n.title}"`)
  switch (n.kind) {
    case 'change':
      return `Work on ${target}: fetch the PR, its comments and CI, then address the review comments and failing checks, merge the base in if it is behind, and push.`
    case 'issue':
      return `Work on ${target}: fetch the issue, its comments and any linked PRs, then fix it on a branch and open a PR that closes it.`
    case 'branch':
      return `Work on the branch ${n.branch?.head ?? n.title}${n.repo ? ` in ${n.repo}` : ''}: fetch it, compare it with its base, then finish the work and open a PR.`
    case 'plan':
      return `Work on ${target}: read the plan and the PRs and issues it names, then take the next open step.`
    case 'task':
    default:
      return `Work on the task ${target}: read its parent streams and linked items, then do it and report back.`
  }
}

export interface AssignChoice {
  nodeId: string
  /** Existing thread id, or null for a new thread. */
  threadId: string | null
  newLabel?: string
  prompt?: string
}

export interface AssignBody {
  nodeId: string
  threadId?: string
  newThread?: { label: string }
  prompt?: string
}

/** POST /api/forge/assign body; throws on a choice that names neither a thread nor a label. */
export function assignBody(c: AssignChoice): AssignBody {
  const body: AssignBody = { nodeId: c.nodeId }
  if (c.threadId) body.threadId = c.threadId
  else {
    const label = c.newLabel?.trim()
    if (!label) throw new Error('A new thread needs a label')
    body.newThread = { label }
  }
  const prompt = c.prompt?.trim()
  if (prompt) body.prompt = prompt
  return body
}

/** Streams the node sits in, and the child tasks (subtask edges out of it). */
export function taskSection(n: WorkNode, streams: WorkStream[], edges: WorkEdge[], nodesById: Map<string, WorkNode>) {
  const byId = new Map(streams.map((s) => [s.id, s]))
  return {
    streams: n.workstreams.map((id) => byId.get(id) ?? { id, name: id, membrane: '', memberCount: 0 }),
    children: edges
      .filter((e) => e.kind === 'subtask' && e.from === n.id)
      .map((e) => nodesById.get(e.to))
      .filter((x): x is WorkNode => !!x),
    /** Streams it could be added to. */
    addable: streams.filter((s) => !n.workstreams.includes(s.id))
  }
}

export type AgentLine = { label: string; tone: 'working' | 'waiting' | 'idle' | 'none' }

export function agentStatusLine(o: AgentOverlay | undefined): AgentLine {
  if (!o || (!o.thread && o.subagents.length === 0)) return { label: 'No agent', tone: 'none' }
  if (o.thread && o.thread.status !== 'idle')
    return { label: o.thread.status === 'thinking' ? 'Thinking' : 'Working', tone: 'working' }
  if (o.waitingOn === 'ci' || o.ciWatch?.state === 'waiting') return { label: 'Waiting for CI', tone: 'waiting' }
  if (o.waitingOn === 'review') return { label: 'Waiting for review', tone: 'waiting' }
  if (o.waitingOn === 'josh') return { label: 'Waiting for you', tone: 'waiting' }
  if (o.subagents.length)
    return { label: `${o.subagents.length} subagent${o.subagents.length > 1 ? 's' : ''} running`, tone: 'working' }
  return { label: 'Idle', tone: 'idle' }
}

/** Rethink-sourced edges touching the node: what Loop 2 did here. */
export function rethinkNotes(nodeId: string, edges: WorkEdge[]): WorkEdge[] {
  return edges.filter((e) => e.source === 'rethink' && (e.from === nodeId || e.to === nodeId))
}
