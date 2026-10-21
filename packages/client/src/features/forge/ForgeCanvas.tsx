// The Forge canvas: a 2D <canvas> with wheel zoom and drag pan. Redraws only
// when an input changes (one rAF per change), keeps animating only while a
// visible agent ring pulses, and draws at the device pixel ratio.

import { createEffect, onCleanup, onMount, type Component } from 'solid-js'
import type { AgentOverlay } from '@sovereign/core'
import { drawFrame } from './render.js'
import { bandIndexOf, type Scene } from './scene.js'
import { DEFAULT_PALETTE, type Palette } from './style.js'
import { currentTheme } from '../theme/store.js'
import { centerOn, fitRect, openingView, pan, screenToWorld, wheelFactor, zoomAt, type Viewport } from './viewport.js'

export interface CanvasHandle {
  fit(): void
  focusNode(id: string): void
  viewport(): Viewport
}

export interface ForgeCanvasProps {
  scene: () => Scene | null
  overlays: () => Map<string, AgentOverlay>
  selectedId: () => string | null
  highlight: () => Set<string> | undefined
  onSelect: (id: string | null) => void
  /** A right-click on a node or tree card, at canvas (CSS pixel) coordinates. */
  onMenu?: (id: string, x: number, y: number) => void
  /** Every viewport change (pan, zoom, resize), in CSS pixels. */
  onViewport?: (vp: Viewport, width: number, height: number) => void
  ref?: (h: CanvasHandle) => void
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--c-bg', DEFAULT_PALETTE.bg),
    raised: v('--c-bg-raised', DEFAULT_PALETTE.raised),
    border: v('--c-border', DEFAULT_PALETTE.border),
    text: v('--c-text', DEFAULT_PALETTE.text),
    muted: v('--c-text-muted', DEFAULT_PALETTE.muted),
    accent: v('--c-accent', DEFAULT_PALETTE.accent),
    past: DEFAULT_PALETTE.past,
    future: DEFAULT_PALETTE.future
  }
}

/** Bounds of what is drawn: visible nodes and bands, else the whole layout. */
function visibleBounds(s: Scene): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const add = (r: { x: number; y: number; w: number; h: number }): void => {
    minX = Math.min(minX, r.x)
    maxX = Math.max(maxX, r.x + r.w)
    minY = Math.min(minY, r.y)
    maxY = Math.max(maxY, r.y + r.h)
  }
  for (const id of s.visible) {
    if (s.collapsed.bandOf.has(id)) continue
    const p = s.layout.nodes.get(id)
    if (p) add(p)
  }
  for (const b of s.collapsed.bands) add(b)
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : s.layout.bounds
}

