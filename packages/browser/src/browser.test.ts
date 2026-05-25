import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The browser module talks to `playwright-core`'s `chromium` export. We mock
 * the whole `playwright-core` module so the manager can be unit-tested
 * without a real browser binary.
 */
vi.mock('playwright-core', () => {
  const pages: any[] = []
  const contexts: any[] = []
  const onClose: Array<() => void> = []
  const fakePage = {
    _url: 'about:blank',
    _title: 'Fake',
    goto: vi.fn(async function (this: any, url: string) {
      this._url = url
      this._title = url.replace(/^https?:\/\//, '').split('/')[0]
    }),
    url: function (this: any) {
      return this._url
    },
    title: vi.fn(async function (this: any) {
      return this._title
    }),
    evaluate: vi.fn(async (fn: any) => {
      // Playwright runs the function inside the browser; in tests we don't
      // have a DOM. Return canned values that match what the manager expects.
      if (typeof fn === 'string') return `evaluated:${fn.slice(0, 20)}`
      // For snapshot's element walker: pretend there's one fake button.
      return [{ tag: 'button', role: 'button', name: 'Fake', selector: '[data-sov-ref="1"]' }]
    }),
    locator: vi.fn((selector: string) => ({
      first: () => ({
        click: vi.fn(async () => {}),
        dblclick: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        fill: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        hover: vi.fn(async () => {}),
        textContent: vi.fn(async () => `text from ${selector}`),
        screenshot: vi.fn(async () => Buffer.from('PNG', 'utf-8')),
        evaluate: vi.fn(async () => undefined)
      })
    })),
    mouse: { click: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    waitForSelector: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('PNG', 'utf-8')),
    on: (event: string, handler: () => void) => {
      if (event === 'close') onClose.push(handler)
    }
  }
  const fakeContext = {
    newPage: vi.fn(async () => {
      const p = { ...fakePage, _url: 'about:blank', _title: 'Fake' }
      pages.push(p)
      return p
    }),
    close: vi.fn(async () => {})
  }
  const fakeBrowser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => {
      contexts.push(fakeContext)
      return fakeContext
    }),
    close: vi.fn(async () => {}),
    on: vi.fn()
  }
  return {
    chromium: {
      launch: vi.fn(async () => fakeBrowser)
    },
    __testHandles: { pages, contexts, onClose, fakePage, fakeBrowser, fakeContext }
  }
})

import { createBrowserService } from './browser.js'

describe('browser service', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sov-browser-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('open returns a stable sessionId + url + summary', async () => {
    const service = createBrowserService(dataDir)
    const out = await service.open({ url: 'https://example.com' })
    expect(out.sessionId).toBeTruthy()
    expect(out.url).toBe('https://example.com')
    expect(typeof out.summary).toBe('string')
  })

  it('open with sessionId reuses the existing session and re-navigates', async () => {
    const service = createBrowserService(dataDir)
    const a = await service.open({ url: 'https://example.com' })
    const b = await service.open({ url: 'https://other.example.com', sessionId: a.sessionId })
    expect(b.sessionId).toBe(a.sessionId)
    expect(b.url).toBe('https://other.example.com')
  })

  it('act navigate updates url + title', async () => {
    const service = createBrowserService(dataDir)
    const { sessionId } = await service.open({ url: 'https://example.com' })
    const r = await service.act(sessionId, { kind: 'navigate', url: 'https://news.example.com' })
    expect(r.url).toBe('https://news.example.com')
    expect(r.message).toMatch(/navigated/)
  })

  it('act screenshot returns base64 image content', async () => {
    const service = createBrowserService(dataDir)
    const { sessionId } = await service.open({ url: 'https://example.com' })
    const r = await service.act(sessionId, { kind: 'screenshot' })
    expect(r.imageBase64).toBeTruthy()
    expect(r.imageMime).toBe('image/png')
  })

  it('act snapshot returns an aria-style text summary', async () => {
    const service = createBrowserService(dataDir)
    const { sessionId } = await service.open({ url: 'https://example.com' })
    const r = await service.act(sessionId, { kind: 'snapshot' })
    expect(r.text).toBeDefined()
    expect(r.summary).toBe(r.text)
  })

  it('act click without ref or selector or coords throws informative error', async () => {
    const service = createBrowserService(dataDir)
    const { sessionId } = await service.open({ url: 'https://example.com' })
    await expect(service.act(sessionId, { kind: 'click' } as any)).rejects.toThrow(/ref/)
  })

  it('act on an unknown sessionId throws', async () => {
    const service = createBrowserService(dataDir)
    await expect(service.act('nope', { kind: 'navigate', url: 'https://x.com' })).rejects.toThrow(/not open/)
  })

  it('list returns open sessions; close removes them', async () => {
    const service = createBrowserService(dataDir)
    const { sessionId } = await service.open({ url: 'https://example.com' })
    expect(service.list().map((s) => s.sessionId)).toContain(sessionId)
    await service.close(sessionId)
    expect(service.list().map((s) => s.sessionId)).not.toContain(sessionId)
  })

  it('respects the maxSessions cap', async () => {
    const service = createBrowserService(dataDir, { maxSessions: 1 })
    await service.open({ url: 'https://a.com' })
    await expect(service.open({ url: 'https://b.com' })).rejects.toThrow(/max 1/)
  })
})
