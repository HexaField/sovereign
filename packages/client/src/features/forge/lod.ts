// Level of detail — pure. Zoomed out, past nodes collapse into time bands per
// group (the stream they belong to, else their repo), each spanning its members'
// rows, with counts; text shrinks to numbers, then to bare boxes.

import type { WorkNode } from '@sovereign/core'
import { DAY_MS, NODE_H, PX_PER_DAY, timeToX, type Layout } from './layout.js'

export type Detail = 'dot' | 'compact' | 'full'

/** Below this scale the past zone draws as bands. */
export const COLLAPSE_SCALE = 0.35
/** Below this scale nodes show only their number. */
export const COMPACT_SCALE = 0.7
/** A band is at least this many screen pixels wide. */
export const MIN_BAND_PX = 56
export const BAND_DAYS = [1, 2, 7, 14, 28, 56, 112, 224]

export function detailFor(scale: number): Detail {
  if (scale < COLLAPSE_SCALE) return 'dot'
  if (scale < COMPACT_SCALE) return 'compact'
  return 'full'
}

export interface Band {
  /** The members' group (`PlacedNode.group`). */
  group: string
  x: number
  y: number
  w: number
  h: number
  count: number
  merged: number
  closed: number
  nodeIds: string[]
}

export interface Collapsed {
  bands: Band[]
  /** Past node id → index into bands. */
  bandOf: Map<string, number>
  binDays: number
}

export function binDaysFor(scale: number): number {
  for (const d of BAND_DAYS) if (d * PX_PER_DAY * scale >= MIN_BAND_PX) return d
  return BAND_DAYS[BAND_DAYS.length - 1]
}

const EMPTY: Collapsed = { bands: [], bandOf: new Map(), binDays: 0 }

/**
 * Collapse past nodes into bands when the scale calls for it. `include`
 * limits which nodes count (the filtered set); hidden nodes never add to a band.
 */
export function collapsePast(
  layout: Layout,
  nodesById: Map<string, WorkNode>,
  scale: number,
  include?: (id: string) => boolean
): Collapsed {
  if (scale >= COLLAPSE_SCALE) return EMPTY
  const binDays = binDaysFor(scale)
  const bin = binDays * DAY_MS
  const byKey = new Map<string, Band>()
  const ids = [...layout.nodes.keys()].sort()
  for (const id of ids) {
    const p = layout.nodes.get(id)!
    if (p.zone !== 'past' || (include && !include(id))) continue
    const n = nodesById.get(id)
    if (!n) continue
    const t = Date.parse(n.closedAt ?? n.updatedAt)
    const i = Math.max(0, Math.floor((layout.now - (Number.isFinite(t) ? t : layout.now)) / bin))
    const key = `${p.group}\u0000${i}`
    let band = byKey.get(key)
    if (!band) {
      const x0 = timeToX(layout.now - (i + 1) * bin, layout.now)
      const x1 = timeToX(layout.now - i * bin, layout.now)
      band = {
        group: p.group,
        x: x0,
        y: p.y,
        w: x1 - x0,
        h: NODE_H,
        count: 0,
        merged: 0,
        closed: 0,
        nodeIds: []
      }
      byKey.set(key, band)
    }
    // The band spans its members' rows.
    const bottom = Math.max(band.y + band.h, p.y + NODE_H)
    band.y = Math.min(band.y, p.y)
    band.h = bottom - band.y
    band.count++
    if (n.state === 'merged' || n.state === 'done') band.merged++
    else band.closed++
    band.nodeIds.push(id)
  }
  const bands = [...byKey.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.x - b.x))
  const bandOf = new Map<string, number>()
  bands.forEach((b, i) => {
    for (const id of b.nodeIds) bandOf.set(id, i)
  })
  return { bands, bandOf, binDays }
}
