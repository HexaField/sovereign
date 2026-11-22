// UI lane: the per-thread Forge decisions indicator and panel, in a browser.
//
// Seeds a fixed scene through the wind tunnel's own API (two membranes, a thread
// with a fixed label, open decisions for it in both membranes, one answered, and
// one for another thread), then drives the client the isolated Sovereign serves
// (run.sh --ui builds the image with the client) and takes screenshots at fixed
// viewports. Besides the pixels it asserts what the pixels show: the badge count,
// the rows of the panel, and that the panel never touched /api/forge/views.
//
// Determinism: a frozen clock (page.clock.setFixedTime, set from the seeded
// decisions' own timestamps so their ages read the same on every run), animations
// and transitions off, a fixed locale/timezone/colour scheme/scale, and one font
// stack for everything. Two runs against fresh containers produce the same bytes.
//
//   npx tsx src/ui/thread-decisions-shots.ts --sovereign-url http://localhost:5811 \
//     --out .screenshots --prefix after
//
// SAFETY: like the runner, it refuses the production port.

import { chromium, type Page } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const base = arg('sovereign-url', 'http://localhost:5811').replace(/\/$/, '')
const outDir = path.resolve(arg('out', '.screenshots'))
const prefix = arg('prefix', 'after')
// --baseline: a checkout without the feature; only the thread's header and its empty chat are shot.
const baseline = args.includes('--baseline')
if (base.includes(':5801')) {
  console.error('✗ REFUSED — sovereign-url points at port 5801 (production).')
  process.exit(1)
}

