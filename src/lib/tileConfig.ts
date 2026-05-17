import { api, isReady } from './dataApi';

export interface LineStyle {
    outerColor: string;
    outerWidth: number;
    outerOpacity: number;
    innerColor: string;
    innerWidth: number;
}

export interface TileSource {
    id: string;
    label: string;
    // vector: external MapLibre style URL (Stadia, etc.)
    // raster: XYZ tile URL template
    // pmtiles-drive: Drive-hosted PMTiles file used as a base map style
    // pmtiles-overlay: Drive-hosted PMTiles rendered as a vector overlay on top of the base map
    type: 'vector' | 'raster' | 'pmtiles-drive' | 'pmtiles-overlay';
    styleUrl?: string;
    tileUrl?: string;
    tileSize?: number;
    fileId?: string; // Drive file ID — set directly for pmtiles-drive; resolved at startup for pmtiles-overlay
    filename?: string; // Drive filename to look up at startup (pmtiles-overlay only)
    sourceLayer?: string; // layer name inside the PMTiles (pmtiles-overlay only)
    overlayColor?: string; // single-color line colour (pmtiles-overlay without lineStyle)
    overlayWidth?: number; // single-color line width in pixels (pmtiles-overlay without lineStyle)
    overlayOpacity?: number; // single-color opacity 0–1 (pmtiles-overlay without lineStyle)
    overlayMinZoom?: number; // hide below this zoom level when set (pmtiles-overlay only)
    overlayFilter?: string; // value of 'row_type' property to filter features (pmtiles-overlay only)
    lineStyle?: LineStyle; // two-color cased line; when present, overrides overlayColor/Width/Opacity
    minAccessLevel?: number; // 1-3: minimum ROW access slider position at which this overlay is shown
    attribution: string;
    thumbColor: string;
    icon: string; // SVG string shown in the style selector thumbnail — not used for pmtiles-overlay
}

export async function loadTileSources(token: string | null): Promise<TileSource[]> {
    if (!isReady(token)) return [];
    const rootId = await api.getRootFolderId(token);
    const file = await api.findFileByName(token, 'tile-sources.json', rootId);
    if (!file) throw new Error('tile-sources.json not found in data root');
    const text = await api.readFileText(token, file.id);
    const sources = JSON.parse(text) as TileSource[];
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error('tile-sources.json is empty or not an array');
    }

    // Resolve Drive filenames to file IDs for pmtiles-overlay entries.
    // Multiple overlays can share the same filename (e.g. row.pmtiles split by row_type);
    // each unique filename is looked up once. Overlays whose file isn't on Drive yet are silently dropped.
    const filenames = [
        ...new Set(sources.filter(s => s.type === 'pmtiles-overlay' && !s.fileId && s.filename).map(s => s.filename!)),
    ];
    const fileIdByName: Record<string, string> = {};
    await Promise.all(
        filenames.map(async name => {
            const found = await api.findFileByName(token, name, rootId);
            if (found) fileIdByName[name] = found.id;
        }),
    );

    return sources
        .map(s => {
            if (s.type !== 'pmtiles-overlay' || s.fileId) return s;
            if (!s.filename) return null;
            const id = fileIdByName[s.filename];
            return id ? { ...s, fileId: id } : null;
        })
        .filter((s): s is TileSource => s !== null);
}

export function buildRasterStyle(source: TileSource): object {
    const tileUrl = source.tileUrl!;
    const tiles = tileUrl.includes('{s}') ? ['a', 'b', 'c'].map(s => tileUrl.replace('{s}', s)) : [tileUrl];

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
    };
}
