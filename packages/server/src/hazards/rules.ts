// Which hazards genuinely need Josh's attention. Pure: feeds + state in,
// alerts + next state out. Everything below the bar stays silent.
//
// Alert when:
//   - a Watch and Act or Emergency Warning area covers the property;
//   - a vegetation fire that is not under control burns within fireRadiusKm,
//     or any uncontrolled fire within anyFireRadiusKm;
//   - a Total Fire Ban is declared for the district today or tomorrow;
//   - the district's rating is Extreme or Catastrophic today or tomorrow.
// Then once more when an alerted item escalates, and once when it eases or
// ends. Nothing else is ever sent.
//
// Vocabulary seen in archived feeds (Mar 2025, Jan 2026): warning levels
// Advice / Watch and Act / Emergency Warning / Community Update; fire statuses
// Not Yet Under Control / Not Yet Controlled / Responding / Contained /
// Under Control / Safe. Unknown levels and statuses lean towards alarm.

import { containsPoint, distanceKm, hasArea, type LatLon } from './geo.js'
import type { DayOutlook, HazardEvent } from './feeds.js'

export interface HazardRulesConfig {
  location: LatLon
  fireRadiusKm: number
  anyFireRadiusKm: number
}

export interface NotifiedItem {
  rank: number
  summary: string
  /** Consecutive reads the item has been absent from. */
  missed?: number
}

export interface HazardState {
  notified: Record<string, NotifiedItem>
}

export interface HazardAlert {
  key: string
  kind: 'new' | 'escalated' | 'eased'
  text: string
}

/** Reads an item must stay absent before "eased": a reissue gap or a short feed never reads as an all-clear. */
export const EASE_AFTER = 3

const RATING_RANK: Record<string, number> = { extreme: 1, catastrophic: 2 }
const CONTROLLED = /^(safe|under control|controlled|complete|completed|patrolled|out)$/i
const VEGETATION = /bush|grass|scrub|forest|vegetation|wildfire|plantation|crop|stubble|hay|pasture/i
/** District-wide rating and ban pseudo-incidents (category1 "Fire"): the CFA outlook covers them. */
const AREA_PRODUCT = /^(fire danger rating|total fire ban|fire ban)/i
const EMERGENCY_ACTION = /leave immediately|evacuate (now|immediately)|take shelter now|shelter indoors now/i

/** 3 Emergency Warning (any evacuation wording), 2 Watch and Act, 1 below the bar; unknown levels count as 2 or 3. */
export function warningRank(category: string, action = ''): number {
  const c = category.trim().toLowerCase().replace(/\s+/g, ' ')
  if (/evacuat/.test(c) || c.startsWith('emergency warning')) return 3
  if (/^watch (and|&) act/.test(c) || c === 'warning' || /^(major|moderate)\b/.test(c)) return 2
  if (/^(advice|watch$|(final )?minor\b|safe to return|community)/.test(c)) return 1
  return EMERGENCY_ACTION.test(action) ? 3 : 2
}

/** Warnings get a new id on every reissue, so they are keyed by hazard: one item per fire / flood / storm. */
const hazardKey = (e: HazardEvent) => {
  const t = e.type.trim().toLowerCase()
  return `warning:${/fire|bush|grass|scrub|smoke/.test(t) ? 'fire' : t || 'other'}`
}

const km = (d: number) => `${d < 10 ? d.toFixed(1) : Math.round(d)} km away`

