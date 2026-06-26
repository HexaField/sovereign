// Sovereign browser module — Playwright-Core-backed managed browser sessions.
//
// Each `open()` launches (or reuses) a Chromium-protocol browser context and
// returns a stable `sessionId`. The agent then drives the page via `act()` —
// click, type, navigate, screenshot, snapshot, evaluate, etc. — and tears it
// down with `close()`.
//
// Sessions are kept in-process. Long-running pages survive across many MCP
// tool calls within the same Sovereign thread; a session is closed
// explicitly (`close()`) or when the process exits.

import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type {
  BrowserAct,
  BrowserActResult,
  BrowserManagerConfig,
  BrowserOpenOptions,
  BrowserOpenResult,
  BrowserService,
  BrowserSessionSummary
} from './types.js'

interface SessionState {
  sessionId: string
  context: BrowserContext
  page: Page
  openedAt: number
  lastActivity: number
  /** Most recent ARIA snapshot mapping `ref` → selector. */
  refMap: Map<string, string>
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // Linux
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Playwright cache (Linux)
  ...(() => {
    try {
      const base = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright')
      return fs.existsSync(base)
        ? fs
            .readdirSync(base)
            .filter((d) => d.startsWith('chromium-'))
            .sort()
            .reverse()
            .map((d) => path.join(base, d, 'chrome-linux64', 'chrome'))
        : []
    } catch {
      return []
    }
  })()
].filter(Boolean) as string[]

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    `browser: no Chrome/Chromium binary found. Searched:\n${CHROME_CANDIDATES.join('\n')}\nSet CHROME_PATH to override.`
  )
}

const DEFAULT_MAX_SESSIONS = 4

