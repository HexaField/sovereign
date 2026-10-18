// Kanban — pure: the panel's shown nodes in, the immediate work in columns out.
// Only open PRs and open issues get a card. A PR stacked on another open PR
// waits for it, so only the bottom of a stack shows (with the stack's size);
// an issue an open PR closes rides on that PR's card instead of its own.

import type { AgentOverlay, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'

export type KanbanColumn = 'ready' | 'needs-work' | 'in-review' | 'in-progress' | 'todo'

/** Left → right in order of progress. */
export const KANBAN_COLUMNS: { id: KanbanColumn; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'needs-work', title: 'Needs work' },
  { id: 'in-review', title: 'In review' },
  { id: 'ready', title: 'Ready to merge' }
]

export interface KanbanCard {
  node: WorkNode
  column: KanbanColumn
  /** Open PRs in the stack this PR is the bottom of, itself included (1 = not stacked). */
  stack: number
  /** Open issues the PR (or a PR stacked on it) closes, as "#N" or "owner/name#N" from another repo. */
  closes: string[]
  /** The owning epic's name. */
  epic?: string
}

const isOpenChange = (n: WorkNode | undefined): n is WorkNode =>
  !!n && n.kind === 'change' && (n.state === 'open' || n.state === 'draft')
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
  const blocked = new Set<string>()
  const above = new Map<string, string[]>() // base PR → PRs stacked directly on it
  const closesOf = new Map<string, WorkNode[]>()
  const closedByOpenPr = new Set<string>()
  for (const e of edges) {
    const from = nodesById.get(e.from)
    const to = nodesById.get(e.to)
    if (!isOpenChange(from)) continue
    if (e.kind === 'base' && isOpenChange(to) && to.id !== from.id) {
      blocked.add(from.id)
      above.set(to.id, [...(above.get(to.id) ?? []), from.id])
    } else if (e.kind === 'closes' && isOpenIssue(to)) {
      closedByOpenPr.add(to.id)
      closesOf.set(from.id, [...(closesOf.get(from.id) ?? []), to])
    }
  }

  // The whole stack above a bottom PR (a cycle of bases cannot loop).
  const stackOf = (bottom: string): string[] => {
    const seen = new Set([bottom])
    const queue = [bottom]
    while (queue.length) {
      for (const id of above.get(queue.shift()!) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        queue.push(id)
      }
    }
    return [...seen]
  }
  const streamName = new Map(input.streams.map((s) => [s.id, s.name]))
  const refLabel = (pr: WorkNode, i: WorkNode): string =>
    i.repo && i.repo !== pr.repo ? `${i.repo}#${i.number}` : `#${i.number}`

  const cards: KanbanCard[] = []
  for (const id of shown) {
    const n = nodesById.get(id)
    if (!n) continue
    if (isOpenChange(n)) {
      if (blocked.has(id)) continue
      const stack = stackOf(id)
      const closes = [...new Set(stack.flatMap((s) => (closesOf.get(s) ?? []).map((i) => refLabel(n, i))))]
      cards.push(card(n, overlays.get(id), stack.length, closes, streamName))
    } else if (isOpenIssue(n) && !closedByOpenPr.has(id)) {
      cards.push(card(n, overlays.get(id), 1, [], streamName))
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
  stack: number,
  closes: string[],
  streamName: Map<string, string>
): KanbanCard {
  const owner = node.workstreams[0]
  return {
    node,
    column: kanbanColumn(node, overlay),
    stack,
    closes,
    ...(owner ? { epic: streamName.get(owner) ?? owner } : {})
  }
}

export type ForgeMode = 'graph' | 'kanban'

export const parseForgeMode = (v: string | null | undefined): ForgeMode => (v === 'kanban' ? 'kanban' : 'graph')
