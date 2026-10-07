import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { containsPoint, distanceKm, haversineKm } from './geo.js'
import { parseCfaForecast, parseVicEmergency, CFA_FORECAST_URL, VICEMERGENCY_URL, type HazardEvent } from './feeds.js'
import { evaluate, formatAlerts, type HazardState } from './rules.js'
import { createHazardService, localDate, type HazardsConfig } from './service.js'

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf-8')

// A made-up property and the shapes around it.
const HOME = { lat: -37.79, lon: 145.41 }
const square = (lat: number, lon: number, half: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon - half, lat - half],
      [lon + half, lat - half],
      [lon + half, lat + half],
      [lon - half, lat + half],
      [lon - half, lat - half]
    ]
  ]
})
const point = (lat: number, lon: number) => ({ type: 'Point', coordinates: [lon, lat] })
const KM = 1 / 111 // ~1 km of latitude in degrees

const warning = (id: string, level: string, geometry: object, extra: Partial<HazardEvent> = {}): HazardEvent => ({
  id,
  kind: 'warning',
  category: level,
  type: 'Bushfire',
  status: 'Major',
  action: 'Leave Now',
  location: 'Wandin',
  updated: '2026-01-10T12:00:00+11:00',
  geometry: { type: 'GeometryCollection', geometries: [point(HOME.lat, HOME.lon), geometry] } as never,
  ...extra
})
const fire = (id: string, type: string, status: string, kmAway: number): HazardEvent => ({
  id,
  kind: 'incident',
  category: 'Fire',
  type,
  status,
  location: 'Somewhere Rd',
  updated: '2026-01-10T12:00:00+11:00',
  geometry: point(HOME.lat + kmAway * KM, HOME.lon) as never
})

const cfg = { location: HOME, fireRadiusKm: 5, anyFireRadiusKm: 1 }
const empty: HazardState = { notified: {} }
const run = (
  state: HazardState,
  extra: { events?: HazardEvent[]; outlook?: Parameters<typeof evaluate>[0]['outlook'] }
) => evaluate({ ...extra, state, cfg, today: '2026-01-10', tomorrow: '2026-01-11' })

describe('geo', () => {
  it('finds a point inside a polygon, a hole, a multipolygon and a collection', () => {
    expect(containsPoint(square(HOME.lat, HOME.lon, 0.1) as never, HOME)).toBe(true)
    expect(containsPoint(square(HOME.lat + 1, HOME.lon, 0.1) as never, HOME)).toBe(false)
    const holed = {
      type: 'Polygon',
      coordinates: [square(HOME.lat, HOME.lon, 0.1).coordinates[0], square(HOME.lat, HOME.lon, 0.01).coordinates[0]]
    }
    expect(containsPoint(holed as never, HOME)).toBe(false)
    const multi = {
      type: 'MultiPolygon',
      coordinates: [square(0, 0, 1).coordinates, square(HOME.lat, HOME.lon, 0.1).coordinates]
    }
    expect(containsPoint(multi as never, HOME)).toBe(true)
  })

  it('measures distance to the nearest point, 0 inside', () => {
    expect(haversineKm({ lat: -37.8, lon: 145 }, { lat: -37.9, lon: 145 })).toBeCloseTo(11.1, 1)
    expect(distanceKm(point(HOME.lat + 3 * KM, HOME.lon) as never, HOME)).toBeCloseTo(3, 1)
    expect(distanceKm(square(HOME.lat, HOME.lon, 0.1) as never, HOME)).toBe(0)
    expect(distanceKm(null, HOME)).toBe(Infinity)
  })
})

