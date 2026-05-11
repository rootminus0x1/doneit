export interface TileSource {
  id: string
  label: string
  type: 'vector' | 'raster'
  styleUrl?: string        // for vector sources (MapLibre style JSON URL)
  tileUrl?: string         // for raster sources
  attribution: string
  tileSize?: number
}

export const BUILT_IN_SOURCES: TileSource[] = [
  {
    id: 'stadia-osm',
    label: 'OpenStreetMap',
    type: 'vector',
    styleUrl: 'https://tiles.stadiamaps.com/styles/osm_bright.json',
    attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  {
    id: 'esri-satellite',
    label: 'Satellite',
    type: 'raster',
    tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
  },
  {
    id: 'opentopomap',
    label: 'Topo Map',
    type: 'raster',
    tileUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    tileSize: 256,
  },
]

export function buildRasterStyle(source: TileSource): object {
  const tileUrl = source.tileUrl!
  // OpenTopoMap uses {s} subdomain placeholder — expand to a/b/c
  const tiles = tileUrl.includes('{s}')
    ? ['a', 'b', 'c'].map(s => tileUrl.replace('{s}', s))
    : [tileUrl]

  return {
    version: 8,
    sources: {
      'raster-tiles': {
        type: 'raster',
        tiles,
        tileSize: source.tileSize ?? 256,
        attribution: source.attribution,
      },
    },
    layers: [{ id: 'raster-layer', type: 'raster', source: 'raster-tiles' }],
  }
}
