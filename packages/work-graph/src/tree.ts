// Goal tree roll-up — pure. A work stream is a node of a tree (one parent at
// most); its leaves are the PRs, issues and task-only tasks it owns. A stream's
// progress counts the leaves of its whole subtree: done of total (cancelled
// ones left out), and the open ones blocked behind another open PR (the Kanban
// rule: a PR whose base is another open PR; an issue whose open closing PRs are
// all blocked). A PR that closes a leaf issue of the same subtree rides on that
// issue instead of counting twice. Archived sub-streams leave their parent's count.

import { leafState, type StreamProgress, type WorkEdge, type WorkNode, type WorkStream } from '@sovereign/core'

export { leafState }

const isOpenChange = (n: WorkNode | undefined): n is WorkNode =>
  !!n && n.kind === 'change' && (n.state === 'open' || n.state === 'draft')

/** Open leaves waiting on another open PR. */
export function blockedLeaves(nodes: WorkNode[], edges: WorkEdge[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const blocked = new Set<string>()
  for (const e of edges) {
    if (e.kind === 'base' && e.from !== e.to && isOpenChange(byId.get(e.from)) && isOpenChange(byId.get(e.to)))
      blocked.add(e.from)
  }
  const closers = new Map<string, string[]>() // open issue → its open closing PRs
  for (const e of edges) {
    const to = byId.get(e.to)
    if (e.kind !== 'closes' || !isOpenChange(byId.get(e.from)) || to?.kind !== 'issue' || to.state !== 'open') continue
    closers.set(e.to, [...(closers.get(e.to) ?? []), e.from])
  }
  for (const [issue, prs] of closers) if (prs.every((p) => blocked.has(p))) blocked.add(issue)
  return blocked
}

/** Each stream's subtree: itself and every sub-stream below it that is not archived. */
export function subtrees(streams: WorkStream[]): Map<string, Set<string>> {
  const children = new Map<string, WorkStream[]>()
  for (const s of streams) {
    if (!s.parentId || s.parentId === s.id) continue
    children.set(s.parentId, [...(children.get(s.parentId) ?? []), s])
  }
  const out = new Map<string, Set<string>>()
  for (const s of streams) {
    const seen = new Set([s.id])
    const queue = [s.id]
    while (queue.length) {
      for (const c of children.get(queue.shift()!) ?? []) {
        if (seen.has(c.id) || c.status === 'archived') continue
        seen.add(c.id)
        queue.push(c.id)
      }
    }
    out.set(s.id, seen)
  }
  return out
}

/** Every stream's progress over its subtree. */
export function streamProgress(
  streams: WorkStream[],
  nodes: WorkNode[],
  edges: WorkEdge[]
): Map<string, StreamProgress> {
  const leaves = nodes.filter((n) => n.workstreams.length && leafState(n) !== undefined)
  const blocked = blockedLeaves(nodes, edges)
  const closes = new Map<string, string[]>() // change → issues it closes
  for (const e of edges) if (e.kind === 'closes') closes.set(e.from, [...(closes.get(e.from) ?? []), e.to])

  const out = new Map<string, StreamProgress>()
  for (const [id, tree] of subtrees(streams)) {
    const inTree = leaves.filter((n) => n.workstreams.some((w) => tree.has(w)))
    const ids = new Set(inTree.map((n) => n.id))
    const p: StreamProgress = { done: 0, total: 0, blocked: 0 }
    for (const n of inTree) {
      if (n.kind === 'change' && closes.get(n.id)?.some((i) => ids.has(i))) continue
      const s = leafState(n)
      if (s === 'cancelled') continue
      p.total++
      if (s === 'done') p.done++
      else if (blocked.has(n.id)) p.blocked++
    }
    out.set(id, p)
  }
  return out
}

/** The streams with their `progress` set. */
export function withProgress(streams: WorkStream[], nodes: WorkNode[], edges: WorkEdge[]): WorkStream[] {
  const p = streamProgress(streams, nodes, edges)
  return streams.map((s) => ({ ...s, progress: p.get(s.id) ?? { done: 0, total: 0, blocked: 0 } }))
}
