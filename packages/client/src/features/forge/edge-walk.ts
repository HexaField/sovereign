// Arrow-key walking along edges — pure. From the selected node, an arrow key
// moves to the linked node that lies most in that direction.

import type { WorkEdge } from '@sovereign/core'
import type { PlacedNode } from './layout.js'

export type Direction = 'left' | 'right' | 'up' | 'down'

const VEC: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

export function walkEdge(
  fromId: string,
  dir: Direction,
  edges: WorkEdge[],
  placed: Map<string, PlacedNode>,
  visible?: (id: string) => boolean
): string | null {
  const a = placed.get(fromId)
  if (!a) return null
  const ax = a.x + a.w / 2
  const ay = a.y + a.h / 2
  const [vx, vy] = VEC[dir]
  let best: string | null = null
  let bestScore = Infinity
  const seen = new Set<string>()
  for (const e of edges) {
    const other = e.from === fromId ? e.to : e.to === fromId ? e.from : null
    if (!other || other === fromId || seen.has(other)) continue
    seen.add(other)
    if (visible && !visible(other)) continue
    const b = placed.get(other)
    if (!b) continue
    const dx = b.x + b.w / 2 - ax
    const dy = b.y + b.h / 2 - ay
    const along = dx * vx + dy * vy
    if (along <= 0) continue
    const across = Math.abs(dx * vy - dy * vx)
    // Prefer nodes straight ahead: sideways distance counts double.
    const score = along + 2 * across
    if (score < bestScore || (score === bestScore && best !== null && other < best)) {
      bestScore = score
      best = other
    }
  }
  return best
}

export function keyDirection(key: string): Direction | null {
  switch (key) {
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    default:
      return null
  }
}
