// Kanban — pure: the panel's shown nodes in, the immediate work in columns out.
// Only open PRs and open issues get a card. A PR stacked on another open PR
// waits for it, so only the bottom of a stack shows (listing the whole stack);
// an issue an open PR closes rides on that PR's card instead of its own.

import type { AgentOverlay, WorkEdge, WorkNode, WorkNodeState, WorkStream } from '@sovereign/core'
import { isOpenChange, stackModel } from './stacks.js'

export type KanbanColumn = 'ready' | 'needs-work' | 'in-review' | 'in-progress' | 'todo'

/** Left → right in order of progress. */
export const KANBAN_COLUMNS: { id: KanbanColumn; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'needs-work', title: 'Needs work' },
  { id: 'in-review', title: 'In review' },
  { id: 'ready', title: 'Ready to merge' }
]

/** A change paired with a PR, as "owner/name#N". */
export interface KanbanPair {
  id: string
  label: string
  state: WorkNodeState
}

/** One PR of a stack, as its bottom card lists it. */
export interface KanbanStackRow {
  node: WorkNode
  /** 1 at the bottom. */
  position: number
  /** "#N", or "owner/name#N" from another repo than the bottom's. */
  ref: string
  pairs: KanbanPair[]
}

export interface KanbanCard {
  node: WorkNode
  column: KanbanColumn
  /** The stack this PR is the bottom of, bottom → top, itself first; empty when not stacked. */
  stack: KanbanStackRow[]
  /** The changes paired with this PR. */
  pairs: KanbanPair[]
  /** Open issues the PR (or a PR stacked on it) closes, as "#N" or "owner/name#N" from another repo. */
  closes: string[]
  /** The owning epic's name. */
  epic?: string
}

const isOpenIssue = (n: WorkNode | undefined): n is WorkNode => !!n && n.kind === 'issue' && n.state === 'open'

/** The column of one open PR or issue; the first rule that matches wins. */
export function kanbanColumn(n: WorkNode, overlay: AgentOverlay | undefined): KanbanColumn {
  if (n.kind === 'change') {
    const changesRequested = n.reviewers.some((r) => r.state === 'changes_requested')
    const approved = n.reviewers.some((r) => r.state === 'approved')
    const conflict = n.branch?.conflict === true
    const ciOk = !n.ci || n.ci === 'passing' || n.ci === 'none'
    if (n.state === 'open' && approved && !changesRequested && ciOk && !conflict) return 'ready'
    if (n.ci === 'failing' || changesRequested || conflict) return 'needs-work'
    if (n.state === 'open') return 'in-review'
    return 'in-progress'
  }
  const owned = !!overlay && (!!overlay.thread || overlay.subagents.length > 0)
  return owned || n.assignees.length > 0 ? 'in-progress' : 'todo'
}

export interface KanbanInput {
  /** Every loaded node: blocking and closing are read from all of them, not only the shown ones. */
  nodesById: Map<string, WorkNode>
  edges: WorkEdge[]
  /** The ids the panel's filters and epic focus leave shown (panelShown). */
  shown: Set<string>
  overlays: Map<string, AgentOverlay>
  streams: WorkStream[]
}

export function kanbanCards(input: KanbanInput): Map<KanbanColumn, KanbanCard[]> {
  const { nodesById, edges, shown, overlays } = input
  const stacks = stackModel(nodesById, edges)
  const closesOf = new Map<string, WorkNode[]>()
  const closedByOpenPr = new Set<string>()
  for (const e of edges) {
    const from = nodesById.get(e.from)
    const to = nodesById.get(e.to)
    if (e.kind === 'closes' && isOpenChange(from) && isOpenIssue(to)) {
      closedByOpenPr.add(to.id)
      closesOf.set(from.id, [...(closesOf.get(from.id) ?? []), to])
    }
  }

  const streamName = new Map(input.streams.map((s) => [s.id, s.name]))
  const refLabel = (pr: WorkNode, i: WorkNode): string =>
    i.repo && i.repo !== pr.repo ? `${i.repo}#${i.number}` : `#${i.number}`
  const pairsOf = (id: string): KanbanPair[] =>
    (stacks.pairs.get(id) ?? []).map((p) => {
      const n = nodesById.get(p)!
      return { id: p, label: `${n.repo}#${n.number}`, state: n.state }
    })

  const cards: KanbanCard[] = []
  for (const id of shown) {
    const n = nodesById.get(id)
    if (!n) continue
    if (isOpenChange(n)) {
      const members = stacks.stackOf.get(id)?.members ?? [id]
      if (members[0] !== id) continue
      const closes = [...new Set(members.flatMap((s) => (closesOf.get(s) ?? []).map((i) => refLabel(n, i))))]
      const stack =
        members.length > 1
          ? members.map((m, i) => {
              const node = nodesById.get(m)!
              return { node, position: i + 1, ref: refLabel(n, node), pairs: pairsOf(m) }
            })
          : []
      cards.push(card(n, overlays.get(id), stack, pairsOf(id), closes, streamName))
    } else if (isOpenIssue(n) && !closedByOpenPr.has(id)) {
      cards.push(card(n, overlays.get(id), [], [], [], streamName))
    }
  }
  const out = new Map<KanbanColumn, KanbanCard[]>(KANBAN_COLUMNS.map((c) => [c.id, []]))
  for (const c of cards) out.get(c.column)!.push(c)
  for (const list of out.values())
    list.sort((a, b) => b.node.updatedAt.localeCompare(a.node.updatedAt) || a.node.id.localeCompare(b.node.id))
  return out
}

function card(
  node: WorkNode,
  overlay: AgentOverlay | undefined,
  stack: KanbanStackRow[],
  pairs: KanbanPair[],
  closes: string[],
  streamName: Map<string, string>
): KanbanCard {
  const owner = node.workstreams[0]
  return {
    node,
    column: kanbanColumn(node, overlay),
    stack,
    pairs,
    closes,
    ...(owner ? { epic: streamName.get(owner) ?? owner } : {})
  }
}

/** What the Forge shows: the graph panels' canvases, their Kanbans, or the membrane's decisions. */
export type ForgeMode = 'graph' | 'kanban' | 'decisions'
/** What one graph panel draws. */
export type PanelMode = Exclude<ForgeMode, 'decisions'>

export const parseForgeMode = (v: string | null | undefined): ForgeMode =>
  v === 'kanban' || v === 'decisions' ? v : 'graph'
