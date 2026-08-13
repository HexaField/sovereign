/**
 * Favicon badge — shows/clears a notification dot on the browser tab icon.
 *
 * Uses an OffscreenCanvas to render the base SVG favicon with a small
 * coloured circle in the top-right corner. Each tab has its own JS
 * context, so badge state scopes naturally to the active thread.
 *
 * API:
 *   showFaviconBadge()  — swap the favicon to the dotted variant
 *   clearFaviconBadge() — restore the original favicon
 *   hasFaviconBadge()   — check current state
 */

const BADGE_COLOR = '#ef4444' // red-500
const BADGE_RADIUS_RATIO = 0.16 // relative to icon size
const ICON_SIZE = 64 // canvas resolution (gets downscaled by the browser)

let badgeActive = false
let originalHref: string | null = null
let badgeHref: string | null = null

function getLinkEl(): HTMLLinkElement | null {
  return document.querySelector('link[rel="icon"]')
}

/** Render the base favicon SVG onto a canvas with a notification dot. */
async function renderBadge(): Promise<string> {
  if (badgeHref) return badgeHref

  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  // Draw the base SVG favicon
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
    img.src = '/favicon.svg'
  })
  ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE)

  // Draw notification dot (top-right quadrant)
  const r = ICON_SIZE * BADGE_RADIUS_RATIO
  const cx = ICON_SIZE - r - 2
  const cy = r + 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = BADGE_COLOR
  ctx.fill()

  // Subtle white outline for contrast
  ctx.strokeStyle = '#0a0a0f'
  ctx.lineWidth = 2
  ctx.stroke()

  badgeHref = canvas.toDataURL('image/png')
  return badgeHref
}

export async function showFaviconBadge(): Promise<void> {
  if (badgeActive) return
  const link = getLinkEl()
  if (!link) return

  if (!originalHref) originalHref = link.href

  try {
    const href = await renderBadge()
    link.type = 'image/png'
    link.href = href
    badgeActive = true
  } catch {
    // Canvas rendering failed (e.g. SVG load error) — silently skip
  }
}

export function clearFaviconBadge(): void {
  if (!badgeActive) return
  const link = getLinkEl()
  if (!link || !originalHref) return

  link.type = 'image/svg+xml'
  link.href = originalHref
  badgeActive = false
}

export function hasFaviconBadge(): boolean {
  return badgeActive
}