const ForgeCanvas: Component<ForgeCanvasProps> = (props) => {
  let wrap!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let vp: Viewport = { tx: 0, ty: 0, scale: 0.6 }
  let width = 0
  let height = 0
  let placedOnce = false
  let frame = 0
  let hover: string | null = null
  let palette: Palette = DEFAULT_PALETTE

  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(draw)
  }

  function draw(): void {
    frame = 0
    const scene = props.scene()
    const ctx = canvas.getContext('2d')
    if (!ctx || !width || !height) return
    const dpr = window.devicePixelRatio || 1
    if (!scene) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = palette.bg
      ctx.fillRect(0, 0, width, height)
      return
    }
    const stats = drawFrame(ctx, {
      scene,
      vp,
      width,
      height,
      dpr,
      palette,
      overlays: props.overlays(),
      selectedId: props.selectedId(),
      hoverId: hover,
      time: performance.now(),
      highlight: props.highlight()
    })
    canvas.dataset.nodesDrawn = String(stats.nodesDrawn)
    canvas.dataset.bandsDrawn = String(stats.bandsDrawn)
    if (stats.animating) schedule()
  }

  const setVp = (next: Viewport): void => {
    vp = next
    props.onViewport?.(vp, width, height)
    schedule()
  }

  const handle: CanvasHandle = {
    fit() {
      const s = props.scene()
      if (!s || !width) return
      const fitted = fitRect(visibleBounds(s), width, height)
      // A single node or a short stack should not blow up past full detail.
      setVp(fitted.scale > 1 ? zoomAt(fitted, width / 2, height / 2, 1 / fitted.scale) : fitted)
    },
    focusNode(id) {
      const p = props.scene()?.layout.nodes.get(id)
      if (!p || !width) return
      setVp(centerOn({ ...vp, scale: Math.max(vp.scale, 0.6) }, p.x + p.w / 2, p.y + p.h / 2, width, height))
    },
    viewport: () => vp
  }

  const resize = (): void => {
    const r = wrap.getBoundingClientRect()
    width = Math.max(1, Math.floor(r.width))
    height = Math.max(1, Math.floor(r.height))
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const s = props.scene()
    if (!placedOnce && s) {
      placedOnce = true
      setVp(openingView(width, s.layout.bounds))
    } else setVp(vp)
  }

  onMount(() => {
    palette = readPalette(wrap)
    props.ref?.(handle)
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()
    // A DPR change (window moved to another screen, browser zoom) needs a resize.
    let mq: MediaQueryList | null = null
    const watchDpr = (): void => {
      mq?.removeEventListener('change', onDpr)
      mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', onDpr)
    }
    const onDpr = (): void => {
      resize()
      watchDpr()
    }
    watchDpr()
    onCleanup(() => {
      ro.disconnect()
      mq?.removeEventListener('change', onDpr)
      if (frame) cancelAnimationFrame(frame)
    })
  })

  // Redraw on any input change.
  createEffect(() => {
    const s = props.scene()
    props.overlays()
    props.selectedId()
    props.highlight()
    if (s && !placedOnce && width) {
      placedOnce = true
      vp = openingView(width, s.layout.bounds)
      props.onViewport?.(vp, width, height)
    }
    schedule()
  })
  createEffect(() => {
    currentTheme()
    if (wrap) {
      // The theme class flips before styles apply; read on the next frame.
      requestAnimationFrame(() => {
        palette = readPalette(wrap)
        schedule()
      })
    }
  })

  // ── Input ─────────────────────────────────────────────────────────
  let drag: { x: number; y: number; moved: boolean; id: number } | null = null
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const hitAt = (sx: number, sy: number): string | null => {
    const s = props.scene()
    if (!s) return null
    const w = screenToWorld(vp, sx, sy)
    return s.hit.at(w.x, w.y)
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    canvas.setPointerCapture(e.pointerId)
    drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId }
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      drag.x = e.clientX
      drag.y = e.clientY
      canvas.style.cursor = 'grabbing'
      setVp(pan(vp, dx, dy))
      return
    }
    if (e.pointerType !== 'mouse') return
    const p = local(e)
    const id = hitAt(p.x, p.y)
    if (id !== hover) {
      hover = id
      canvas.style.cursor = id ? 'pointer' : 'grab'
      schedule()
    }
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return
    const moved = drag.moved
    drag = null
    canvas.style.cursor = hover ? 'pointer' : 'grab'
    if (moved) return
    const p = local(e)
    const id = hitAt(p.x, p.y)
    const band = id ? bandIndexOf(id) : null
    if (band !== null) {
      // A band opens up: zoom in around it until its nodes show.
      setVp(zoomAt(vp, p.x, p.y, Math.max(1.2, 0.5 / vp.scale)))
      return
    }
    props.onSelect(id)
  }
  const onContextMenu = (e: MouseEvent): void => {
    const p = local(e)
    const id = hitAt(p.x, p.y)
    if (!id || bandIndexOf(id) !== null || !props.onMenu) return
    e.preventDefault()
    props.onMenu(id, p.x, p.y)
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const p = local(e)
    // Trackpad pinch (ctrlKey) and mouse wheels zoom; a two-finger horizontal scroll pans.
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setVp(pan(vp, -e.deltaX, 0))
      return
    }
    if (e.shiftKey) {
      setVp(pan(vp, -e.deltaY, 0))
      return
    }
    setVp(zoomAt(vp, p.x, p.y, wheelFactor(e.deltaY, e.deltaMode)))
  }

  return (
    <div ref={wrap} class="relative h-full w-full overflow-hidden" style={{ 'touch-action': 'none' }}>
      <canvas
        ref={canvas}
        data-testid="forge-canvas"
        class="block"
        style={{ cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag = null)}
        onContextMenu={onContextMenu}
        onPointerLeave={() => {
          if (hover) {
            hover = null
            schedule()
          }
        }}
        on:wheel={{ handleEvent: onWheel, passive: false }}
      />
    </div>
  )
}

export default ForgeCanvas
