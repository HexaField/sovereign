import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Canvas + Image stubs ───────────────────────────────────────────────────

const mockCtx = {
  drawImage: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0
}

const mockCanvas = {
  width: 0,
  height: 0,
  getContext: vi.fn(() => mockCtx),
  toDataURL: vi.fn(() => 'data:image/png;base64,BADGE')
}

vi.stubGlobal('document', {
  createElement: vi.fn((tag: string) => {
    if (tag === 'canvas') return mockCanvas
    return {}
  }),
  querySelector: vi.fn(() => ({
    href: '/favicon.svg',
    type: 'image/svg+xml'
  })),
  visibilityState: 'visible'
})

// Stub Image — src setter fires onload asynchronously (setTimeout 0)
class MockImage {
  crossOrigin = ''
  _srcValue = ''
  onload: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
}

vi.stubGlobal(
  'Image',
  class extends MockImage {
    constructor() {
      super()
      const self = this
      Object.defineProperty(this, 'src', {
        get() {
          return self._srcValue
        },
        set(v: string) {
          self._srcValue = v
          setTimeout(() => self.onload?.(), 0)
        }
      })
    }
  }
)

// Stub fetch for spinner SVG loading
const MOCK_FAVICON_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(256,256)">
    <polygon points="0,-200 173.2,-100 173.2,100 0,200 -173.2,100 -173.2,-100"
             fill="none" stroke="#4a9eff" stroke-width="24"/>
  </g>
</svg>`

vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ text: () => Promise.resolve(MOCK_FAVICON_SVG) }))
)

// ── Module instances (re-imported fresh per test) ─────────────────────────

let showFaviconBadge: () => Promise<void>
let clearFaviconBadge: () => void
let hasFaviconBadge: () => boolean
let showFaviconSpinner: () => Promise<void>
let clearFaviconSpinner: () => void
let hasFaviconSpinner: () => boolean
let buildSpinnerSvg: (baseSvg: string) => string

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('./favicon-badge.js')
  showFaviconBadge = mod.showFaviconBadge
  clearFaviconBadge = mod.clearFaviconBadge
  hasFaviconBadge = mod.hasFaviconBadge
  showFaviconSpinner = mod.showFaviconSpinner
  clearFaviconSpinner = mod.clearFaviconSpinner
  hasFaviconSpinner = mod.hasFaviconSpinner
  buildSpinnerSvg = mod.buildSpinnerSvg
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Badge tests ────────────────────────────────────────────────────────────

describe('favicon-badge', () => {
  it('starts with no badge', () => {
    expect(hasFaviconBadge()).toBe(false)
  })

  it('showFaviconBadge sets hasFaviconBadge to true', async () => {
    await showFaviconBadge()
    expect(hasFaviconBadge()).toBe(true)
  })

  it('clearFaviconBadge restores the original state', async () => {
    await showFaviconBadge()
    clearFaviconBadge()
    expect(hasFaviconBadge()).toBe(false)
  })

  it('showFaviconBadge is idempotent — calling twice does not change state', async () => {
    await showFaviconBadge()
    await showFaviconBadge()
    expect(hasFaviconBadge()).toBe(true)
  })

  it('clearFaviconBadge does nothing when no badge active', () => {
    clearFaviconBadge()
    expect(hasFaviconBadge()).toBe(false)
  })

  it('renders a canvas with the correct dimensions', async () => {
    await showFaviconBadge()
    expect(mockCanvas.width).toBe(64)
    expect(mockCanvas.height).toBe(64)
  })

  it('draws the notification dot via arc()', async () => {
    await showFaviconBadge()
    expect(mockCtx.arc).toHaveBeenCalled()
    expect(mockCtx.fill).toHaveBeenCalled()
  })

  it('converts canvas to PNG data URL', async () => {
    await showFaviconBadge()
    expect(mockCanvas.toDataURL).toHaveBeenCalledWith('image/png')
  })
})

// ── Spinner tests ──────────────────────────────────────────────────────────

describe('favicon-spinner', () => {
  it('starts with no spinner', () => {
    expect(hasFaviconSpinner()).toBe(false)
  })

  it('showFaviconSpinner sets hasFaviconSpinner to true', async () => {
    await showFaviconSpinner()
    expect(hasFaviconSpinner()).toBe(true)
  })

  it('clearFaviconSpinner restores original state', async () => {
    await showFaviconSpinner()
    clearFaviconSpinner()
    expect(hasFaviconSpinner()).toBe(false)
  })

  it('showFaviconSpinner is idempotent', async () => {
    await showFaviconSpinner()
    await showFaviconSpinner()
    expect(hasFaviconSpinner()).toBe(true)
  })

  it('clearFaviconSpinner does nothing when no spinner active', () => {
    clearFaviconSpinner()
    expect(hasFaviconSpinner()).toBe(false)
  })

  it('badge takes priority — showFaviconBadge while spinner active upgrades state', async () => {
    await showFaviconSpinner()
    expect(hasFaviconSpinner()).toBe(true)
    await showFaviconBadge()
    expect(hasFaviconBadge()).toBe(true)
    expect(hasFaviconSpinner()).toBe(false)
  })

  it('showFaviconSpinner does not downgrade an active badge', async () => {
    await showFaviconBadge()
    await showFaviconSpinner()
    expect(hasFaviconBadge()).toBe(true)
    expect(hasFaviconSpinner()).toBe(false)
  })

  it('clearFaviconSpinner does not clear an active badge', async () => {
    await showFaviconBadge()
    clearFaviconSpinner() // no-op when state is badge
    expect(hasFaviconBadge()).toBe(true)
  })
})

// ── buildSpinnerSvg (pure) ─────────────────────────────────────────────────

describe('buildSpinnerSvg', () => {
  const BASE = MOCK_FAVICON_SVG

  it('returns a data:image/svg+xml data URL', () => {
    const result = buildSpinnerSvg(BASE)
    expect(result).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
  })

  it('embeds the original favicon inner content', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('translate(256,256)')
    expect(result).toContain('polygon')
  })

  it('includes an animateTransform element for rotation', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('animateTransform')
    expect(result).toContain('type="rotate"')
    expect(result).toContain('repeatCount="indefinite"')
  })

  it('uses 1s rotation duration', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('dur="1s"')
  })

  it('includes the amber stroke color', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('#f59e0b')
  })

  it('includes a dark backing circle for contrast', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('fill="#0a0a0f"')
  })

  it('preserves the original 512×512 viewBox', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toContain('viewBox="0 0 512 512"')
  })

  it('handles a different viewBox size by scaling geometry proportionally', () => {
    const smallSvg = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><circle cx="128" cy="128" r="50"/></svg>`
    const result = decodeURIComponent(buildSpinnerSvg(smallSvg).split(',')[1])
    expect(result).toContain('viewBox="0 0 256 256"')
    // cx should be scaled to ≈ 416 * (256/512) = 208
    expect(result).toContain('cx="208"')
  })

  it('produces a valid SVG string (contains <svg> and </svg>)', () => {
    const result = decodeURIComponent(buildSpinnerSvg(BASE).split(',')[1])
    expect(result).toMatch(/^<svg /)
    expect(result).toMatch(/<\/svg>$/)
  })
})
