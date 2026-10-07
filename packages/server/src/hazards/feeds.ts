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
  id: string // stable across updates for incidents; warnings get a new id on every reissue
  kind: 'warning' | 'incident'
  category: string // category1: warning level, or incident class ("Fire", "Other"...)
  type: string // CAP event or category2: "Bushfire", "Grass Fire", "Building Fire", "Riverine Flood"...
  status: string // "Not Yet Under Control", "Responding", "Contained", "Under Control", "Safe"...
  action?: string // warning advice: "Stay Informed", "Leave Now", "Take Shelter Now"...
  feed: string // sourceFeed: "cop-cap", "cfa-incident", "cfa-fdr"...
  location: string
  updated: string
  geometry: Geometry | null
}

/** NSW RFS ids embed the update time ("2026-01-09T09:27:00.0000000:640445"); their sourceId does not. */
function stableId(p: Record<string, any>): string {
  const id = String(p.id ?? '')
  if (p.sourceId != null && (!id || /^\d{4}-\d\d-\d\dT/.test(id))) return `${p.sourceOrg ?? ''}:${p.sourceId}`
  return id || `${p.feedType}:${p.location}:${p.created}`
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
      id: stableId(p),
      kind: p.feedType,
      category: String(p.category1 ?? ''),
      type: String(p.cap?.event ?? p.category2 ?? ''),
      status: String(p.status ?? ''),
      action: p.action ? String(p.action) : undefined,
      feed: String(p.sourceFeed ?? ''),
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

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' }

/** One level of XML/HTML entity decoding. */
const decodeOnce = (s: string) =>
  s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi, (m, hex?: string, dec?: string, name?: string) => {
    if (!hex && !dec) return ENTITIES[name!.toLowerCase()] ?? m
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code <= 0x10ffff ? String.fromCodePoint(code) : m
  })

/** Decodes until no escaped markup is left, so a double-encoded description reads the same. */
const decode = (s: string) => {
  for (let i = 0; i < 3 && /&(lt|gt|amp|#\d+|#x[0-9a-f]+);/i.test(s); i++) s = decodeOnce(s)
  return s
}

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
  // A misspelt district would otherwise read as a forecast with nothing in it, forever.
  if (!out.length) throw new Error(`CFA forecast: no lines for district "${district}"`)
  return out
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
