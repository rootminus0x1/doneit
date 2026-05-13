import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson'

interface CountryFeature {
  geometry: Polygon | MultiPolygon
  // Natural Earth property names used verbatim from the source file
  properties: Record<string, string>
  // pre-computed bbox for fast rejection
  west: number; south: number; east: number; north: number
}

let cache: CountryFeature[] | null = null

function geomBbox(g: Polygon | MultiPolygon): [number, number, number, number] {
  const rings: number[][][] = g.type === 'Polygon'
    ? g.coordinates as number[][][]
    : (g.coordinates as number[][][][]).flat()
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x
      if (x > east) east = x
      if (y < south) south = y
      if (y > north) north = y
    }
  }
  return [west, south, east, north]
}

async function loadCountries(): Promise<CountryFeature[]> {
  if (cache) return cache
  const url = import.meta.env.BASE_URL + 'ne_110m_countries.geojson'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load country data: HTTP ${res.status}`)
  const fc = await res.json() as FeatureCollection<Polygon | MultiPolygon>
  cache = fc.features.map(f => {
    const [west, south, east, north] = geomBbox(f.geometry)
    return {
      geometry: f.geometry,
      properties: f.properties as Record<string, string>,
      west, south, east, north,
    }
  })
  return cache
}

function pointInRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygon(lng: number, lat: number, rings: number[][][]): boolean {
  if (!pointInRing(lng, lat, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i])) return false  // inside a hole
  }
  return true
}

export async function lookupCountry(lng: number, lat: number): Promise<string | null> {
  const countries = await loadCountries()
  for (const { geometry, properties, west, south, east, north } of countries) {
    if (lng < west || lng > east || lat < south || lat > north) continue
    let hit = false
    if (geometry.type === 'Polygon') {
      hit = pointInPolygon(lng, lat, geometry.coordinates as number[][][])
    } else {
      for (const poly of geometry.coordinates as number[][][][]) {
        if (pointInPolygon(lng, lat, poly as number[][][])) { hit = true; break }
      }
    }
    if (hit) {
      const { name, geonunit, admin } = properties
      return (geonunit && geonunit !== admin ? geonunit : name) || null
    }
  }
  return null  // open water or not in dataset
}
