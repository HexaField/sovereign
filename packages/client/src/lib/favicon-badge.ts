/**
 * Favicon badge — shows a notification dot or an animated spinner on the
 * browser tab icon.
 *
 * Two badge kinds:
 *
 *   RED DOT  — canvas-rendered PNG; shown when an assistant turn completes
 *              while the tab is in the background (existing behaviour).
 *
 *   SPINNER  — animated SVG; shown while an agent is actively running.
 *              Fetches the base SVG once, embeds it inline with a rotating
 *              arc overlay via SMIL, and sets the result as a data-URL favicon.
 *              Works in all modern browsers that support SVG favicons (Chrome,
 *              Firefox, Safari, Edge).
 *
 * State priority: badge > spinner > original. Calling showFaviconBadge() while
 * the spinner is active upgrades to the badge. Calling clearFaviconBadge()
 * restores the original (it does not fall back to spinner). Use the dedicated
 * clear functions to manage each state independently.
 *
 * API:
 *   showFaviconBadge()   — show red notification dot
 *   clearFaviconBadge()  — remove badge, restore original
 *   hasFaviconBadge()    — true when badge is visible
 *   showFaviconSpinner() — show animated amber spinner
 *   clearFaviconSpinner()— remove spinner, restore original
 *   hasFaviconSpinner()  — true when spinner is visible
 */

// ── Constants ──────────────────────────────────────────────────────────────

const BADGE_COLOR = '#ef4444' // red-500
const SPINNER_COLOR = '#f59e0b' // amber-400
const BADGE_RADIUS_RATIO = 0.16 // relative to ICON_SIZE
const ICON_SIZE = 64 // canvas resolution for badge PNG

// Spinner geometry in the favicon's native 512×512 viewBox.
// The spinner sits in the top-right corner at the same position as the badge dot.
// cx/cy are the badge-equivalent centre at 512-scale; the arc ring has a small
// backing circle to keep it legible against the hexagon stroke.
const SPIN_CX = 416 // ≈ ICON_SIZE * (52/64) scaled to 512
const SPIN_CY = 96 // ≈ ICON_SIZE * (12/64) scaled to 512
const SPIN_BACK_R = 88 // dark backing circle radius
const SPIN_RING_R = 66 // spinner arc circle radius
const SPIN_RING_W = 22 // arc stroke-width → outer edge ≈ r77, inner ≈ r55
const SPIN_CIRC = Math.round(2 * Math.PI * SPIN_RING_R) // ≈ 415
const SPIN_DASH = Math.round(SPIN_CIRC * 0.75) // ¾ arc solid   ≈ 311
const SPIN_GAP = SPIN_CIRC - SPIN_DASH //           ¼ arc gap    ≈ 104

// ── Module state ───────────────────────────────────────────────────────────

type FaviconState = 'original' | 'badge' | 'spinner'

let faviconState: FaviconState = 'original'
let originalHref: string | null = null
let badgeHref: string | null = null
let spinnerHref: string | null = null
let cachedBaseSvg: string | null = null

// ── Helpers ────────────────────────────────────────────────────────────────

function getLinkEl(): HTMLLinkElement | null {
  return document.querySelector('link[rel="icon"]')
}

function saveOriginal(link: HTMLLinkElement): void {
  if (!originalHref) originalHref = link.href
}

function restoreToOriginal(link: HTMLLinkElement): void {
  if (!originalHref) return
  link.type = 'image/svg+xml'
  link.href = originalHref
  faviconState = 'original'
}

// ── Red badge (canvas PNG) ─────────────────────────────────────────────────

async function renderBadge(): Promise<string> {
  if (badgeHref) return badgeHref

  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
    img.src = '/favicon.svg'
  })
  ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE)

  const r = ICON_SIZE * BADGE_RADIUS_RATIO
  const cx = ICON_SIZE - r - 2
  const cy = r + 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = BADGE_COLOR
  ctx.fill()
  ctx.strokeStyle = '#0a0a0f'
  ctx.lineWidth = 2
  ctx.stroke()

  badgeHref = canvas.toDataURL('image/png')
  return badgeHref
}

