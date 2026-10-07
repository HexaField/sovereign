// Which hazards genuinely need Josh's attention. Pure: feeds + state in,
// alerts + next state out. Everything below the bar stays silent.
//
// Alert when:
//   - a warning of Watch and Act or Emergency Warning covers the property;
//   - a vegetation fire that is not under control burns within fireRadiusKm,
//     or any uncontrolled fire within anyFireRadiusKm;
//   - a Total Fire Ban is declared for the district today or tomorrow;
//   - the district's rating is Extreme or Catastrophic today or tomorrow.
// Then once more when an alerted item escalates, and once when it eases or
// ends. Nothing else is ever sent.

import { containsPoint, distanceKm, type LatLon } from './geo.js'
import type { DayOutlook, HazardEvent } from './feeds.js'

export interface HazardRulesConfig {
  location: LatLon
  fireRadiusKm: number
  anyFireRadiusKm: number
}

export interface NotifiedItem {
  rank: number
  summary: string
}

export interface HazardState {
  notified: Record<string, NotifiedItem>
}

export interface HazardAlert {
  key: string
  kind: 'new' | 'escalated' | 'eased'
  text: string
}

const WARNING_RANK: Record<string, number> = { advice: 1, 'watch and act': 2, 'emergency warning': 3 }
const RATING_RANK: Record<string, number> = { extreme: 1, catastrophic: 2 }
const CONTROLLED = /^(safe|under control|controlled|complete|completed|patrol|out)$/i
const VEGETATION = /bush|grass|scrub|forest|vegetation|wildfire|plantation/i

export const warningRank = (category: string): number => WARNING_RANK[category.trim().toLowerCase()] ?? 0

const km = (d: number) => `${d < 10 ? d.toFixed(1) : Math.round(d)} km away`

/** The live items that clear the bar, keyed so the same item is recognised across polls. */
function liveItems(events: HazardEvent[], cfg: HazardRulesConfig): Map<string, NotifiedItem> {
  const out = new Map<string, NotifiedItem>()
  for (const e of events) {
    if (e.kind === 'warning') {
      // Only the warning's polygon counts: its incident point can sit next door without covering us.
      const rank = warningRank(e.category)
      if (rank >= 2 && containsPoint(e.geometry, cfg.location)) {
        const action = e.action ? ` Advice: ${e.action}.` : ''
        out.set(`warning:${e.id}`, {
          rank,
          summary: `${e.category} — ${e.type || 'warning'}, ${e.location} (covers your property).${action}`
        })
      }
    } else if (/fire/i.test(e.category) && !CONTROLLED.test(e.status.trim())) {
      const vegetation = VEGETATION.test(e.type) || VEGETATION.test(e.category)
      const d = distanceKm(e.geometry, cfg.location)
      if (d <= (vegetation ? cfg.fireRadiusKm : cfg.anyFireRadiusKm)) {
        out.set(`fire:${e.id}`, {
          rank: 1,
          summary: `${e.type && e.type !== 'Other' ? `${e.type} fire` : 'Fire'} at ${e.location}, ${km(d)} — ${e.status}.`
        })
      }
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
