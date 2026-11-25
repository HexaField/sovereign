// UI lane: a theme chosen in one tab reaches the other tabs of the same browser.
//
// One browser context, two pages (tabs share localStorage only inside a context).
// Tab A picks "Iron Man" in the real picker (status dot popover). Tab B is not
// reloaded: the script checks its root class and takes a screenshot of each tab.
// A second context, a different "device", must stay on its own theme.
//
//   ./wind-tunnel/run.sh --ui --ui-script theme-tabs-shots [--baseline]
//
// --baseline (a checkout without the fix): shots are before-*.png and B is
// expected to stay on the old theme. SAFETY: refuses the production port.

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

const rootClass = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.className)
const hasTheme = async (page: Page, theme: string): Promise<boolean> =>
  (await rootClass(page)).split(/\s+/).includes(theme)

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

async function openTab(ctx: import('playwright-core').BrowserContext): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(base + '/', { waitUntil: 'load' })
  await page.locator('button[title]:has(span.rounded-full)').first().waitFor({ timeout: 30000 })
  return page
}

async function run(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true })
  await waitUntilSteady()
  const browser = await chromium.launch({
    executablePath: process.env.SWT_CHROMIUM || undefined,
    args: ['--disable-gpu']
  })
  const newContext = () =>
    browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' })
  const shoot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`), animations: 'disabled' })
  try {
    const ctx = await newContext()
    // The init script runs in every page of the context, on every load: set the device name once only.
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('sovereign:deviceName')) localStorage.setItem('sovereign:deviceName', 'wind-tunnel')
    })
    const a = await openTab(ctx)
    const b = await openTab(ctx)
    const other = await openTab(await newContext()) // another device: its own storage
    check(!(await hasTheme(b, 'ironman')), 'tab B starts without ironman')

    // The real picker: status dot → popover → "Iron Man".
    await a.locator('button[title]:has(span.rounded-full)').first().click()
    await a.getByRole('button', { name: 'Iron Man' }).click()
    check(await hasTheme(a, 'ironman'), 'tab A applied ironman')
    check((await a.evaluate(() => localStorage.getItem('sovereign:theme'))) === 'ironman', 'tab A stored the choice')

    await b.waitForTimeout(1500)
    if (baseline) check(!(await hasTheme(b, 'ironman')), 'baseline: tab B did not follow (no reload)')
    else check(await hasTheme(b, 'ironman'), 'tab B follows without a reload')
    check(!(await hasTheme(other, 'ironman')), 'a tab of another browser context (device) is unchanged')

    await shoot(a, 'tab-A')
    await shoot(b, 'tab-B')
    await shoot(other, 'other-device')
  } finally {
    await browser.close()
  }
  if (problems.length) {
    console.error(`\n${problems.length} check(s) failed`)
    process.exit(1)
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
