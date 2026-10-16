// Spatial hit-test index — a uniform grid hash over world rectangles. Used for
// pointer hits and for viewport culling.

export interface HitRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface HitIndex {
  /** The topmost rect containing the point (the one added last wins), or null. */
  at(x: number, y: number): string | null
  /** Ids of every rect intersecting the rectangle, in insertion order. */
  inRect(x: number, y: number, w: number, h: number): string[]
  size: number
}

export function createHitIndex(rects: HitRect[], cell = 256): HitIndex {
  const grid = new Map<string, number[]>()
  const key = (cx: number, cy: number): string => `${cx},${cy}`
  rects.forEach((r, i) => {
    const x0 = Math.floor(r.x / cell)
    const x1 = Math.floor((r.x + r.w) / cell)
    const y0 = Math.floor(r.y / cell)
    const y1 = Math.floor((r.y + r.h) / cell)
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy)
        const list = grid.get(k)
        if (list) list.push(i)
        else grid.set(k, [i])
      }
  })
  const contains = (r: HitRect, x: number, y: number): boolean =>
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  return {
    size: rects.length,
    at(x, y) {
      const list = grid.get(key(Math.floor(x / cell), Math.floor(y / cell)))
      if (!list) return null
      for (let i = list.length - 1; i >= 0; i--) {
        const r = rects[list[i]]
        if (contains(r, x, y)) return r.id
      }
      return null
    },
    inRect(x, y, w, h) {
      const seen = new Set<number>()
      const x0 = Math.floor(x / cell)
      const x1 = Math.floor((x + w) / cell)
      const y0 = Math.floor(y / cell)
      const y1 = Math.floor((y + h) / cell)
      // A huge query (zoomed far out) scans the rects instead of the cells.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > rects.length * 4) {
        return rects.filter((r) => r.x <= x + w && r.x + r.w >= x && r.y <= y + h && r.y + r.h >= y).map((r) => r.id)
      }
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          for (const i of grid.get(key(cx, cy)) ?? []) {
            if (seen.has(i)) continue
            const r = rects[i]
            if (r.x <= x + w && r.x + r.w >= x && r.y <= y + h && r.y + r.h >= y) seen.add(i)
          }
        }
      return [...seen].sort((a, b) => a - b).map((i) => rects[i].id)
    }
  }
}