describe('feeds (real captures, 7 Oct 2026)', () => {
  it('reads VicEmergency warnings and incidents with their levels and geometry', () => {
    const events = parseVicEmergency(JSON.parse(fixture('vicemergency-2026-10-07.json')))
    expect(events).toHaveLength(13)
    const flood = events.find((e) => e.kind === 'warning')!
    expect(flood).toMatchObject({ category: 'Advice', type: 'Riverine Flood', action: 'Stay Informed' })
    expect(flood.geometry?.type).toBe('GeometryCollection')
    expect(events.filter((e) => e.category === 'Fire').map((e) => e.status)).toEqual(['Responding', 'Responding'])
  })

  it('reads the CFA forecast for one district: fire ban and rating per day', () => {
    const days = parseCfaForecast(fixture('cfa-forecast-2026-10-07.xml'), 'Central')
    expect(days.map((d) => d.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
    expect(days.every((d) => d.totalFireBan === false)).toBe(true)
    expect(days[0].rating).toBe('No Rating')
  })

  it('reads a declared fire ban and an Extreme rating', () => {
    const xml = `<rss><channel><item><title>Saturday, 10 January 2026</title><description>&lt;p&gt;Central: YES - TOTAL FIRE BAN IN FORCE&lt;br&gt;Mallee: NO - RESTRICTIONS MAY APPLY&lt;/p&gt;&lt;p&gt;Fire Danger Ratings&lt;/p&gt;&lt;p&gt;Central: EXTREME&lt;br&gt;Mallee: HIGH&lt;/p&gt;</description></item></channel></rss>`
    expect(parseCfaForecast(xml, 'Central')).toEqual([{ date: '2026-01-10', totalFireBan: true, rating: 'Extreme' }])
    expect(parseCfaForecast(xml, 'Mallee')).toEqual([{ date: '2026-01-10', totalFireBan: false, rating: 'High' }])
  })

  it('rejects a feed with the wrong shape', () => {
    expect(() => parseVicEmergency({})).toThrow()
    expect(() => parseCfaForecast('<html/>', 'Central')).toThrow()
  })
})

describe('rules — only what needs attention', () => {
  it('stays silent for today’s real statewide feed and a quiet forecast', () => {
    const events = parseVicEmergency(JSON.parse(fixture('vicemergency-2026-10-07.json')))
    const outlook = parseCfaForecast(fixture('cfa-forecast-2026-10-07.xml'), 'Central')
    const r = evaluate({ events, outlook, state: empty, cfg, today: '2026-10-07', tomorrow: '2026-10-08' })
    expect(r.alerts).toEqual([])
  })

  it('alerts on Watch and Act or Emergency Warning covering the property; not on Advice; not when it covers elsewhere', () => {
    const r = run(empty, {
      events: [
        warning('a', 'Advice', square(HOME.lat, HOME.lon, 0.1)),
        warning('b', 'Watch and Act', square(HOME.lat, HOME.lon, 0.1)),
        warning('c', 'Emergency Warning', square(HOME.lat + 0.5, HOME.lon, 0.1))
      ]
    })
    expect(r.alerts.map((a) => a.key)).toEqual(['warning:b'])
    expect(r.alerts[0].text).toMatch(/Watch and Act — Bushfire, Wandin \(covers your property\)\. Advice: Leave Now/)
  })

  it('alerts on uncontrolled vegetation fires within 5 km and any fire within 1 km', () => {
    const r = run(empty, {
      events: [
        fire('grass', 'Grass', 'Going', 4),
        fire('far', 'Bushfire', 'Going', 8),
        fire('safe', 'Bushfire', 'Safe', 2),
        fire('car', 'Other', 'Responding', 3),
        fire('house', 'Structure', 'Responding', 0.5)
      ]
    })
    expect(r.alerts.map((a) => a.key).sort()).toEqual(['fire:grass', 'fire:house'])
  })

  it('alerts on a fire ban or an Extreme/Catastrophic rating for today or tomorrow, once', () => {
    const outlook = [
      { date: '2026-01-10', totalFireBan: false, rating: 'High' },
      { date: '2026-01-11', totalFireBan: true, rating: 'Extreme' },
      { date: '2026-01-12', totalFireBan: true, rating: 'Catastrophic' }
    ]
    const first = run(empty, { outlook })
    expect(first.alerts.map((a) => a.key).sort()).toEqual(['fdr:2026-01-11', 'tfb:2026-01-11'])
    expect(run(first.state, { outlook }).alerts).toEqual([])
  })

  it('says once when an alerted item escalates, and once when it eases or ends; never repeats', () => {
    const box = square(HOME.lat, HOME.lon, 0.1)
    const s1 = run(empty, { events: [warning('w', 'Watch and Act', box), fire('f', 'Grass', 'Going', 2)] })
    expect(s1.alerts.map((a) => a.kind)).toEqual(['new', 'new'])

    const s2 = run(s1.state, { events: [warning('w', 'Watch and Act', box), fire('f', 'Grass', 'Going', 2)] })
    expect(s2.alerts).toEqual([])

    const s3 = run(s2.state, {
      events: [warning('w', 'Emergency Warning', box), fire('f', 'Grass', 'Under Control', 2)]
    })
    expect(s3.alerts.map((a) => `${a.kind}:${a.key}`)).toEqual(['escalated:warning:w', 'eased:fire:f'])

    const s4 = run(s3.state, { events: [warning('w', 'Advice', box)] })
    expect(s4.alerts.map((a) => `${a.kind}:${a.key}`)).toEqual(['eased:warning:w'])
    expect(s4.state.notified).toEqual({})
  })

  it('keeps items as they are when a feed was not read this round', () => {
    const s1 = run(empty, { events: [fire('f', 'Grass', 'Going', 2)] })
    const s2 = run(s1.state, {})
    expect(s2.alerts).toEqual([])
    expect(Object.keys(s2.state.notified)).toEqual(['fire:f'])
  })

  it('formats one message, escalations first', () => {
    const text = formatAlerts(
      [
        { key: 'a', kind: 'eased', text: 'Fire at X ended.' },
        { key: 'b', kind: 'escalated', text: 'Emergency Warning — Bushfire.' }
      ],
      'the farm'
    )
    expect(text.split('\n').slice(0, 3)).toEqual([
      '[Hazard alert — the farm] VicEmergency / CFA:',
      '- ESCALATED: Emergency Warning — Bushfire.',
      '- Eased or ended: Fire at X ended.'
    ])
  })
})

describe('service', () => {
  let dir: string
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-hazards-'))))
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const config: HazardsConfig = {
    enabled: true,
    label: 'the farm',
    lat: HOME.lat,
    lon: HOME.lon,
    fireDistrict: 'Central',
    fireRadiusKm: 5,
    anyFireRadiusKm: 1,
    pollMs: 90_000,
    forecastPollMs: 1_800_000,
    timeZone: 'Australia/Melbourne'
  }
  const T0 = Date.parse('2026-01-10T03:00:00Z') // 14:00 in Melbourne
  const geojson = (events: object[]) => JSON.stringify({ features: events })
  const fireFeature = {
    properties: {
      feedType: 'incident',
      id: 'f1',
      category1: 'Fire',
      category2: 'Bushfire',
      status: 'Going',
      location: 'Wandin'
    },
    geometry: point(HOME.lat + 2 * KM, HOME.lon)
  }
  const forecast = (ban: 'YES' | 'NO', rating: string) =>
    `<rss><item><title>Saturday, 10 January 2026</title><description>Central: ${ban} - X&lt;br&gt;Fire Danger Ratings&lt;br&gt;Central: ${rating}</description></item></rss>`

  function setup(feeds: { events?: string | Error; forecast?: string | Error }) {
    let t = T0
    const sent: string[] = []
    const fakeFetch = (async (url: string) => {
      const body = url === VICEMERGENCY_URL ? feeds.events : url === CFA_FORECAST_URL ? feeds.forecast : undefined
      if (body instanceof Error || body === undefined) return new Response('down', { status: 503 })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const svc = createHazardService({
      dataDir: dir,
      config: () => config,
      notify: async (m) => void sent.push(m),
      fetch: fakeFetch,
      now: () => t
    })
    return { svc, sent, advance: (ms: number) => (t += ms) }
  }

  it('sends one message for a nearby fire, never repeats it, and remembers across a restart', async () => {
    const feeds = { events: geojson([fireFeature]), forecast: forecast('NO', 'MODERATE') }
    const a = setup(feeds)
    await a.svc.poll()
    await a.svc.poll()
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]).toContain('Bushfire fire at Wandin, 2.0 km away — Going.')

    const b = setup(feeds) // restart: state from disk
    await b.svc.poll()
    expect(b.sent).toEqual([])
  })

  it('stays silent on a quiet day, even with the event feed down for an hour', async () => {
    const s = setup({ events: new Error('down'), forecast: forecast('NO', 'MODERATE') })
    await s.svc.poll()
    s.advance(60 * 60_000)
    await s.svc.poll()
    expect(s.sent).toEqual([])
  })

  it('warns once when the event feed stays down for 30 min on a fire-ban day', async () => {
    const s = setup({ events: new Error('down'), forecast: forecast('YES', 'EXTREME') })
    await s.svc.poll()
    expect(s.sent).toHaveLength(1) // the fire ban itself
    s.advance(31 * 60_000)
    await s.svc.poll()
    s.advance(10 * 60_000)
    await s.svc.poll()
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1]).toMatch(/VicEmergency feed has been unreadable for 31 min on a Total Fire Ban day/)
  })

  it('retries a message that failed to send', async () => {
    let fail = true
    const feeds = { events: geojson([fireFeature]), forecast: forecast('NO', 'MODERATE') }
    const sent: string[] = []
    const fakeFetch = (async (url: string) =>
      new Response(url === VICEMERGENCY_URL ? feeds.events : feeds.forecast, {
        status: 200
      })) as unknown as typeof fetch
    const svc = createHazardService({
      dataDir: dir,
      config: () => config,
      fetch: fakeFetch,
      now: () => T0,
      notify: async (m) => {
        if (fail) throw new Error('presence thread busy')
        sent.push(m)
      }
    })
    await expect(svc.poll()).rejects.toThrow('presence thread busy')
    fail = false
    await svc.poll()
    expect(sent).toHaveLength(1)
  })

  it('works out today in the property’s time zone', () => {
    expect(localDate(Date.parse('2026-01-10T14:30:00Z'), 'Australia/Melbourne')).toBe('2026-01-11')
  })
})