/** The live items that clear the bar, keyed so the same item is recognised across polls. */
function liveItems(events: HazardEvent[], cfg: HazardRulesConfig): Map<string, NotifiedItem> {
  const out = new Map<string, NotifiedItem>()
  for (const e of events) {
    if (e.kind === 'warning') {
      const rank = warningRank(e.category, e.action)
      if (rank < 2) continue
      // A warning's area decides; its incident point can sit next door without covering us.
      // Without a published area, fall back to the point and the fire radius.
      const area = hasArea(e.geometry)
      const d = area ? 0 : distanceKm(e.geometry, cfg.location)
      if (area ? !containsPoint(e.geometry, cfg.location) : d > cfg.fireRadiusKm) continue
      const key = hazardKey(e)
      if ((out.get(key)?.rank ?? 0) >= rank) continue
      const action = e.action ? ` Advice: ${e.action}.` : ''
      const where = area ? 'covers your property' : `${km(d)}, no warning area published`
      out.set(key, { rank, summary: `${e.category} — ${e.type || 'warning'}, ${e.location} (${where}).${action}` })
    } else {
      const fire = /fire/i.test(e.category) || VEGETATION.test(e.type)
      if (!fire || AREA_PRODUCT.test(e.type) || CONTROLLED.test(e.status.trim())) continue
      // A mapped burnt area means a vegetation fire, whatever its category2 says ("Fire", "Other").
      const vegetation = VEGETATION.test(`${e.category} ${e.type}`) || hasArea(e.geometry)
      const d = distanceKm(e.geometry, cfg.location)
      if (d > (vegetation ? cfg.fireRadiusKm : cfg.anyFireRadiusKm)) continue
      const what = !e.type || /^(other|fire)$/i.test(e.type) ? 'Fire' : /fire/i.test(e.type) ? e.type : `${e.type} fire`
      out.set(`fire:${e.id}`, {
        rank: 1,
        summary: `${what} at ${e.location}, ${km(d)} — ${e.status || 'status unknown'}.`
      })
    }
  }
  return out
}

/** Days that clear the bar: today and tomorrow only. */
function outlookItems(outlook: DayOutlook[], today: string, tomorrow: string): Map<string, NotifiedItem> {
  const out = new Map<string, NotifiedItem>()
  for (const day of outlook) {
    if (day.date !== today && day.date !== tomorrow) continue
    const when = day.date === today ? 'Today' : 'Tomorrow'
    if (day.totalFireBan)
      out.set(`tfb:${day.date}`, { rank: 1, summary: `${when} (${day.date}) is a day of Total Fire Ban.` })
    const r = RATING_RANK[day.rating.toLowerCase()]
    if (r)
      out.set(`fdr:${day.date}`, {
        rank: r,
        summary: `${when} (${day.date}): fire danger rating ${day.rating.toUpperCase()}.`
      })
  }
  return out
}

export function evaluate(input: {
  events?: HazardEvent[] // undefined = feed not read this round: keep its items as they are
  outlook?: DayOutlook[]
  state: HazardState
  cfg: HazardRulesConfig
  today: string
  tomorrow: string
}): { alerts: HazardAlert[]; state: HazardState } {
  const { state, cfg } = input
  const next: Record<string, NotifiedItem> = { ...state.notified }
  const alerts: HazardAlert[] = []

  const reconcile = (prefixes: string[], live: Map<string, NotifiedItem>, easeOnEnd: boolean) => {
    for (const [key, item] of live) {
      const before = state.notified[key]
      if (!before) alerts.push({ key, kind: 'new', text: item.summary })
      else if (item.rank > before.rank) alerts.push({ key, kind: 'escalated', text: item.summary })
      next[key] = item
    }
    for (const [key, before] of Object.entries(state.notified)) {
      if (!prefixes.some((p) => key.startsWith(p)) || live.has(key)) continue
      const missed = (before.missed ?? 0) + 1
      if (easeOnEnd && missed < EASE_AFTER) {
        next[key] = { ...before, missed }
        continue
      }
      if (easeOnEnd) alerts.push({ key, kind: 'eased', text: before.summary })
      delete next[key]
    }
  }

  if (input.events) reconcile(['warning:', 'fire:'], liveItems(input.events, cfg), true)
  if (input.outlook) {
    // Days roll off the forecast silently; a rating that drops below Extreme is not news.
    reconcile(['tfb:', 'fdr:'], outlookItems(input.outlook, input.today, input.tomorrow), false)
  }
  return { alerts, state: { notified: next } }
}

/** One message for the presence thread, most urgent first. */
export function formatAlerts(alerts: HazardAlert[], placeLabel: string): string {
  const order = { escalated: 0, new: 1, eased: 2 }
  const lines = [...alerts]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((a) =>
      a.kind === 'eased' ? `- Eased or ended: ${a.text}` : `- ${a.kind === 'escalated' ? 'ESCALATED: ' : ''}${a.text}`
    )
  return [
    `[Hazard alert — ${placeLabel}] VicEmergency / CFA:`,
    ...lines,
    '',
    'Check https://emergency.vic.gov.au and tell Josh what this means for the property and what to do.'
  ].join('\n')
}
