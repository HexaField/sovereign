import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub canvas + image before importing the module
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

// Stub Image — onload fires synchronously so renderBadge resolves
class MockImage {
  crossOrigin = ''
  src = ''
  onload: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  set _src(v: string) {
    this.src = v
    if (this.onload) this.onload()
  }
}

// Override src setter to trigger onload
vi.stubGlobal(
  'Image',
  class extends MockImage {
    constructor() {
      super()
      // Fire onload on next microtask after src gets set
      const self = this
      const desc = Object.getOwnPropertyDescriptor(MockImage.prototype, 'src') || {
        writable: true
      }
      Object.defineProperty(this, 'src', {
        get() {
          return desc.get ? desc.get.call(self) : self._srcValue
        },
        set(v: string) {
          self._srcValue = v
          setTimeout(() => self.onload?.(), 0)
        }
      })
    }
    _srcValue = ''
  }
)

// Dynamic import so stubs take effect
let showFaviconBadge: () => Promise<void>
let clearFaviconBadge: () => void
let hasFaviconBadge: () => boolean

beforeEach(async () => {
  // Fresh module per test
  vi.resetModules()
  const mod = await import('./favicon-badge.js')
  showFaviconBadge = mod.showFaviconBadge
  clearFaviconBadge = mod.clearFaviconBadge
  hasFaviconBadge = mod.hasFaviconBadge
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('showFaviconBadge does nothing when called twice', async () => {
    await showFaviconBadge()
    const firstCall = hasFaviconBadge()
    await showFaviconBadge()
    expect(hasFaviconBadge()).toBe(firstCall)
  })

  it('clearFaviconBadge does nothing when no badge active', () => {
    // Should not throw
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
