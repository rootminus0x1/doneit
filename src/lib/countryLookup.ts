import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson'

interface CountryFeature {
  geometry: Polygon | MultiPolygon
  // Natural Earth property names used verbatim from the source file
  properties: Record<string, string>
}

let cache: CountryFeature[] | null = null

async function loadCountries(): Promise<CountryFeature[]> {
  if (cache) return cache
  const url = import.meta.env.BASE_URL + 'ne_110m_countries.geojson'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load country data: HTTP ${res.status}`)
  const fc = await res.json() as FeatureCollection<Polygon | MultiPolygon>
  cache = fc.features as unknown as CountryFeature[]
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
  for (const { geometry, properties } of countries) {
    let hit = false
    if (geometry.type === 'Polygon') {
      hit = pointInPolygon(lng, lat, geometry.coordinates as number[][][])
    } else {
      for (const poly of geometry.coordinates as number[][][][]) {
        if (pointInPolygon(lng, lat, poly as number[][][])) { hit = true; break }
      }
    }
    if (hit) return properties.ADMIN || properties.NAME || null
  }
  return null  // open water or not in 110m dataset
}
