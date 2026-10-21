// Canvas renderer. Draws one frame of a Scene into a 2D context: zones,
// lanes, branch lines, edges, bands and nodes inside the viewport only.
// Pure apart from the context it draws into; ForgeCanvas decides when.

import type { AgentOverlay, WorkNode, WorkStream } from '@sovereign/core'
import { NODE_H, type PlacedNode } from './layout.js'
import { detailFor, type Detail } from './lod.js'
import { anchorOf, type Scene } from './scene.js'
import {
  CI_COLORS,
  EPIC_STATUS_COLORS,
  RELATED_CARD,
  REVIEW_COLORS,
  STATE_COLORS,
  edgeStyle,
  initials,
  reviewSummary,
  ringFor,
  MEMBER_LINK,
  TREE_LINK,
  type Palette
} from './style.js'
import { progressLabel } from './tree-model.js'
import { visibleWorld, type Viewport } from './viewport.js'

export interface FrameInput {
  scene: Scene
  vp: Viewport
  /** CSS pixels. */
  width: number
  height: number
  dpr: number
  palette: Palette
  overlays: Map<string, AgentOverlay>
  selectedId: string | null
  hoverId: string | null
  /** ms, drives the subagent pulse. */
  time: number
  /** Edges touching these ids draw highlighted. */
  highlight?: Set<string>
}

export interface FrameStats {
  nodesDrawn: number
  edgesDrawn: number
  bandsDrawn: number
  treeLinksDrawn: number
  memberLinksDrawn: number
  /** A visible ring pulses: the caller keeps animating. */
  animating: boolean
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

const truncCache = new Map<string, string>()

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  const key = `${ctx.font}\u0000${max}\u0000${text}`
  const hit = truncCache.get(key)
  if (hit !== undefined) return hit
  let out = text
  if (ctx.measureText(text).width > max) {
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid
      else hi = mid - 1
    }
    out = text.slice(0, lo) + '…'
  }
  if (truncCache.size > 5000) truncCache.clear()
  truncCache.set(key, out)
  return out
}

/** Kind icon, 12×12 at (x, y), stroked in `color`. */
function kindIcon(ctx: CanvasRenderingContext2D, kind: WorkNode['kind'], x: number, y: number, color: string): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.4
  ctx.setLineDash([])
  switch (kind) {
    case 'change': {
      // Pull request: two commits joined, an arrow into the second.
      ctx.beginPath()
      ctx.arc(x + 3, y + 2.5, 1.8, 0, Math.PI * 2)
      ctx.moveTo(x + 3 + 1.8, y + 9.5)
      ctx.arc(x + 3, y + 9.5, 1.8, 0, Math.PI * 2)
      ctx.moveTo(x + 3, y + 4.3)
      ctx.lineTo(x + 3, y + 7.7)
      ctx.moveTo(x + 10.8, y + 9.5)
      ctx.arc(x + 9, y + 9.5, 1.8, 0, Math.PI * 2)
      ctx.moveTo(x + 9, y + 7.7)
      ctx.lineTo(x + 9, y + 3)
      ctx.lineTo(x + 6.5, y + 3)
      ctx.stroke()
      break
    }
    case 'issue':
      ctx.beginPath()
      ctx.arc(x + 6, y + 6, 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x + 6, y + 6, 1.4, 0, Math.PI * 2)
      ctx.fill()
      break
    case 'branch':
      ctx.beginPath()
      ctx.moveTo(x + 3, y + 1)
      ctx.lineTo(x + 3, y + 11)
      ctx.moveTo(x + 3, y + 8)
      ctx.quadraticCurveTo(x + 9, y + 8, x + 9, y + 3.5)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x + 9, y + 2.5, 1.6, 0, Math.PI * 2)
      ctx.fill()
      break
    case 'plan':
      ctx.strokeRect(x + 2, y + 0.5, 8, 11)
      ctx.beginPath()
      ctx.moveTo(x + 4, y + 4)
      ctx.lineTo(x + 8, y + 4)
      ctx.moveTo(x + 4, y + 6.5)
      ctx.lineTo(x + 8, y + 6.5)
      ctx.moveTo(x + 4, y + 9)
      ctx.lineTo(x + 7, y + 9)
      ctx.stroke()
      break
    case 'task':
    default:
      ctx.strokeRect(x + 1.5, y + 1.5, 9, 9)
      ctx.beginPath()
      ctx.moveTo(x + 3.5, y + 6)
      ctx.lineTo(x + 5.5, y + 8)
      ctx.lineTo(x + 9, y + 3.5)
      ctx.stroke()
  }
  ctx.restore()
}

