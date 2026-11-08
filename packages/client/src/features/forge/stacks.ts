// Stacks and pairs — pure, shared by the Kanban and the canvas. A stack is the
// open (or draft) changes joined by `base` edges to other open changes: each
// waits for the one it is based on. It may branch (two PRs on one base), and
// a cycle of bases cannot loop. A pair is a `paired` edge between two changes
// in any state (a PR that ships with one in another repo), read both ways.

import type { WorkEdge, WorkNode } from '@sovereign/core'

export interface Stack {
  /** Member ids, bottom → top: by depth above the bottom, then by number. */
  members: string[]
}

export interface StackModel {
  /** Every stack of two or more changes, ordered by its bottom's id. */
  stacks: Stack[]
  /** Member id → its stack. */
  stackOf: Map<string, Stack>
  /** Member id → its position in its stack, 1 at the bottom. */
  position: Map<string, number>
  /** Change id → the changes paired with it, sorted. */
  pairs: Map<string, string[]>
}

export const isOpenChange = (n: WorkNode | undefined): n is WorkNode =>
  !!n && n.kind === 'change' && (n.state === 'open' || n.state === 'draft')

export function stackModel(nodesById: Map<string, WorkNode>, edges: WorkEdge[]): StackModel {
  const above = new Map<string, string[]>() // base → the changes based on it
  const linked = new Map<string, string[]>() // either way along base edges
  const hasBase = new Set<string>()
  const pairSets = new Map<string, Set<string>>()
  const push = <V>(m: Map<string, V[]>, k: string, v: V) => m.set(k, [...(m.get(k) ?? []), v])
  for (const e of edges) {
    if (e.from === e.to) continue
    const from = nodesById.get(e.from)
    const to = nodesById.get(e.to)
    if (e.kind === 'base' && isOpenChange(from) && isOpenChange(to)) {
      push(above, e.to, e.from)
      push(linked, e.to, e.from)
      push(linked, e.from, e.to)
      hasBase.add(e.from)
    } else if (e.kind === 'paired' && from?.kind === 'change' && to?.kind === 'change') {
      for (const [a, b] of [
        [e.from, e.to],
        [e.to, e.from]
      ]) {
        if (!pairSets.has(a)) pairSets.set(a, new Set())
        pairSets.get(a)!.add(b)
      }
    }
  }

  const num = (id: string) => nodesById.get(id)?.number ?? 0
  const byNumber = (a: string, b: string) => num(a) - num(b) || a.localeCompare(b)
  const stacks: Stack[] = []
  const stackOf = new Map<string, Stack>()
  const position = new Map<string, number>()
  const seen = new Set<string>()
  for (const start of [...linked.keys()].sort()) {
    if (seen.has(start)) continue
    // The connected changes, then their depth above the bottom (breadth-first,
    // so a change reached twice keeps its lowest depth).
    const group: string[] = []
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const id = queue.shift()!
      group.push(id)
      for (const next of linked.get(id) ?? [])
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
    }
    const depth = new Map<string, number>()
    const walk = (roots: string[]) => {
      const q = roots.filter((r) => !depth.has(r))
      for (const r of q) depth.set(r, 0)
      while (q.length) {
        const id = q.shift()!
        for (const next of above.get(id) ?? [])
          if (!depth.has(next)) {
            depth.set(next, depth.get(id)! + 1)
            q.push(next)
          }
      }
    }
    walk(group.filter((id) => !hasBase.has(id)))
    // What a cycle of bases leaves unreached starts again from its lowest number.
    for (let rest = group.filter((id) => !depth.has(id)); rest.length; rest = rest.filter((id) => !depth.has(id)))
      walk([rest.sort(byNumber)[0]])
    const stack: Stack = { members: group.sort((a, b) => depth.get(a)! - depth.get(b)! || byNumber(a, b)) }
    stacks.push(stack)
    stack.members.forEach((id, i) => {
      stackOf.set(id, stack)
      position.set(id, i + 1)
    })
  }
  stacks.sort((a, b) => a.members[0].localeCompare(b.members[0]))
  const pairs = new Map([...pairSets].map(([id, set]) => [id, [...set].sort()]))
  return { stacks, stackOf, position, pairs }
}
