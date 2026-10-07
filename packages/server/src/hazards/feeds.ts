// Parsers for the two public Victorian hazard feeds.
//
// VicEmergency: https://emergency.vic.gov.au/public/events-geojson.json —
//   every current warning and incident (fires, floods, storms...) as GeoJSON.
//   Warnings carry their level in category1 (Advice / Watch and Act /
//   Emergency Warning) and their area as polygons.
// CFA: https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml — one
//   RSS item per day (4 days) listing Total Fire Ban and the BOM Fire Danger
//   Rating for every fire district.

import type { Geometry } from './geo.js'

export const VICEMERGENCY_URL = 'https://emergency.vic.gov.au/public/events-geojson.json'
export const CFA_FORECAST_URL = 'https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml'

export interface HazardEvent {
  id: string
  kind: 'warning' | 'incident'
  category: string // category1: warning level, or incident class ("Fire")
  type: string // category2 or CAP event: "Bushfire", "Grass", "Riverine Flood"...
  status: string // "Going", "Responding", "Under Control", "Safe", "Minor"...
  action?: string // warning advice: "Stay Informed", "Leave Now"...
  location: string
  updated: string
  geometry: Geometry | null
}

export interface DayOutlook {
  date: string // YYYY-MM-DD (local)
  totalFireBan: boolean
  rating: string // "No Rating", "Moderate", "High", "Extreme", "Catastrophic"
}

export function parseVicEmergency(json: unknown): HazardEvent[] {
  const features = (json as { features?: unknown[] })?.features
  if (!Array.isArray(features)) throw new Error('VicEmergency feed: no features array')
  const out: HazardEvent[] = []
  for (const f of features as Array<{ properties?: Record<string, any>; geometry?: Geometry }>) {
    const p = f.properties ?? {}
    if (p.feedType !== 'warning' && p.feedType !== 'incident') continue
    out.push({
      id: String(p.id ?? p.sourceId ?? `${p.feedType}:${p.location}:${p.created}`),
      kind: p.feedType,
      category: String(p.category1 ?? ''),
      type: String(p.cap?.event ?? p.category2 ?? ''),
      status: String(p.status ?? ''),
      action: p.action ? String(p.action) : undefined,
      location: String(p.location ?? p.name ?? ''),
      updated: String(p.updated ?? p.created ?? ''),
      geometry: f.geometry ?? null
    })
  }
  return out
}

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12'
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** The district's outlook for each day in the CFA forecast. */
export function parseCfaForecast(xml: string, district: string): DayOutlook[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1])
  if (!items.length) throw new Error('CFA forecast: no items')
  const esc = district.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out: DayOutlook[] = []
  for (const item of items) {
    const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
    const d = title.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
    if (!d || !MONTHS[d[2].toLowerCase()]) continue
    const date = `${d[3]}-${MONTHS[d[2].toLowerCase()]}-${d[1].padStart(2, '0')}`
    const text = decode(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').replace(/<[^>]+>/g, '\n')
    const [banPart, ratingPart = ''] = text.split(/Fire Danger Ratings/i)
    const ban = banPart.match(new RegExp(`^\\s*${esc}:\\s*(YES|NO)\\b`, 'im'))?.[1]
    const rating = ratingPart.match(new RegExp(`^\\s*${esc}:\\s*([A-Za-z ]+?)\\s*$`, 'im'))?.[1]
    if (!ban && !rating) continue
    out.push({ date, totalFireBan: ban?.toUpperCase() === 'YES', rating: titleCase(rating ?? 'No Rating') })
  }
  return out
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
