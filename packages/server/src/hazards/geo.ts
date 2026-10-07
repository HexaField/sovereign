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

/** True when the geometry has an area (a polygon), not only points or lines. */
export function hasArea(g: Geometry | null | undefined): boolean {
  if (!g) return false
  if (g.type === 'GeometryCollection') return (g.geometries ?? []).some(hasArea)
  return g.type === 'Polygon' || g.type === 'MultiPolygon'
}

/** Every point, line and ring of the geometry as a list of position paths. */
function paths(g: Geometry): Position[][] {
  if (g.type === 'GeometryCollection') return (g.geometries ?? []).flatMap(paths)
  const walk = (c: unknown): Position[][] => {
    if (!Array.isArray(c) || !c.length) return []
    if (typeof c[0] === 'number') return [[c as Position]]
    if (Array.isArray(c[0]) && typeof c[0][0] === 'number') return [c as Position[]]
    return c.flatMap(walk)
  }
  return walk(g.coordinates)
}

/** Distance from the point to the nearest point, edge or ring of the geometry (0 when inside). */
export function distanceKm(g: Geometry | null | undefined, p: LatLon): number {
  if (!g) return Infinity
  if (containsPoint(g, p)) return 0
  // Local flat projection around p: accurate to well under 1% at the radii used here.
  const kx = (Math.PI / 180) * R_KM * Math.cos(p.lat * (Math.PI / 180))
  const ky = (Math.PI / 180) * R_KM
  const xy = ([lon, lat]: Position) => [(lon - p.lon) * kx, (lat - p.lat) * ky]
  let best = Infinity
  for (const path of paths(g)) {
    if (path.length === 1) best = Math.min(best, haversineKm(p, { lat: path[0][1], lon: path[0][0] }))
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = xy(path[i - 1])
      const [bx, by] = xy(path[i])
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}
