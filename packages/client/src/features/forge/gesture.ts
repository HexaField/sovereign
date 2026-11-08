// Canvas pointer gestures — pure. Every active pointer is tracked: one pans
// (after a small slop, so a still press stays a tap), two pinch (zoom about
// their midpoint by the ratio of their distances, pan by the midpoint's
// movement). When one finger of a pinch lifts, the other carries on panning
// from where it is, so the view never jumps. A gesture that ever had two
// pointers down is never a tap.

import { pan, pinchViewport, type Point, type Viewport } from './viewport.js'

/** Movement (CSS px) a single pointer may make and still count as a tap. */
export const TAP_SLOP = 4
/** Two taps within this time (ms) and distance (px) are a double tap. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_PX = 24
/** How far a double tap zooms in. */
export const DOUBLE_TAP_ZOOM = 2

export interface Gesture {
  /** Active pointers in down order, at their last applied position (canvas-local). */
  pointers: Array<{ id: number; p: Point }>
  /** Where the first pointer went down. */
  start: Point | null
  /** Passed the tap slop, or pinched: not a tap. */
  moved: boolean
  /** Two pointers were down at some point. */
  pinched: boolean
}

export const idleGesture = (): Gesture => ({ pointers: [], start: null, moved: false, pinched: false })

export function gestureDown(g: Gesture, id: number, p: Point): Gesture {
  if (!g.pointers.length) return { pointers: [{ id, p }], start: p, moved: false, pinched: false }
  const pointers = [...g.pointers.filter((x) => x.id !== id), { id, p }]
  const pinched = g.pinched || pointers.length >= 2
  return { ...g, pointers, pinched, moved: g.moved || pinched }
}

/** A pointer moved: the gesture after it and the viewport it leads to (the same one when nothing changes). */
export function gestureMove(g: Gesture, vp: Viewport, id: number, p: Point): { gesture: Gesture; vp: Viewport } {
  const i = g.pointers.findIndex((x) => x.id === id)
  if (i < 0) return { gesture: g, vp }
  if (g.pointers.length >= 2) {
    // Only the first two pointers steer a pinch; a third finger is carried along.
    const pointers = g.pointers.map((x, j) => (j === i ? { id, p } : x))
    if (i > 1) return { gesture: { ...g, pointers }, vp }
    const prev: [Point, Point] = [g.pointers[0].p, g.pointers[1].p]
    const next: [Point, Point] = [pointers[0].p, pointers[1].p]
    return { gesture: { ...g, pointers }, vp: pinchViewport(vp, prev, next) }
  }
  const last = g.pointers[0].p
  if (!g.moved && g.start && Math.hypot(p.x - g.start.x, p.y - g.start.y) < TAP_SLOP) return { gesture: g, vp }
  return {
    gesture: { ...g, moved: true, pointers: [{ id, p }] },
    vp: pan(vp, p.x - last.x, p.y - last.y)
  }
}

/**
 * A pointer lifted (or was cancelled). `tap` is true only when it was the
 * gesture's one and only pointer and it never moved past the slop.
 */
export function gestureUp(g: Gesture, id: number): { gesture: Gesture; tap: boolean } {
  if (!g.pointers.some((x) => x.id === id)) return { gesture: g, tap: false }
  const pointers = g.pointers.filter((x) => x.id !== id)
  if (!pointers.length) return { gesture: idleGesture(), tap: !g.moved && !g.pinched }
  return { gesture: { ...g, pointers }, tap: false }
}

export interface Tap {
  at: number
  p: Point
}

/** Is `now` the second tap of a double tap after `prev`? */
export function isDoubleTap(prev: Tap | null, now: Tap): boolean {
  if (!prev) return false
  return now.at - prev.at <= DOUBLE_TAP_MS && Math.hypot(now.p.x - prev.p.x, now.p.y - prev.p.y) <= DOUBLE_TAP_PX
}