const problems: string[] = []
const check = (ok: boolean, msg: string): void => {
  if (!ok) problems.push(msg)
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

// ── Seed ────────────────────────────────────────────────────────────────
async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const M1 = 'ui-alpha'
const M2 = 'ui-beta'
const THREAD_LABEL = 'Release planning'

/** The server can restart once while it comes up: wait for a steady stretch of healthy answers. */
async function waitUntilSteady(): Promise<void> {
  let ok = 0
  for (let i = 0; i < 120 && ok < 5; i++) {
    ok = (await fetch(`${base}/health`)
      .then((r) => r.ok)
      .catch(() => false))
      ? ok + 1
      : 0
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (ok < 5) throw new Error('Sovereign did not settle')
}

async function seed(): Promise<{ newest: string }> {
  for (const [id, name] of [
    [M1, 'Alpha'],
    [M2, 'Beta']
  ] as const)
    await api('POST', '/api/membranes', { id, name, workspaceIds: [] })
  const other = (await api('POST', '/api/threads', { label: 'Side quest', membraneId: M1 })).thread
  const thread = (await api('POST', '/api/threads', { label: THREAD_LABEL, membraneId: M1 })).thread
  const open = (membrane: string, question: string, threadId: string | undefined, extra: object = {}) =>
    api('POST', `/api/forge/decisions?membrane=${membrane}`, {
      question,
      threadId,
      createdBy: 'agent',
      ...extra
    })
  // Three open ones for the thread: two in its own membrane, one in another.
  await open(M1, 'Ship the release on Friday?', thread.id, {
    context: 'CI is green and the changelog is drafted.',
    options: ['Ship Friday', 'Wait for Monday']
  })
  await open(M1, 'Which name for the new endpoint?', thread.id, {
    options: ['/v2/plans', '/v2/roadmaps']
  })
  await open(M2, 'Drop support for Node 18?', thread.id, { context: 'Usage is under one percent.' })
  // Answered: opened with no thread (so resolving sends nothing anywhere), resolved,
  // then addressed to the thread. It must not count, and shows under "Answered".
  const answered = await open(M1, 'Use the shared fixtures?', undefined, {
    options: ['Yes', 'No']
  })
  await api('POST', `/api/forge/decisions/resolve?membrane=${M1}`, {
    membrane: M1,
    items: [{ id: answered.id, resolution: 'Yes' }]
  })
  await api('POST', `/api/forge/decisions/group?membrane=${M1}`, { ids: [answered.id], threadId: thread.id })
  // Someone else's.
  await open(M1, 'Rename the side quest?', other.id)
  const all = [
    ...(await api('GET', `/api/forge/decisions?membrane=${M1}&status=all`)).decisions,
    ...(await api('GET', `/api/forge/decisions?membrane=${M2}&status=all`)).decisions
  ] as Array<{ createdAt: string }>
  const newest = all.map((d) => d.createdAt).sort()[all.length - 1]!
  return { newest }
}

// ── Browser ─────────────────────────────────────────────────────────────
const STYLE = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
* { font-family: "DejaVu Sans", sans-serif !important; }
`

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}

/**
 * The header's status dot shows the agent backend's connection, which in the container
 * flaps between degraded and error on its own, so it is hidden in every shot (the state
 * it showed is logged) and the images differ only by what the change draws. Hidden, not
 * masked: a mask paints over whatever covers the dot, such as the panel's close button.
 */
const STATUS_DOT = 'button[title^="all services"], button[title^="service "]'
const statusDot = (page: Page) => page.locator(STATUS_DOT).first()

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page)
  console.log(`  status dot: ${await statusDot(page).getAttribute('title')} (hidden)`)
  await page.addStyleTag({ content: `${STATUS_DOT} { visibility: hidden !important; }` })
  const file = path.join(outDir, `${prefix}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  📸 ${file}`)
}

async function openThread(page: Page, label: string): Promise<void> {
  await page.goto(base + '/', { waitUntil: 'load' })
  // The client opens the newest thread, so the scene creates the thread under test last.
  await page.getByText(label, { exact: true }).first().waitFor({ timeout: 20000 })
}

async function run(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true })
  await waitUntilSteady()
  const { newest } = await seed()
  const viewsBefore = JSON.stringify(await api('GET', `/api/forge/views?membrane=${M1}`))

  const browser = await chromium.launch({
    // SWT_CHROMIUM: a Chromium binary other than the one playwright-core is pinned to.
    executablePath: process.env.SWT_CHROMIUM || undefined,
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-gpu']
  })
  try {
    // "Now" is a fixed offset after the newest seeded decision, so ages read "3h" on every run.
    const now = new Date(new Date(newest).getTime() + 3.5 * 3600_000)
    for (const [kind, viewport] of [
      ['desktop', { width: 1440, height: 900 }],
      ['mobile', { width: 390, height: 844 }]
    ] as const) {
      const ctx = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        isMobile: kind === 'mobile',
        hasTouch: kind === 'mobile'
      })
      const page = await ctx.newPage()
      const viewWrites: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/api/forge/views') && r.method() !== 'GET') viewWrites.push(r.url())
      })
      await page.clock.install({ time: now })
      await page.clock.setFixedTime(now)
      await page.addInitScript(() => localStorage.setItem('sovereign:deviceName', 'wind-tunnel'))
      await openThread(page, THREAD_LABEL)
      await page.addStyleTag({ content: STYLE })

      const badge = page.getByTestId('thread-decisions-badge')
      if (baseline) {
        await page.waitForTimeout(3000)
        check((await badge.count()) === 0, `${kind}: baseline has no badge`)
        await shoot(page, `${kind}-header-badge`)
        await ctx.close()
        continue
      }
      await badge.waitFor({ timeout: 15000 })
      check((await badge.innerText()).trim().replace(/\s+/g, '') === '3', `${kind}: badge shows 3 open`)
      await shoot(page, `${kind}-header-badge`)

      await badge.click()
      const panel = page.getByTestId('thread-decisions-panel')
      await panel.waitFor({ timeout: 10000 })
      await page.getByText('Ship the release on Friday?').waitFor({ timeout: 10000 })
      const text = await panel.innerText()
      for (const q of ['Ship the release on Friday?', 'Which name for the new endpoint?', 'Drop support for Node 18?'])
        check(text.includes(q), `${kind}: panel lists "${q}"`)
      check(!text.includes('Rename the side quest?'), `${kind}: panel omits the other thread's decision`)
      check(
        !text.includes('Use the shared fixtures?') || /answered/i.test(text),
        `${kind}: answered one is not among the open`
      )
      await shoot(page, `${kind}-panel`)
      check(viewWrites.length === 0, `${kind}: no write to /api/forge/views (${viewWrites.length})`)
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  const viewsAfter = JSON.stringify(await api('GET', `/api/forge/views?membrane=${M1}`))
  check(viewsAfter === viewsBefore, 'the Forge views are unchanged')
}

run()
  .catch((e) => {
    console.error(e)
    problems.push(String(e))
  })
  .finally(() => {
    console.log(problems.length ? `\n✗ ${problems.length} problem(s)` : '\n✓ UI lane passed')
    process.exit(problems.length ? 1 : 0)
  })
