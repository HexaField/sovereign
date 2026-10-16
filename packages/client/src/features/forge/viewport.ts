// Viewport math — pure. screen = world × scale + (tx, ty).

export interface Viewport {
  tx: number
  ty: number
  scale: number
}

export const MIN_SCALE = 0.04
export const MAX_SCALE = 2.5

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

export function worldToScreen(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: x * vp.scale + vp.tx, y: y * vp.scale + vp.ty }
}

export function screenToWorld(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - vp.tx) / vp.scale, y: (y - vp.ty) / vp.scale }
}

export function pan(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, tx: vp.tx + dx, ty: vp.ty + dy }
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  const w = screenToWorld(vp, sx, sy)
  return { scale, tx: sx - w.x * scale, ty: sy - w.y * scale }
}

/** Wheel delta → zoom factor; proportional so trackpads stay gentle. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0015)
}

export function visibleWorld(
  vp: Viewport,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const a = screenToWorld(vp, 0, 0)
  return { x: a.x, y: a.y, w: width / vp.scale, h: height / vp.scale }
}

/** Fit a world rectangle into the screen with `pad` pixels of margin. */
export function fitRect(
  r: { minX: number; maxX: number; minY: number; maxY: number },
  width: number,
  height: number,
  pad = 40
): Viewport {
  const w = Math.max(1, r.maxX - r.minX)
  const h = Math.max(1, r.maxY - r.minY)
  const scale = clampScale(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h))
  return {
    scale,
    tx: (width - w * scale) / 2 - r.minX * scale,
    ty: (height - h * scale) / 2 - r.minY * scale
  }
}

/** Centre the view on a world point at the current scale. */
export function centerOn(vp: Viewport, x: number, y: number, width: number, height: number): Viewport {
  return { scale: vp.scale, tx: width / 2 - x * vp.scale, ty: height / 2 - y * vp.scale }
}

/**
 * The opening view: the "now" divider a third of the way across, the
 * recent past to its left, at a readable scale, top lanes visible.
 */
export function openingView(width: number, bounds: { minY: number }, scale = 0.75): Viewport {
  return { scale, tx: width * 0.38, ty: 16 - bounds.minY * scale }
}
