// Geometry for hazard feeds: GeoJSON positions are [lon, lat].

export interface LatLon {
  lat: number
  lon: number
}

type Position = number[]
export interface Geometry {
  type: string
  coordinates?: unknown
  geometries?: Geometry[]
}

const R_KM = 6371

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Ray casting on one ring of [lon, lat] positions. */
function inRing(p: LatLon, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Inside the outer ring and outside every hole. */
function inPolygon(p: LatLon, rings: Position[][]): boolean {
  return rings.length > 0 && inRing(p, rings[0]) && !rings.slice(1).some((hole) => inRing(p, hole))
}

/** True when the point lies inside any polygon of the geometry. */
export function containsPoint(g: Geometry | null | undefined, p: LatLon): boolean {
  if (!g) return false
  if (g.type === 'Polygon') return inPolygon(p, g.coordinates as Position[][])
  if (g.type === 'MultiPolygon') return (g.coordinates as Position[][][]).some((poly) => inPolygon(p, poly))
  if (g.type === 'GeometryCollection') return (g.geometries ?? []).some((sub) => containsPoint(sub, p))
  return false
}

/** Every position in the geometry, flattened. */
function positions(g: Geometry): Position[] {
  if (g.type === 'GeometryCollection') return (g.geometries ?? []).flatMap(positions)
  const walk = (c: unknown): Position[] =>
    Array.isArray(c) && typeof c[0] === 'number' ? [c as Position] : Array.isArray(c) ? c.flatMap(walk) : []
  return walk(g.coordinates)
}

/** Distance from the point to the nearest position of the geometry (0 when inside). */
export function distanceKm(g: Geometry | null | undefined, p: LatLon): number {
  if (!g) return Infinity
  if (containsPoint(g, p)) return 0
  let best = Infinity
  for (const [lon, lat] of positions(g)) best = Math.min(best, haversineKm(p, { lat, lon }))
  return best
}
