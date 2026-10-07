// Hazard monitor: polls VicEmergency and the CFA forecast for one property and
// sends a message to the presence thread only when something clears the bar
// in rules.ts. State persists in <dataDir>/hazards/state.json, so a restart
// never repeats an alert.

import fs from 'node:fs'
import path from 'node:path'
import { CFA_FORECAST_URL, VICEMERGENCY_URL, parseCfaForecast, parseVicEmergency, type DayOutlook } from './feeds.js'
import { evaluate, formatAlerts, type HazardState } from './rules.js'

export interface HazardsConfig {
  enabled: boolean
  label: string
  lat: number
  lon: number
  fireDistrict: string
  fireRadiusKm: number
  anyFireRadiusKm: number
  pollMs: number
  forecastPollMs: number
  timeZone: string
}

export interface HazardServiceDeps {
  dataDir: string
  config: () => HazardsConfig
  notify: (text: string) => Promise<void>
  fetch?: typeof fetch
  now?: () => number
}

/** A blind VicEmergency feed is news only on a dangerous day, after this long. */
const BLIND_AFTER_MS = 30 * 60_000
const DANGEROUS = /high|extreme|catastrophic/i
const TAG = '[hazards]'

interface Persisted extends HazardState {
  blindNotified?: string // date the "feed down" message went out
}

export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

/** The calendar day after a YYYY-MM-DD date (not now + 24 h, which a 25-hour DST day breaks). */
export function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function createHazardService(deps: HazardServiceDeps) {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const file = path.join(deps.dataDir, 'hazards', 'state.json')
  let state: Persisted = load()
  let outlook: DayOutlook[] = []
  let lastEventsOk = now()
  let lastForecastAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  function load(): Persisted {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as Persisted
    } catch {
      return { notified: {} }
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  }

  async function get(url: string): Promise<string> {
    const res = await doFetch(url, {
      headers: { 'user-agent': 'Sovereign hazard monitor' },
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
    return res.text()
  }

  /** One round: read what is due, evaluate, send what clears the bar. A no-op while disabled. */
  async function poll(): Promise<void> {
    const cfg = deps.config()
    const t = now()
    if (!cfg.enabled) {
      lastEventsOk = t // time spent switched off is not time spent blind
      return
    }
    const today = localDate(t, cfg.timeZone)
    const tomorrow = nextDate(today)

    let events: ReturnType<typeof parseVicEmergency> | undefined
    try {
      events = parseVicEmergency(JSON.parse(await get(VICEMERGENCY_URL)))
      lastEventsOk = t
    } catch (err) {
      console.warn(TAG, 'VicEmergency read failed:', (err as Error).message)
    }

    let freshOutlook: DayOutlook[] | undefined
    if (t - lastForecastAt >= cfg.forecastPollMs) {
      try {
        freshOutlook = parseCfaForecast(await get(CFA_FORECAST_URL), cfg.fireDistrict)
        outlook = freshOutlook
        lastForecastAt = t
      } catch (err) {
        console.warn(TAG, 'CFA forecast read failed:', (err as Error).message)
      }
    }

    const result = evaluate({
      events,
      outlook: freshOutlook,
      state,
      cfg: {
        location: { lat: cfg.lat, lon: cfg.lon },
        fireRadiusKm: cfg.fireRadiusKm,
        anyFireRadiusKm: cfg.anyFireRadiusKm
      },
      today,
      tomorrow
    })
    // Each send commits its own state, so a failed send retries next round without repeating the ones before it.
    const commit = (next: Persisted) => {
      if (JSON.stringify(next) === JSON.stringify(state)) return
      state = next
      save()
    }
    if (result.alerts.length) await deps.notify(formatAlerts(result.alerts, cfg.label))
    commit({ ...state, notified: result.state.notified })

    // The monitor going blind matters only when today is dangerous.
    const todayOutlook = outlook.find((d) => d.date === today)
    const dangerous = !!todayOutlook && (todayOutlook.totalFireBan || DANGEROUS.test(todayOutlook.rating))
    if (t - lastEventsOk >= BLIND_AFTER_MS && dangerous && state.blindNotified !== today) {
      await deps.notify(
        `[Hazard alert — ${cfg.label}] The VicEmergency feed has been unreadable for ${Math.round((t - lastEventsOk) / 60_000)} min ` +
          `on a ${todayOutlook!.totalFireBan ? 'Total Fire Ban' : todayOutlook!.rating} day, so new warnings near the property would go unseen. ` +
          'Tell Josh to watch the VicEmergency app directly until it recovers.'
      )
      commit({ ...state, blindNotified: today })
    }
  }

  function schedule() {
    if (!running) return
    timer = setTimeout(async () => {
      try {
        await poll()
      } catch (err) {
        console.warn(TAG, 'poll failed:', (err as Error).message)
      }
      schedule()
    }, deps.config().pollMs)
    timer.unref?.()
  }

  return {
    /** Runs the loop whatever `enabled` says, so turning it on or off in the config takes effect without a restart. */
    start() {
      if (running) return
      running = true
      void poll()
        .catch((err) => console.warn(TAG, 'first poll failed:', (err as Error).message))
        .finally(schedule)
      const cfg = deps.config()
      if (cfg.enabled) console.log(TAG, `watching ${cfg.label} (${cfg.fireDistrict} fire district)`)
    },
    stop() {
      running = false
      clearTimeout(timer)
    },
    poll,
    status: () => ({ notified: state.notified, outlook, lastEventsOk, lastForecastAt })
  }
}