// ── Amber spinner (animated SVG) ───────────────────────────────────────────

/** Fetch the base SVG content once and cache it. */
export async function fetchBaseSvg(): Promise<string> {
  if (cachedBaseSvg !== null) return cachedBaseSvg
  const res = await fetch('/favicon.svg')
  cachedBaseSvg = await res.text()
  return cachedBaseSvg
}

/**
 * Build a self-contained SVG data URL that embeds the base favicon content
 * and overlays an animated amber arc in the top-right corner.
 *
 * The function is pure — it does not touch the DOM or module state. Exported
 * for unit testing.
 */
export function buildSpinnerSvg(baseSvg: string): string {
  // Extract inner body of the base SVG
  const innerMatch = baseSvg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i)
  const inner = innerMatch?.[1] ?? ''

  // Read viewBox to scale spinner geometry proportionally
  const vbMatch = baseSvg.match(/viewBox=["']([^"']+)["']/)
  const vbParts = (vbMatch?.[1] ?? '0 0 512 512').split(/[\s,]+/)
  const vbW = parseFloat(vbParts[2] ?? '512')
  const vbH = parseFloat(vbParts[3] ?? '512')

  // Scale all spinner coordinates to the actual viewBox dimensions
  const ref = 512 // baseline the SPIN_* constants were designed for
  const s = Math.min(vbW, vbH) / ref
  const cx = Math.round(SPIN_CX * s)
  const cy = Math.round(SPIN_CY * s)
  const backR = Math.round(SPIN_BACK_R * s)
  const ringR = Math.round(SPIN_RING_R * s)
  const ringW = Math.round(SPIN_RING_W * s)
  const dash = Math.round(SPIN_DASH * s)
  const gap = Math.round(SPIN_GAP * s)

  const overlay =
    `<circle cx="${cx}" cy="${cy}" r="${backR}" fill="#0a0a0f"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none"` +
    ` stroke="${SPINNER_COLOR}" stroke-width="${ringW}"` +
    ` stroke-dasharray="${dash} ${gap}" stroke-linecap="round">` +
    `<animateTransform attributeName="transform" type="rotate"` +
    ` from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="1s" repeatCount="indefinite"/>` +
    `</circle>`

  const svg = `<svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${inner}${overlay}</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

async function renderSpinner(): Promise<string> {
  if (spinnerHref !== null) return spinnerHref
  const base = await fetchBaseSvg()
  spinnerHref = buildSpinnerSvg(base)
  return spinnerHref
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function showFaviconBadge(): Promise<void> {
  if (faviconState === 'badge') return
  const link = getLinkEl()
  if (!link) return
  saveOriginal(link)
  try {
    const href = await renderBadge()
    link.type = 'image/png'
    link.href = href
    faviconState = 'badge'
  } catch {
    // Canvas rendering failed — silently skip
  }
}

export function clearFaviconBadge(): void {
  if (faviconState !== 'badge') return
  const link = getLinkEl()
  if (!link) return
  restoreToOriginal(link)
}

export function hasFaviconBadge(): boolean {
  return faviconState === 'badge'
}

export async function showFaviconSpinner(): Promise<void> {
  // Badge takes priority — don't downgrade to spinner
  if (faviconState === 'badge' || faviconState === 'spinner') return
  const link = getLinkEl()
  if (!link) return
  saveOriginal(link)
  try {
    const href = await renderSpinner()
    link.type = 'image/svg+xml'
    link.href = href
    faviconState = 'spinner'
  } catch {
    // Fetch or SVG construction failed — silently skip
  }
}

export function clearFaviconSpinner(): void {
  if (faviconState !== 'spinner') return
  const link = getLinkEl()
  if (!link) return
  restoreToOriginal(link)
}

export function hasFaviconSpinner(): boolean {
  return faviconState === 'spinner'
}
