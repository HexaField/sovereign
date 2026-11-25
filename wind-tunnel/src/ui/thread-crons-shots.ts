// UI lane: a thread's crons in the thread settings dropdown, in a browser.
//
// Seeds one thread and two crons through the wind tunnel's own API, opens the
// client the isolated Sovereign serves, and shoots the dropdown. With --baseline
// (a checkout from before the change) it also opens the old "Manage Crons" modal.
// Without it, it shoots the add form and a refused create: the thread is archived
// behind the open page, so the form's submit is refused by the server.
//
// Start the stack with the client built in (from wind-tunnel/):
//   SWT_WITH_CLIENT=1 docker compose -f docker/docker-compose.yml up -d --build
//   npx tsx src/ui/thread-crons-shots.ts --prefix after [--baseline]
//   docker compose -f docker/docker-compose.yml down -v
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

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const THREAD_LABEL = 'Release planning'

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

async function seed(): Promise<string> {
  const thread = (await api('POST', '/api/threads', { label: THREAD_LABEL })).thread
  const crons = [
    {
      name: 'Morning digest',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
      prompt: 'Summarise open work.'
    },
    { name: 'Stand-up nudge', schedule: { kind: 'interval', everyMs: 4 * 3_600_000 }, prompt: 'Ask for blockers.' }
  ]
  for (const c of crons) {
    // The old checkout has no /api/crons POST; its crons are raw jobs with a user-message payload.
    if (baseline) {
      await api('POST', '/api/jobs', {
        name: c.name,
        schedule: c.schedule,
        payload: { kind: 'sovereign.userMessage', threadKey: thread.id, prompt: c.prompt, label: c.name }
      })
    } else {
      await api('POST', '/api/crons', { threadKey: thread.id, ...c })
    }
  }
  return thread.id
}

const STYLE = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
* { font-family: "DejaVu Sans", sans-serif !important; }
`
const STATUS_DOT = 'button[title^="all services"], button[title^="service "]'

async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.addStyleTag({ content: `${STATUS_DOT} { visibility: hidden !important; }` })
  const file = path.join(outDir, `${prefix}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  📸 ${file}`)
}

async function run(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true })
  await waitUntilSteady()
  const threadId = await seed()

  const browser = await chromium.launch({
    executablePath: process.env.SWT_CHROMIUM || undefined,
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-gpu']
  })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce'
    })
    const page = await ctx.newPage()
    await page.addInitScript(() => localStorage.setItem('sovereign:deviceName', 'wind-tunnel'))
    await page.goto(base + '/', { waitUntil: 'load' })
    await page.getByText(THREAD_LABEL, { exact: true }).first().waitFor({ timeout: 20000 })
    await page.addStyleTag({ content: STYLE })
    await page.locator('button[title="Thread settings"]').first().click()
    await page.getByText('Morning digest').first().waitFor({ timeout: 10000 })
    await page.getByText('Stand-up nudge').first().waitFor({ timeout: 10000 })
    check(true, 'the dropdown lists both crons')
    await shoot(page, 'settings-two-crons')

    if (baseline) {
      await page.getByRole('button', { name: 'Manage Crons' }).first().click()
      await page.waitForTimeout(1500) // the modal loads every cron over the network
      await shoot(page, 'manage-crons-modal')
    } else {
      check((await page.getByRole('button', { name: 'Manage Crons' }).count()) === 0, 'no Manage Crons button')
      await page.getByRole('button', { name: 'Add cron' }).first().click()
      await page.getByLabel('Message').fill('Check the release branch.')
      await page.getByLabel('Name').fill('Release check')
      await page.getByLabel('Cron expression').fill('0 17 * * 5')
      await shoot(page, 'add-cron-form')

      // Archive the thread behind the open page: the form still targets it, and the server refuses.
      await api('DELETE', `/api/threads/${threadId}`)
      await page.getByRole('button', { name: 'Add cron' }).last().click()
      await page
        .getByText(/does not exist/)
        .first()
        .waitFor({ timeout: 10000 })
      check(true, 'a create on a thread that is gone is refused, and the form shows why')
      await shoot(page, 'create-refused')
      check((await api('GET', '/api/crons')).crons.length === 2, 'the refused create stored nothing')
    }
    await ctx.close()
  } finally {
    await browser.close()
  }
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
