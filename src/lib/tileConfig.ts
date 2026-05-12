import { api, isReady } from './dataApi'

export interface TileSource {
  id: string
  label: string
  type: 'vector' | 'raster'
  styleUrl?: string
  tileUrl?: string
  attribution: string
  tileSize?: number
  thumbColor: string
  icon: string             // SVG string shown in the style selector thumbnail
}

export async function loadTileSources(token: string | null): Promise<TileSource[]> {
  if (!isReady(token)) return []
  const rootId = await api.getRootFolderId(token)
  const file = await api.findFileByName(token, 'tile-sources.json', rootId)
  if (!file) throw new Error('tile-sources.json not found in data root')
  const text = await api.readFileText(token, file.id)
  const sources = JSON.parse(text) as TileSource[]
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('tile-sources.json is empty or not an array')
  }
  return sources
}

export function buildRasterStyle(source: TileSource): object {
  const tileUrl = source.tileUrl!
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