export function createBrowserService(dataDir: string, config: BrowserManagerConfig = {}): BrowserService {
  const executablePath = config.executablePath ?? findChrome()
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS
  const userDataRoot = config.userDataRoot ?? path.join(dataDir, 'browser', 'profiles')

  const sessions = new Map<string, SessionState>()
  let sharedBrowser: Browser | null = null

  function touch(state: SessionState) {
    state.lastActivity = Date.now()
  }

  async function ensureBrowser(headed: boolean): Promise<Browser> {
    if (sharedBrowser?.isConnected()) return sharedBrowser
    sharedBrowser = await chromium.launch({
      executablePath,
      headless: !headed,
      args: ['--no-first-run', '--no-default-browser-check']
    })
    sharedBrowser.on('disconnected', () => {
      sharedBrowser = null
    })
    return sharedBrowser
  }

  async function resolveLocator(state: SessionState, ref?: string, selector?: string) {
    if (selector) return state.page.locator(selector).first()
    if (ref) {
      const sel = state.refMap.get(ref)
      if (!sel)
        throw new Error(`browser: ref "${ref}" not found in current snapshot — call act:{kind:'snapshot'} first`)
      return state.page.locator(sel).first()
    }
    throw new Error('browser: action requires `ref` or `selector`')
  }

  /** Build a compact ARIA-ish snapshot of interactive elements and update refMap. */
  async function snapshot(state: SessionState, mode: 'aria' | 'text' = 'aria'): Promise<string> {
    if (mode === 'text') {
      const text = await state.page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '')
      return text
    }
    // ARIA snapshot — walk interactive elements, assign refs.
    state.refMap.clear()
    const elements = await state.page.evaluate(() => {
      const out: Array<{ tag: string; role?: string; name?: string; selector: string }> = []
      let i = 0
      const interactive = document.querySelectorAll(
        'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="menuitem"], [tabindex]'
      )
      for (const el of interactive) {
        i++
        el.setAttribute('data-sov-ref', String(i))
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
        const name =
          (el as HTMLElement).innerText?.trim().slice(0, 60) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('value') ||
          ''
        out.push({
          tag: el.tagName.toLowerCase(),
          role,
          name,
          selector: `[data-sov-ref="${i}"]`
        })
        if (i >= 200) break
      }
      return out
    })
    const lines: string[] = []
    for (const e of elements) {
      const ref = `r${state.refMap.size + 1}`
      state.refMap.set(ref, e.selector)
      lines.push(`[${ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}`)
    }
    if (lines.length === 0) return '(no interactive elements found)'
    return lines.join('\n')
  }

  async function open(opts: BrowserOpenOptions): Promise<BrowserOpenResult> {
    if (opts.sessionId) {
      const existing = sessions.get(opts.sessionId)
      if (existing) {
        if (opts.url) await existing.page.goto(opts.url)
        touch(existing)
        return {
          sessionId: existing.sessionId,
          url: existing.page.url(),
          title: await existing.page.title(),
          summary: await snapshot(existing)
        }
      }
    }
    if (sessions.size >= maxSessions) {
      throw new Error(`browser: max ${maxSessions} concurrent sessions reached; close one first`)
    }
    fs.mkdirSync(userDataRoot, { recursive: true })
    const browser = await ensureBrowser(opts.headed ?? false)
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 }
    })
    const page = await context.newPage()
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' })
    const sessionId = opts.sessionId ?? randomUUID()
    const state: SessionState = {
      sessionId,
      context,
      page,
      openedAt: Date.now(),
      lastActivity: Date.now(),
      refMap: new Map()
    }
    sessions.set(sessionId, state)
    page.on('close', () => {
      sessions.delete(sessionId)
    })
    return {
      sessionId,
      url: page.url(),
      title: await page.title(),
      summary: await snapshot(state)
    }
  }

  async function act(sessionId: string, action: BrowserAct): Promise<BrowserActResult> {
    const state = sessions.get(sessionId)
    if (!state) throw new Error(`browser: session ${sessionId} not open`)
    touch(state)

    const result: BrowserActResult = { message: '' }

    switch (action.kind) {
      case 'navigate': {
        await state.page.goto(action.url, { waitUntil: action.waitUntil ?? 'domcontentloaded' })
        result.message = `navigated to ${state.page.url()}`
        break
      }
      case 'click': {
        if (typeof action.x === 'number' && typeof action.y === 'number') {
          await state.page.mouse.click(action.x, action.y, {
            button: action.button ?? 'left',
            clickCount: action.doubleClick ? 2 : 1
          })
          result.message = `clicked (${action.x}, ${action.y})`
        } else {
          const loc = await resolveLocator(state, action.ref, action.selector)
          await (action.doubleClick
            ? loc.dblclick({ button: action.button ?? 'left' })
            : loc.click({ button: action.button ?? 'left' }))
          result.message = `clicked ${action.ref ?? action.selector}`
        }
        break
      }
      case 'type': {
        const loc = await resolveLocator(state, action.ref, action.selector)
        await loc.type(action.text)
        if (action.submit) await loc.press('Enter')
        result.message = `typed ${JSON.stringify(action.text)}${action.submit ? ' + Enter' : ''}`
        break
      }
      case 'fill': {
        const loc = await resolveLocator(state, action.ref, action.selector)
        await loc.fill(action.text)
        result.message = `filled ${JSON.stringify(action.text)}`
        break
      }
      case 'press': {
        if (action.ref || action.selector) {
          const loc = await resolveLocator(state, action.ref, action.selector)
          await loc.press(action.key)
        } else {
          await state.page.keyboard.press(action.key)
        }
        result.message = `pressed ${action.key}`
        break
      }
      case 'hover': {
        const loc = await resolveLocator(state, action.ref, action.selector)
        await loc.hover()
        result.message = `hovered ${action.ref ?? action.selector}`
        break
      }
      case 'scroll': {
        const dx = action.deltaX ?? 0
        const dy = action.deltaY ?? 400
        if (action.ref || action.selector) {
          const loc = await resolveLocator(state, action.ref, action.selector)
          const arg: [number, number] = [dx, dy]
          await loc.evaluate((el: any, [x, y]: [number, number]) => (el as HTMLElement).scrollBy(x, y), arg)
        } else {
          await state.page.mouse.wheel(dx, dy)
        }
        result.message = `scrolled (${dx}, ${dy})`
        break
      }
      case 'wait': {
        if (action.selector) {
          await state.page.waitForSelector(action.selector, { timeout: 30000 })
          result.message = `waited for ${action.selector}`
        } else if (action.loadState) {
          await state.page.waitForLoadState(action.loadState, { timeout: 30000 })
          result.message = `waited for load state ${action.loadState}`
        } else {
          await state.page.waitForTimeout(action.timeMs ?? 1000)
          result.message = `waited ${action.timeMs ?? 1000}ms`
        }
        break
      }
      case 'snapshot': {
        const snap = await snapshot(state, action.mode ?? 'aria')
        result.message = `snapshot (${snap.split('\n').length} lines)`
        result.text = snap
        result.summary = snap
        break
      }
      case 'screenshot': {
        let buf: Buffer
        if (action.selector) {
          buf = await state.page.locator(action.selector).first().screenshot({ type: 'png' })
        } else {
          buf = await state.page.screenshot({ type: 'png', fullPage: action.fullPage ?? false })
        }
        result.message = `screenshot (${buf.byteLength} bytes)`
        result.imageBase64 = buf.toString('base64')
        result.imageMime = 'image/png'
        break
      }
      case 'evaluate': {
        const val = await state.page.evaluate(action.fn)
        const text = typeof val === 'string' ? val : JSON.stringify(val)
        result.message = `evaluated → ${text.slice(0, 80)}`
        result.text = text
        break
      }
      case 'extract': {
        const selector = action.selector
        const text = selector
          ? await state.page.locator(selector).first().textContent()
          : await state.page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '')
        result.message = `extracted ${text?.length ?? 0} chars`
        result.text = text ?? ''
        break
      }
      case 'close': {
        await close(sessionId)
        return { message: `closed session ${sessionId}` }
      }
    }

    // Always include current URL/title for context.
    try {
      result.url = state.page.url()
      result.title = await state.page.title()
    } catch {
      /* page may have closed */
    }
    return result
  }

  async function close(sessionId: string): Promise<void> {
    const state = sessions.get(sessionId)
    if (!state) return
    sessions.delete(sessionId)
    try {
      await state.context.close()
    } catch {
      /* already closed */
    }
    if (sessions.size === 0 && sharedBrowser?.isConnected()) {
      try {
        await sharedBrowser.close()
      } catch {
        /* ignore */
      }
      sharedBrowser = null
    }
  }

  function list(): BrowserSessionSummary[] {
    const out: BrowserSessionSummary[] = []
    for (const state of sessions.values()) {
      out.push({
        sessionId: state.sessionId,
        url: state.page.url(),
        title: '', // page.title() is async; UI can poll if needed
        openedAt: state.openedAt,
        lastActivity: state.lastActivity
      })
    }
    return out
  }

  async function dispose(): Promise<void> {
    for (const id of [...sessions.keys()]) {
      try {
        await close(id)
      } catch {
        /* ignore */
      }
    }
    if (sharedBrowser?.isConnected()) {
      try {
        await sharedBrowser.close()
      } catch {
        /* ignore */
      }
    }
    sharedBrowser = null
  }

  return { open, act, close, list, dispose }
}
