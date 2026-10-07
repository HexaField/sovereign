import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { containsPoint, distanceKm, haversineKm } from './geo.js'
import { parseCfaForecast, parseVicEmergency, CFA_FORECAST_URL, VICEMERGENCY_URL, type HazardEvent } from './feeds.js'
import { EASE_AFTER, evaluate, formatAlerts, warningRank, type HazardState } from './rules.js'
import { createHazardService, localDate, nextDate, type HazardsConfig } from './service.js'

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
  feed: 'cop-cap',
  location: 'Wandin',
  updated: '2026-01-10T12:00:00+11:00',
  geometry: { type: 'GeometryCollection', geometries: [point(HOME.lat, HOME.lon), geometry] } as never,
  ...extra
})
const fire = (
  id: string,
  type: string,
  status: string,
  kmAway: number,
  extra: Partial<HazardEvent> = {}
): HazardEvent => ({
  id,
  kind: 'incident',
  category: 'Fire',
  type,
  status,
  feed: 'cfa-incident',
  location: 'Somewhere Rd',
  updated: '2026-01-10T12:00:00+11:00',
  geometry: point(HOME.lat + kmAway * KM, HOME.lon) as never,
  ...extra
})
/** Runs the same feed until an absent item has eased (EASE_AFTER reads). */
const settle = (state: HazardState, events: HazardEvent[]) => {
  const alerts = []
  for (let i = 0; i < EASE_AFTER; i++) {
    const r = run(state, { events })
    alerts.push(...r.alerts)
    state = r.state
  }
  return { alerts, state }
}

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

  it('rejects a feed with the wrong shape, and a district the forecast does not name', () => {
    expect(() => parseVicEmergency({})).toThrow()
    expect(() => parseCfaForecast('<html/>', 'Central')).toThrow()
    expect(() => parseCfaForecast(fixture('cfa-forecast-2026-10-07.xml'), 'Centrall')).toThrow(/no lines for district/)
  })

  it('keys NSW RFS incidents by sourceId: their id changes with every update', () => {
    const rfs = (id: string) => ({
      properties: {
        feedType: 'incident',
        sourceOrg: 'NSW/RFS',
        sourceId: '640445',
        id,
        category1: 'Fire',
        category2: 'Grass Fire',
        status: 'Not Yet Controlled'
      },
      geometry: point(HOME.lat, HOME.lon)
    })
    const a = parseVicEmergency({ features: [rfs('2026-01-09T05:05:00.0000000:640445')] })
    const b = parseVicEmergency({ features: [rfs('2026-01-09T09:27:00.0000000:640445')] })
    expect(a[0].id).toBe('NSW/RFS:640445')
    expect(b[0].id).toBe(a[0].id)
    // VIC ids stay as published (ESTA:… survives a VIC/ESTA → VIC/CFA hand-over).
    expect(
      parseVicEmergency({
        features: [{ properties: { feedType: 'incident', id: 'ESTA:260104998', sourceId: '255594' } }]
      })[0].id
    ).toBe('ESTA:260104998')
  })

  it('reads a double-encoded description with &nbsp; and numeric entities', () => {
    const xml = `<rss><item><title>Saturday, 10 January 2026</title><description>&amp;lt;p&amp;gt;Central:&amp;nbsp;YES - TOTAL FIRE BAN IN FORCE&amp;lt;br&amp;gt;&amp;#70;ire Danger Ratings&amp;lt;br&amp;gt;Central: CATASTROPHIC&amp;lt;/p&amp;gt;</description></item></rss>`
    expect(parseCfaForecast(xml, 'Central')).toEqual([
      { date: '2026-01-10', totalFireBan: true, rating: 'Catastrophic' }
    ])
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
    expect(r.alerts.map((a) => a.key)).toEqual(['warning:fire'])
    expect(r.alerts[0].text).toMatch(/Watch and Act — Bushfire, Wandin \(covers your property\)\. Advice: Leave Now/)
  })

  it('reads every warning level wording seen or published; unknown levels lean towards alarm', () => {
    expect(warningRank('Emergency Warning')).toBe(3)
    expect(warningRank('Emergency Warning - Evacuate Now')).toBe(3)
    expect(warningRank('Evacuate')).toBe(3)
    expect(warningRank('Watch and Act')).toBe(2)
    expect(warningRank('Watch & Act')).toBe(2)
    expect(warningRank('Moderate Flood Warning')).toBe(2)
    expect(warningRank('Advice')).toBe(1)
    expect(warningRank('Community Update')).toBe(1)
    expect(warningRank('Final Minor Flood Warning')).toBe(1)
    expect(warningRank('Something New')).toBe(2)
    expect(warningRank('Something New', 'Take Shelter Now')).toBe(3)
  })

  it('treats a reissued warning (new id each time) as the same warning: silent at the same level, escalated above it', () => {
    // Real feed, Jan 2026: one warning area went 39129 (Watch and Act) → 39161 → 39201 (Emergency Warning).
    const box = square(HOME.lat, HOME.lon, 0.1)
    const s1 = run(empty, { events: [warning('39129', 'Watch and Act', box)] })
    expect(s1.alerts.map((a) => a.kind)).toEqual(['new'])
    const s2 = settle(s1.state, [warning('39150', 'Watch and Act', box)])
    expect(s2.alerts).toEqual([])
    const s3 = settle(s2.state, [warning('39161', 'Emergency Warning', box, { action: 'Take Shelter Now' })])
    expect(s3.alerts.map((a) => `${a.kind}:${a.key}`)).toEqual(['escalated:warning:fire'])
    expect(settle(s3.state, [warning('39201', 'Emergency Warning', box)]).alerts).toEqual([])
  })

  it('alerts on a warning without a published area when its point is within the fire radius', () => {
    const pointOnly = (km: number) => ({
      ...warning('p', 'Watch and Act', square(0, 0, 0)),
      geometry: point(HOME.lat + km * KM, HOME.lon) as never
    })
    expect(run(empty, { events: [pointOnly(3)] }).alerts[0].text).toMatch(/3\.0 km away, no warning area published/)
    expect(run(empty, { events: [pointOnly(8)] }).alerts).toEqual([])
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

  it('reads the real fire statuses and categories (archived feeds, Mar 2025 and Jan 2026)', () => {
    const burnt = {
      type: 'GeometryCollection',
      geometries: [point(HOME.lat + 4 * KM, HOME.lon), square(HOME.lat + 4 * KM, HOME.lon, 0.002)]
    }
    const r = run(empty, {
      events: [
        fire('nyuc', 'Bushfire', 'Not Yet Under Control', 3),
        fire('nyc', 'Grass Fire', 'Not Yet Controlled', 3),
        fire('contained', 'Bushfire', 'Contained', 3),
        fire('patrolled', 'Bushfire', 'Patrolled', 3),
        // FRV files some grass fires under category1 "Other".
        fire('scrub', 'Grass and Scrub', 'Responding', 3, { category: 'Other' }),
        // NSW RFS: category2 "Fire", but a mapped burnt area makes it a vegetation fire.
        fire('mapped', 'Fire', 'Not Yet Controlled', 0, { geometry: burnt as never }),
        // District-wide pseudo-incidents: the CFA outlook covers them; never a "fire at 0 km".
        fire('fdr', 'Fire Danger Rating', 'CATASTROPHIC', 0, {
          feed: 'cfa-fdr',
          geometry: square(HOME.lat, HOME.lon, 1) as never
        }),
        fire('tfb', 'Total Fire Ban', 'TOTAL FIRE BAN IN FORCE', 0, {
          feed: 'cfa-fdrtfb',
          geometry: square(HOME.lat, HOME.lon, 1) as never
        })
      ]
    })
    expect(r.alerts.map((a) => a.key).sort()).toEqual([
      'fire:contained',
      'fire:mapped',
      'fire:nyc',
      'fire:nyuc',
      'fire:scrub'
    ])
    expect(r.alerts.find((a) => a.key === 'fire:scrub')!.text).toMatch(/^Grass and Scrub fire at/)
  })

  it('measures a fire area by its nearest edge, not its nearest corner', () => {
    // A 20 km wide burnt area whose southern edge runs 1 km north of the property.
    const half = 10 / 111
    const area = {
      type: 'Polygon',
      coordinates: [
        [
          [HOME.lon - half, HOME.lat + KM],
          [HOME.lon + half, HOME.lat + KM],
          [HOME.lon + half, HOME.lat + 5 * KM],
          [HOME.lon - half, HOME.lat + 5 * KM],
          [HOME.lon - half, HOME.lat + KM]
        ]
      ]
    }
    expect(distanceKm(area as never, HOME)).toBeCloseTo(1, 1)
    expect(
      run(empty, { events: [fire('big', 'Bushfire', 'Going', 0, { geometry: area as never })] }).alerts
    ).toHaveLength(1)
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

    const s3 = settle(s2.state, [warning('w', 'Emergency Warning', box), fire('f', 'Grass', 'Under Control', 2)])
    expect(s3.alerts.map((a) => `${a.kind}:${a.key}`)).toEqual(['escalated:warning:fire', 'eased:fire:f'])

    const s4 = settle(s3.state, [warning('w', 'Advice', box)])
    expect(s4.alerts.map((a) => `${a.kind}:${a.key}`)).toEqual(['eased:warning:fire'])
    expect(s4.state.notified).toEqual({})
  })

  it('waits EASE_AFTER reads before "eased", so a brief gap in the feed says nothing', () => {
    const f = fire('f', 'Grass', 'Going', 2)
    let state = run(empty, { events: [f] }).state
    for (let i = 1; i < EASE_AFTER; i++) {
      const r = run(state, { events: [] })
      expect(r.alerts).toEqual([])
      state = r.state
    }
    const back = run(state, { events: [f] })
    expect(back.alerts).toEqual([])
    expect(back.state.notified['fire:f'].missed).toBeUndefined()
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
  const forecast = (ban: 'YES' | 'NO', rating: string, title = 'Saturday, 10 January 2026') =>
    `<rss><item><title>${title}</title><description>Central: ${ban} - X&lt;br&gt;Fire Danger Ratings&lt;br&gt;Central: ${rating}</description></item></rss>`

  function setup(
    feeds: { events?: string | Error; forecast?: string | Error },
    opts: { t0?: number; cfg?: HazardsConfig; notify?: (m: string) => Promise<void> } = {}
  ) {
    let t = opts.t0 ?? T0
    const sent: string[] = []
    const fetched: string[] = []
    const fakeFetch = (async (url: string) => {
      fetched.push(url)
      const body = url === VICEMERGENCY_URL ? feeds.events : url === CFA_FORECAST_URL ? feeds.forecast : undefined
      if (body instanceof Error || body === undefined) return new Response('down', { status: 503 })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const svc = createHazardService({
      dataDir: dir,
      config: () => opts.cfg ?? config,
      notify: opts.notify ?? (async (m) => void sent.push(m)),
      fetch: fakeFetch,
      now: () => t
    })
    return { svc, sent, fetched, advance: (ms: number) => (t += ms) }
  }

  it('sends one message for a nearby fire, never repeats it, and remembers across a restart', async () => {
    const feeds = { events: geojson([fireFeature]), forecast: forecast('NO', 'MODERATE') }
    const a = setup(feeds)
    await a.svc.poll()
    await a.svc.poll()
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]).toContain('Bushfire at Wandin, 2.0 km away — Going.')

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

  it('does not resend a delivered alert when a later message in the same round fails', async () => {
    let calls = 0
    const s = setup(
      { events: new Error('down'), forecast: forecast('YES', 'EXTREME') },
      {
        notify: async () => {
          if (++calls === 2) throw new Error('presence thread busy') // the "feed down" message
        }
      }
    )
    await s.svc.poll() // fire-ban alert delivered
    s.advance(31 * 60_000)
    await expect(s.svc.poll()).rejects.toThrow('presence thread busy')
    s.advance(60_000)
    await s.svc.poll() // retries only the "feed down" message
    expect(calls).toBe(3)
  })

  it('reads nothing while disabled and starts watching once enabled, without a restart', async () => {
    const cfg = { ...config, enabled: false }
    const s = setup({ events: geojson([fireFeature]), forecast: forecast('NO', 'MODERATE') }, { cfg })
    await s.svc.poll()
    expect(s.fetched).toEqual([])
    cfg.enabled = true
    await s.svc.poll()
    expect(s.sent).toHaveLength(1)
  })

  it('works out today in the property’s time zone', () => {
    expect(localDate(Date.parse('2026-01-10T14:30:00Z'), 'Australia/Melbourne')).toBe('2026-01-11')
    expect(nextDate('2026-12-31')).toBe('2027-01-01')
  })

  it('sees tomorrow’s fire ban just after midnight on the 25-hour day DST ends', async () => {
    // 00:30 AEDT, Sun 5 Apr 2026; now + 24 h is still 5 Apr (23:30 AEST).
    const t0 = Date.parse('2026-04-04T13:30:00Z')
    const s = setup({ events: geojson([]), forecast: forecast('YES', 'HIGH', 'Monday, 06 April 2026') }, { t0 })
    await s.svc.poll()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('Tomorrow (2026-04-06) is a day of Total Fire Ban.')
  })
})
