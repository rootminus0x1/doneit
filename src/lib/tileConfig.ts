import { api, isReady } from './dataApi';

export interface TileSource {
    id: string;
    label: string;
    // vector: external MapLibre style URL (Stadia, etc.)
    // raster: XYZ tile URL template
    // pmtiles-drive: Drive-hosted PMTiles file used as a base map style
    type: 'vector' | 'raster' | 'pmtiles-drive';
    styleUrl?: string;  // vector
    tileUrl?: string;   // raster
    tileSize?: number;  // raster
    fileId?: string;    // pmtiles-drive: required
    attribution: string;
    thumbColor: string;
    icon: string;
}

const KNOWN_TYPES = ['vector', 'raster', 'pmtiles-drive'] as const;

function validateSource(raw: unknown, index: number): TileSource {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error(`tile-sources.json entry ${index} is not an object`);
    const e = raw as Record<string, unknown>;
    const at = `tile-sources.json entry ${index} (id: ${JSON.stringify(e.id)})`;

    if (typeof e.id !== 'string' || !e.id)
        throw new Error(`${at}: missing or empty "id"`);
    if (!KNOWN_TYPES.includes(e.type as (typeof KNOWN_TYPES)[number]))
        throw new Error(`${at}: unknown type "${e.type}". Valid types: ${KNOWN_TYPES.join(', ')}`);

    if (e.type === 'vector' && !e.styleUrl)
        throw new Error(`${at}: "vector" type requires "styleUrl"`);
    if (e.type === 'raster' && !e.tileUrl)
        throw new Error(`${at}: "raster" type requires "tileUrl"`);
    if (e.type === 'pmtiles-drive' && !e.fileId)
        throw new Error(`${at}: "pmtiles-drive" type requires "fileId"`);

    return raw as TileSource;
}

export async function loadTileSources(token: string | null): Promise<TileSource[]> {
    if (!isReady(token)) return [];
    const rootId = await api.getRootFolderId(token);

    const rootFolders = await api.listFolders(token, rootId);
    const configFolder = rootFolders.find(f => f.name === 'config');
    if (!configFolder) throw new Error('config/ folder not found in Drive');
    const file = await api.findFileByName(token, 'tile-sources.json', configFolder.id);
    if (!file) throw new Error('tile-sources.json not found in config/ folder');
    const text = await api.readFileText(token, file.id);
    const raw = JSON.parse(text);
    if (!Array.isArray(raw) || raw.length === 0)
        throw new Error('tile-sources.json is empty or not an array');

    return raw.map((entry, i) => validateSource(entry, i));
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
