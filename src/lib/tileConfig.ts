export interface TileSource {
  id: string
  label: string
  type: 'vector' | 'raster'
  styleUrl?: string        // for vector sources (MapLibre style JSON URL)
  tileUrl?: string         // for raster sources
  attribution: string
  tileSize?: number
  thumbColor: string       // fallback background colour
  icon: string             // SVG string shown in the style selector thumbnail
}

export const BUILT_IN_SOURCES: TileSource[] = [
  {
    id: 'stadia-osm',
    label: 'Map',
    type: 'vector',
    styleUrl: 'https://tiles.stadiamaps.com/styles/osm_bright.json',
    attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    thumbColor: '#e8e0d0',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#f2ece3"/>
  <rect x="4"  y="4"  width="20" height="20" fill="#e4dbd0"/>
  <rect x="40" y="4"  width="20" height="14" fill="#e4dbd0"/>
  <rect x="40" y="42" width="20" height="18" fill="#e4dbd0"/>
  <rect x="4"  y="40" width="20" height="20" fill="#cde8b4"/>
  <rect x="0"  y="27" width="64" height="10" fill="#ffffff"/>
  <rect x="27" y="0"  width="10" height="64" fill="#ffffff"/>
  <rect x="0"  y="27" width="64" height="10" stroke="#d4ccc0" stroke-width="0.5" fill="none"/>
  <rect x="27" y="0"  width="10" height="64" stroke="#d4ccc0" stroke-width="0.5" fill="none"/>
  <rect x="4"  y="20" width="20" height="4"  fill="#f0ece4"/>
  <rect x="44" y="20" width="16" height="3"  fill="#f0ece4"/>
</svg>`,
  },
  {
    id: 'esri-satellite',
    label: 'Satellite',
    type: 'raster',
    tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
    thumbColor: '#1e3018',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#1a2c14"/>
  <rect x="0"  y="0"  width="24" height="20" fill="#243e1a"/>
  <rect x="24" y="0"  width="22" height="14" fill="#304e22"/>
  <rect x="46" y="0"  width="18" height="22" fill="#1e3418"/>
  <rect x="0"  y="20" width="16" height="22" fill="#2c4820"/>
  <rect x="16" y="14" width="30" height="20" fill="#263c1c"/>
  <rect x="46" y="22" width="18" height="18" fill="#18280e"/>
  <rect x="0"  y="42" width="28" height="22" fill="#2a4218"/>
  <rect x="28" y="34" width="22" height="30" fill="#203614"/>
  <rect x="50" y="40" width="14" height="24" fill="#304820"/>
  <line x1="0"  y1="34" x2="64" y2="34" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
  <line x1="40" y1="0"  x2="40" y2="64" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
</svg>`,
  },
  {
    id: 'opentopomap',
    label: 'Terrain',
    type: 'raster',
    tileUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    tileSize: 256,
    thumbColor: '#e0ecc8',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#eaf2dc"/>
  <path d="M0,56 Q10,32 28,30 Q46,28 64,18 L64,64Z" fill="#cfe0a8"/>
  <path d="M0,60 Q10,38 28,36 Q46,34 64,24" stroke="#b0c478" stroke-width="1.5" fill="none"/>
  <path d="M0,52 Q10,30 28,28 Q46,26 64,16" stroke="#a8bc70" stroke-width="1.5" fill="none"/>
  <path d="M0,44 Q12,24 28,22 Q44,20 64,10" stroke="#a0b468" stroke-width="1.2" fill="none"/>
  <path d="M2,36 Q14,16 28,14 Q42,12 62,4"  stroke="#98ac60" stroke-width="1"   fill="none"/>
  <path d="M8,28 Q20,10 30,8  Q40,6  56,2"  stroke="#90a458" stroke-width="0.8" fill="none"/>
  <polygon points="30,2 40,18 20,18" fill="#c8aa7a" stroke="#a08848" stroke-width="0.8"/>
</svg>`,
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
