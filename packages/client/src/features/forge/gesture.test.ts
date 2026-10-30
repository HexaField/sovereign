import { describe, expect, it } from 'vitest'
import { gestureDown, gestureMove, gestureUp, idleGesture, isDoubleTap, TAP_SLOP, type Gesture } from './gesture.js'
import { MAX_SCALE, pinchViewport, screenToWorld, type Viewport } from './viewport.js'

const vp0: Viewport = { tx: 10, ty: -20, scale: 0.5 }
const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 9)

describe('pinchViewport', () => {
  it('zooms by the ratio of the finger distances about their midpoint', () => {
    // Fingers 100 px apart around (200, 300), spread to 200 px apart around the same midpoint.
    const next = pinchViewport(
      vp0,
      [
        { x: 150, y: 300 },
        { x: 250, y: 300 }
      ],
      [
        { x: 100, y: 300 },
        { x: 300, y: 300 }
      ]
    )
    close(next.scale, 1)
    const before = screenToWorld(vp0, 200, 300)
    const after = screenToWorld(next, 200, 300)
    close(after.x, before.x)
    close(after.y, before.y)
  })

  it('pans by the midpoint movement when the distance holds', () => {
    const next = pinchViewport(
      vp0,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 }
      ],
      [
        { x: 30, y: 40 },
        { x: 130, y: 40 }
      ]
    )
    expect(next).toEqual({ scale: 0.5, tx: 40, ty: 20 })
  })

  it('keeps the world point under the old midpoint under the new one while zooming and moving', () => {
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 100 },
      { x: 200, y: 200 }
    ]
    const next: typeof prev = [
      { x: 120, y: 90 },
      { x: 300, y: 270 }
    ]
    const v = pinchViewport(vp0, prev, next)
    close(v.scale, vp0.scale * (Math.hypot(180, 180) / Math.hypot(100, 100)))
    const world = screenToWorld(vp0, 150, 150)
    const at = screenToWorld(v, 210, 180)
    close(at.x, world.x)
    close(at.y, world.y)
  })

  it('clamps the scale and ignores a zero distance', () => {
    const big = pinchViewport(
      { tx: 0, ty: 0, scale: 2 },
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 }
      ]
    )
    expect(big.scale).toBe(MAX_SCALE)
    const same = pinchViewport(
      vp0,
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 }
      ],
      [
        { x: 5, y: 5 },
        { x: 50, y: 5 }
      ]
    )
    expect(same.scale).toBe(vp0.scale)
  })
})

describe('gesture', () => {
  const down = (g: Gesture, id: number, x: number, y: number): Gesture => gestureDown(g, id, { x, y })

  it('a still press is a tap', () => {
    let g = down(idleGesture(), 1, 50, 50)
    const m = gestureMove(g, vp0, 1, { x: 51, y: 51 })
    expect(m.vp).toBe(vp0)
    g = m.gesture
    const up = gestureUp(g, 1)
    expect(up.tap).toBe(true)
    expect(up.gesture.pointers).toEqual([])
  })

  it('one pointer pans past the slop, from where it went down, and is then no tap', () => {
    let g = down(idleGesture(), 1, 50, 50)
    let m = gestureMove(g, vp0, 1, { x: 50 + TAP_SLOP + 6, y: 50 })
    expect(m.vp).toEqual({ ...vp0, tx: vp0.tx + TAP_SLOP + 6 })
    g = m.gesture
    m = gestureMove(g, m.vp, 1, { x: 70, y: 65 })
    expect(m.vp).toEqual({ ...vp0, tx: vp0.tx + 20, ty: vp0.ty + 15 })
    expect(gestureUp(m.gesture, 1).tap).toBe(false)
  })

  it('two pointers pinch, and the pinch never counts as a tap', () => {
    let g = down(idleGesture(), 1, 150, 300)
    g = down(g, 2, 250, 300)
    expect(g.pinched).toBe(true)
    const m = gestureMove(g, vp0, 2, { x: 350, y: 300 })
    // Distance 100 → 200 about the old midpoint (200, 300), then the midpoint moved +50 px.
    close(m.vp.scale, 1)
    const world = screenToWorld(vp0, 200, 300)
    const at = screenToWorld(m.vp, 250, 300)
    close(at.x, world.x)
    let up = gestureUp(m.gesture, 1)
    expect(up.tap).toBe(false)
    up = gestureUp(up.gesture, 2)
    expect(up.tap).toBe(false)
  })

  it('hands off from two pointers to one with no jump', () => {
    let g = down(idleGesture(), 1, 100, 100)
    g = down(g, 2, 200, 100)
    let m = gestureMove(g, vp0, 1, { x: 80, y: 100 })
    m = gestureMove(m.gesture, m.vp, 2, { x: 230, y: 110 })
    const afterPinch = m.vp
    // Finger 1 lifts; finger 2 is at (230, 110).
    const up = gestureUp(m.gesture, 1)
    expect(up.tap).toBe(false)
    expect(up.gesture.pointers).toEqual([{ id: 2, p: { x: 230, y: 110 } }])
    // Lifting changes nothing; the first one-finger move pans by its own delta only (no slop wait, no jump).
    const one = gestureMove(up.gesture, afterPinch, 2, { x: 232, y: 111 })
    expect(one.vp).toEqual({ ...afterPinch, tx: afterPinch.tx + 2, ty: afterPinch.ty + 1 })
    expect(gestureUp(one.gesture, 2).tap).toBe(false)
  })

  it('a third pointer does not steer the pinch', () => {
    let g = down(idleGesture(), 1, 0, 0)
    g = down(g, 2, 100, 0)
    g = down(g, 3, 50, 50)
    const m = gestureMove(g, vp0, 3, { x: 90, y: 90 })
    expect(m.vp).toBe(vp0)
  })

  it('ignores pointers it does not track', () => {
    const g = down(idleGesture(), 1, 0, 0)
    expect(gestureMove(g, vp0, 9, { x: 100, y: 100 }).vp).toBe(vp0)
    expect(gestureUp(g, 9)).toEqual({ gesture: g, tap: false })
  })
})

describe('isDoubleTap', () => {
  it('needs a previous tap close in time and place', () => {
    const first = { at: 1000, p: { x: 100, y: 100 } }
    expect(isDoubleTap(null, first)).toBe(false)
    expect(isDoubleTap(first, { at: 1200, p: { x: 110, y: 105 } })).toBe(true)
    expect(isDoubleTap(first, { at: 1400, p: { x: 100, y: 100 } })).toBe(false)
    expect(isDoubleTap(first, { at: 1100, p: { x: 160, y: 100 } })).toBe(false)
  })
})
