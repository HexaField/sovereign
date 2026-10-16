// Scene — pure glue between layout, filters and level of detail: which ids
// draw, which fade, which sit in a band, and the hit index over all of it.

import type { WorkNode } from '@sovereign/core'
import { createHitIndex, type HitIndex, type HitRect } from './hit-index.js'
import type { Layout } from './layout.js'
import { collapsePast, type Collapsed } from './lod.js'

export interface Scene {
  layout: Layout
  nodesById: Map<string, WorkNode>
  /** Drawn at all (filters, focus). */
  visible: Set<string>
  /** Drawn faded. */
  dimmed: Set<string>
  collapsed: Collapsed
  hit: HitIndex
}

export const bandHitId = (i: number): string => `band:${i}`
export const bandIndexOf = (hitId: string): number | null => (hitId.startsWith('band:') ? Number(hitId.slice(5)) : null)

export function buildScene(
  layout: Layout,
  nodesById: Map<string, WorkNode>,
  visible: Set<string>,
  dimmed: Set<string>,
  scale: number
): Scene {
  const collapsed = collapsePast(layout, nodesById, scale, (id) => visible.has(id))
  const rects: HitRect[] = []
  // Bands under nodes: a node hit wins over its band.
  collapsed.bands.forEach((b, i) => rects.push({ id: bandHitId(i), x: b.x, y: b.y, w: b.w, h: b.h }))
  const ids = [...layout.nodes.keys()].sort()
  for (const id of ids) {
    if (!visible.has(id) || collapsed.bandOf.has(id)) continue
    const p = layout.nodes.get(id)!
    rects.push({ id, x: p.x, y: p.y, w: p.w, h: p.h })
  }
  return { layout, nodesById, visible, dimmed, collapsed, hit: createHitIndex(rects) }
}

/** Where an edge end attaches: the node, or the band it collapsed into; null if hidden. */
export function anchorOf(scene: Scene, id: string): { x: number; y: number; w: number; h: number } | null {
  if (!scene.visible.has(id)) return null
  const b = scene.collapsed.bandOf.get(id)
  if (b !== undefined) return scene.collapsed.bands[b]
  return scene.layout.nodes.get(id) ?? null
}