function nodeLabel(n: WorkNode, detail: Detail): string {
  const num = n.number !== undefined ? `#${n.number}` : ''
  if (detail === 'compact') return num || n.title
  return num ? `${num} ${n.title}` : n.title
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: WorkNode,
  p: PlacedNode,
  f: FrameInput,
  detail: Detail,
  dim: boolean
): boolean {
  const { palette } = f
  const selected = f.selectedId === p.id
  const hover = f.hoverId === p.id
  const stateColor = STATE_COLORS[n.state] ?? palette.muted
  const ring = ringFor(f.overlays.get(p.id))
  ctx.globalAlpha = dim ? 0.22 : 1

  if (ring) {
    const pulse = ring.pulse ? 0.5 + 0.5 * Math.sin(f.time / 260) : 1
    ctx.save()
    ctx.strokeStyle = ring.color
    ctx.globalAlpha = (dim ? 0.22 : 1) * (ring.pulse ? 0.35 + 0.65 * pulse : 1)
    ctx.lineWidth = ring.pulse ? 2 + 2 * pulse : 2.5
    ctx.setLineDash([])
    roundRect(ctx, p.x - 4, p.y - 4, p.w + 8, p.h + 8, 10)
    ctx.stroke()
    ctx.restore()
  }

  roundRect(ctx, p.x, p.y, p.w, p.h, 7)
  ctx.fillStyle = palette.raised
  ctx.fill()
  ctx.setLineDash(
    p.related ? RELATED_CARD.dash : n.state === 'draft' || n.kind === 'plan' || n.kind === 'task' ? [4, 3] : []
  )
  ctx.lineWidth = selected ? 2 : 1
  ctx.strokeStyle = selected ? palette.accent : hover ? palette.text : p.related ? RELATED_CARD.color : palette.border
  ctx.stroke()
  ctx.setLineDash([])

  // State stripe.
  ctx.fillStyle = stateColor
  roundRect(ctx, p.x, p.y, 4, p.h, 2)
  ctx.fill()

  if (detail === 'dot') return !!ring?.pulse

  kindIcon(ctx, n.kind, p.x + 10, p.y + 8, stateColor)
  ctx.fillStyle = palette.text
  ctx.textBaseline = 'middle'
  ctx.font = `600 12px ${FONT}`
  const right = p.x + p.w - 8
  // Badges from the right: CI dot, review state.
  let badgeX = right
  const ci = n.ci ? CI_COLORS[n.ci] : null
  if (ci) {
    ctx.beginPath()
    ctx.arc(badgeX - 4, p.y + 14, 4, 0, Math.PI * 2)
    ctx.fillStyle = ci
    ctx.fill()
    badgeX -= 14
  }
  const review = reviewSummary(n)
  if (review) {
    ctx.fillStyle = REVIEW_COLORS[review]
    ctx.font = `700 11px ${FONT}`
    const glyph =
      review === 'approved' ? '✓' : review === 'changes_requested' ? '±' : review === 'requested' ? '◌' : '…'
    ctx.fillText(glyph, badgeX - 8, p.y + 14)
    badgeX -= 14
  }
  ctx.font = `600 12px ${FONT}`
  ctx.fillStyle = palette.text
  ctx.fillText(fitText(ctx, nodeLabel(n, detail), badgeX - (p.x + 28)), p.x + 28, p.y + 14)

  if (detail === 'full') {
    ctx.font = `11px ${FONT}`
    ctx.fillStyle = palette.muted
    const sub = [n.paused ? 'Paused' : '', n.repo?.split('/').pop(), n.branch?.head, n.status]
      .filter(Boolean)
      .join(' · ')
    // Assignee initials, bottom right.
    let ax = right
    for (const a of n.assignees.slice(0, 3)) {
      ctx.beginPath()
      ctx.arc(ax - 8, p.y + p.h - 12, 8, 0, Math.PI * 2)
      ctx.fillStyle = palette.border
      ctx.fill()
      ctx.fillStyle = palette.text
      ctx.font = `600 8px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(initials(a), ax - 8, p.y + p.h - 12)
      ctx.textAlign = 'left'
      ax -= 18
    }
    ctx.font = `11px ${FONT}`
    ctx.fillStyle = palette.muted
    ctx.fillText(fitText(ctx, sub, ax - (p.x + 12)), p.x + 12, p.y + p.h - 12)
  }
  return !!ring?.pulse
}

/**
 * A goal-tree card: the stream's name, status stripe and border, and (at full
 * detail) its progress over the subtree as a bar, done/total and the blocked
 * count, as the Tree panel shows them. A plan's stream gets the plan icon
 * (drawn on its plan node when that is loaded); a hand-made one a diamond.
 */
function drawStreamCard(
  ctx: CanvasRenderingContext2D,
  s: WorkStream,
  p: PlacedNode,
  f: FrameInput,
  detail: Detail,
  planNode: WorkNode | undefined,
  dim: boolean
): void {
  const { palette } = f
  const selected = f.selectedId === p.id
  const hover = f.hoverId === p.id
  const color = EPIC_STATUS_COLORS[s.status]?.fg ?? palette.muted
  ctx.globalAlpha = dim ? 0.4 : 1
  roundRect(ctx, p.x, p.y, p.w, p.h, 7)
  ctx.fillStyle = palette.raised
  ctx.fill()
  ctx.setLineDash([])
  ctx.lineWidth = selected ? 2.5 : 1.5
  ctx.strokeStyle = selected ? palette.accent : hover ? palette.text : TREE_LINK.color
  ctx.stroke()
  ctx.fillStyle = color
  roundRect(ctx, p.x, p.y, 4, p.h, 2)
  ctx.fill()
  if (detail === 'dot') return

  if (planNode || s.plan) kindIcon(ctx, 'plan', p.x + 10, p.y + 8, color)
  else {
    ctx.beginPath()
    ctx.moveTo(p.x + 16, p.y + 8)
    ctx.lineTo(p.x + 22, p.y + 14)
    ctx.lineTo(p.x + 16, p.y + 20)
    ctx.lineTo(p.x + 10, p.y + 14)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `600 12px ${FONT}`
  ctx.fillStyle = palette.text
  ctx.fillText(fitText(ctx, s.name, p.w - 36), p.x + 28, p.y + 14)
  if (detail !== 'full') return

  const prog = s.progress
  const barX = p.x + 12
  const barY = p.y + p.h - 15
  const barW = 70
  roundRect(ctx, barX, barY, barW, 5, 2.5)
  ctx.fillStyle = palette.border
  ctx.fill()
  if (prog && prog.total && prog.done) {
    roundRect(ctx, barX, barY, Math.max(5, (barW * prog.done) / prog.total), 5, 2.5)
    ctx.fillStyle = '#22c55e'
    ctx.fill()
  }
  ctx.font = `11px ${FONT}`
  ctx.fillStyle = palette.muted
  const label = progressLabel(prog) || 'no leaves'
  const labelX = barX + barW + 8
  ctx.fillText(label, labelX, barY + 2.5)
  if (prog?.blocked) {
    ctx.fillStyle = '#f59e0b'
    ctx.fillText(`⛔${prog.blocked}`, labelX + ctx.measureText(label).width + 8, barY + 2.5)
  }
}

export function drawFrame(ctx: CanvasRenderingContext2D, f: FrameInput): FrameStats {
  const { scene, vp, width, height, dpr, palette } = f
  const { layout } = scene
  const detail = detailFor(vp.scale)
  const stats: FrameStats = {
    nodesDrawn: 0,
    edgesDrawn: 0,
    bandsDrawn: 0,
    treeLinksDrawn: 0,
    memberLinksDrawn: 0,
    animating: false
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, width, height)
  ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.tx, dpr * vp.ty)
  const view = visibleWorld(vp, width, height)
  const vx1 = view.x + view.w
  const vy1 = view.y + view.h

  // Zones.
  ctx.fillStyle = palette.past
  if (view.x < 0) ctx.fillRect(view.x, view.y, Math.min(0, vx1) - view.x, view.h)
  ctx.fillStyle = palette.future
  if (vx1 > layout.futureStart - 40)
    ctx.fillRect(layout.futureStart - 40, view.y, vx1 - layout.futureStart + 40, view.h)

  // "Now" divider.
  if (view.x <= 0 && vx1 >= 0) {
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 1.5 / vp.scale
    ctx.setLineDash([6 / vp.scale, 4 / vp.scale])
    ctx.beginPath()
    ctx.moveTo(0, view.y)
    ctx.lineTo(0, vy1)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Branch lines.
  for (const b of layout.branches) {
    if (!scene.visible.has(b.nodeId) || scene.collapsed.bandOf.has(b.nodeId)) continue
    if (b.y < view.y || b.y > vy1 || b.x1 < view.x || b.x0 > vx1) continue
    const n = scene.nodesById.get(b.nodeId)
    ctx.globalAlpha = scene.dimmed.has(b.nodeId) ? 0.2 : 0.8
    ctx.strokeStyle = n ? STATE_COLORS[n.state] : palette.muted
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(b.x0, b.y)
    ctx.lineTo(b.x1, b.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(b.x0, b.y, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = ctx.strokeStyle
    ctx.fill()
    if (b.clipped && detail !== 'dot') {
      ctx.fillStyle = palette.muted
      ctx.font = `10px ${FONT}`
      ctx.textBaseline = 'bottom'
      ctx.fillText('‹ older', b.x0 + 6, b.y - 3)
    }
  }
  ctx.globalAlpha = 1

  // Edges. A constant width on screen at every zoom; zoomed out to dots,
  // `references` (the bulk of a busy repo) only for highlighted nodes, so the
  // structure stays readable.
  const zoomedOut = detailFor(vp.scale) === 'dot'
  for (const e of layout.edges) {
    const hot = f.highlight?.has(e.from) || f.highlight?.has(e.to)
    if (zoomedOut && e.kind === 'references' && !hot) continue
    const a = anchorOf(scene, e.from)
    const b = anchorOf(scene, e.to)
    if (!a || !b || a === b) continue
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x + a.w, b.x + b.w)
    const minY = Math.min(a.y, b.y)
    const maxY = Math.max(a.y + a.h, b.y + b.h)
    if (maxX < view.x || minX > vx1 || maxY < view.y || minY > vy1) continue
    const s = edgeStyle(e, scene.nodesById.get(e.to))
    const faded = scene.dimmed.has(e.from) || scene.dimmed.has(e.to)
    ctx.globalAlpha = faded ? 0.12 : hot ? 1 : 0.55
    ctx.strokeStyle = s.color
    ctx.lineWidth = (hot ? s.width + 1 : s.width) / vp.scale
    ctx.setLineDash(s.dash.map((d) => d / vp.scale))
    // Leave from the side facing the other end.
    const forward = b.x >= a.x + a.w
    const backward = b.x + b.w <= a.x
    const x1 = forward ? a.x + a.w : backward ? a.x : a.x + a.w / 2
    const y1 = forward || backward ? a.y + a.h / 2 : b.y > a.y ? a.y + a.h : a.y
    const x2 = forward ? b.x : backward ? b.x + b.w : b.x + b.w / 2
    const y2 = forward || backward ? b.y + b.h / 2 : b.y > a.y ? b.y : b.y + b.h
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    if (forward || backward) {
      const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1)
      ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
    } else {
      const dy = Math.max(20, Math.abs(y2 - y1) / 2) * (y2 > y1 ? 1 : -1)
      ctx.bezierCurveTo(x1, y1 + dy, x2, y2 - dy, x2, y2)
    }
    ctx.stroke()
    stats.edgesDrawn++
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  // Item → its stream's card: the graph the layout positions by, under the tree's own links.
  ctx.strokeStyle = MEMBER_LINK.color
  ctx.lineWidth = MEMBER_LINK.width / vp.scale
  ctx.globalAlpha = MEMBER_LINK.alpha
  for (const link of layout.tree.members) {
    const a = layout.nodes.get(link.from)
    const b = layout.nodes.get(link.to)
    if (!a || !b || !scene.visible.has(link.from) || scene.collapsed.bandOf.has(link.from)) continue
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    if (Math.max(x1, x2) < view.x || Math.min(x1, x2) > vx1 || Math.max(y1, y2) < view.y || Math.min(y1, y2) > vy1)
      continue
    ctx.setLineDash(link.related ? MEMBER_LINK.relatedDash.map((d) => d / vp.scale) : [])
    const dx = Math.max(20, (x2 - x1) / 2)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
    ctx.stroke()
    stats.memberLinksDrawn++
  }
  ctx.setLineDash([])

  // Goal-tree connectors: child card (left) → parent card (one column right).
  ctx.strokeStyle = TREE_LINK.color
  ctx.lineWidth = TREE_LINK.width / vp.scale
  ctx.globalAlpha = 0.85
  for (const link of layout.tree.links) {
    const a = layout.nodes.get(link.from)
    const b = layout.nodes.get(link.to)
    if (!a || !b) continue
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    if (Math.max(x1, x2) < view.x || Math.min(x1, x2) > vx1 || Math.max(y1, y2) < view.y || Math.min(y1, y2) > vy1)
      continue
    const dx = Math.max(20, (x2 - x1) / 2)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
    ctx.stroke()
    stats.treeLinksDrawn++
  }
  ctx.globalAlpha = 1

  // Bands (zoomed out past).
  scene.collapsed.bands.forEach((band) => {
    if (band.x + band.w < view.x || band.x > vx1 || band.y + band.h < view.y || band.y > vy1) return
    roundRect(ctx, band.x + 3, band.y, band.w - 6, band.h, 6)
    ctx.fillStyle = 'rgba(168,85,247,0.16)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(168,85,247,0.45)'
    ctx.lineWidth = 1 / vp.scale
    ctx.stroke()
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const sx = (band.x + band.w / 2) * vp.scale + vp.tx
    const sy = (band.y + Math.min(band.h, NODE_H * 2) / 2) * vp.scale + vp.ty
    ctx.fillStyle = palette.text
    ctx.font = `600 11px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(band.count), sx, sy)
    ctx.restore()
    stats.bandsDrawn++
  })

  // Nodes, via the hit index (bands excluded).
  for (const id of scene.hit.inRect(view.x, view.y, view.w, view.h)) {
    const p = layout.nodes.get(id)
    const n = scene.nodesById.get(id)
    const s = p?.stream ? layout.tree.cards.get(id) : undefined
    if (p && s) {
      drawStreamCard(ctx, s, p, f, detail, n, scene.dimmed.has(id))
      stats.nodesDrawn++
      continue
    }
    if (!p || !n) continue
    if (drawNode(ctx, n, p, f, detail, scene.dimmed.has(id))) stats.animating = true
    stats.nodesDrawn++
  }
  ctx.globalAlpha = 1

  // Screen-space overlays: zone labels on top.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = `600 10px ${FONT}`
  ctx.fillStyle = palette.muted
  const nowSx = vp.tx
  if (nowSx > 0 && nowSx < width) {
    ctx.fillStyle = palette.accent
    ctx.fillText('NOW', nowSx + 6, height - 12)
    ctx.fillStyle = palette.muted
    ctx.textAlign = 'right'
    ctx.fillText('← PAST', nowSx - 6, height - 12)
    ctx.textAlign = 'left'
  }
  const futSx = layout.futureStart * vp.scale + vp.tx
  if (futSx > 0 && futSx < width) ctx.fillText('FUTURE →', futSx, height - 12)
  return stats
}
