import { describe, it, expect, vi, beforeEach, afterEach, onTestFailed } from 'vitest';
import { buildRasterStyle, loadTileSources } from '../lib/tileConfig';
import type { TileSource } from '../lib/tileConfig';

const BASE: TileSource = {
    id: 'test', label: 'Test', type: 'raster',
    tileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png',
    attribution: '© Test', thumbColor: '#aaa', icon: '',
};

describe('buildRasterStyle', () => {
    it('returns a MapLibre style object with the correct structure', () => {
        const style = buildRasterStyle(BASE) as Record<string, unknown>;
        expect(style.version).toBe(8);
        expect(style.layers).toEqual([{ id: 'raster-layer', type: 'raster', source: 'raster-tiles' }]);
    });

    it('wraps a plain tile URL in an array', () => {
        const style = buildRasterStyle(BASE) as { sources: { 'raster-tiles': { tiles: string[] } } };
        expect(style.sources['raster-tiles'].tiles).toEqual([BASE.tileUrl]);
    });

    it('expands {s} subdomain placeholder into a, b, c variants', () => {
        const src = { ...BASE, tileUrl: 'https://{s}.tiles.example.com/tiles/{z}/{x}/{y}.png' };
        const style = buildRasterStyle(src) as { sources: { 'raster-tiles': { tiles: string[] } } };
        expect(style.sources['raster-tiles'].tiles).toEqual([
            'https://a.tiles.example.com/tiles/{z}/{x}/{y}.png',
            'https://b.tiles.example.com/tiles/{z}/{x}/{y}.png',
            'https://c.tiles.example.com/tiles/{z}/{x}/{y}.png',
        ]);
    });

    it('defaults tileSize to 256', () => {
        const style = buildRasterStyle(BASE) as { sources: { 'raster-tiles': { tileSize: number } } };
        expect(style.sources['raster-tiles'].tileSize).toBe(256);
    });

    it('uses explicit tileSize when provided', () => {
        const style = buildRasterStyle({ ...BASE, tileSize: 512 }) as { sources: { 'raster-tiles': { tileSize: number } } };
        expect(style.sources['raster-tiles'].tileSize).toBe(512);
    });
});

vi.mock('../lib/dataApi', () => ({
    isReady: vi.fn(),
    api: {
        getRootFolderId: vi.fn(),
        listFolders: vi.fn(),
        findFileByName: vi.fn(),
        readFileText: vi.fn(),
    },
}));

import { isReady, api } from '../lib/dataApi';

describe('loadTileSources', () => {
    beforeEach(() => {
        const logs: unknown[][] = [];
        const warns: unknown[][] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args); });
        vi.spyOn(console, 'warn').mockImplementation((...args) => { warns.push(args); });
        onTestFailed(() => {
            for (const a of logs)  console.log(...a);
            for (const a of warns) console.warn(...a);
        });
        vi.mocked(isReady).mockReset();
        vi.mocked(api.getRootFolderId).mockReset();
        vi.mocked(api.listFolders).mockReset();
        vi.mocked(api.findFileByName).mockReset();
        vi.mocked(api.readFileText).mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns [] immediately when not ready', async () => {
        vi.mocked(isReady).mockReturnValue(false);
        expect(await loadTileSources(null)).toEqual([]);
    });

    it('throws when config/ folder is missing', async () => {
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([]);
        await expect(loadTileSources('tok')).rejects.toThrow('config/ folder not found');
    });

    it('throws when tile-sources.json is missing', async () => {
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([{ id: 'cfg', name: 'config' }] as never);
        vi.mocked(api.findFileByName).mockResolvedValue(null);
        await expect(loadTileSources('tok')).rejects.toThrow('tile-sources.json not found');
    });

    it('throws when tile-sources.json is empty', async () => {
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([{ id: 'cfg', name: 'config' }] as never);
        vi.mocked(api.findFileByName).mockResolvedValue({ id: 'f1', name: 'tile-sources.json' } as never);
        vi.mocked(api.readFileText).mockResolvedValue('[]');
        await expect(loadTileSources('tok')).rejects.toThrow('empty or not an array');
    });

    it('returns resolved sources for plain (non-overlay) sources', async () => {
        const sources: TileSource[] = [
            { ...BASE, type: 'vector', styleUrl: 'https://style.example.com/style.json' },
        ];
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([{ id: 'cfg', name: 'config' }] as never);
        vi.mocked(api.findFileByName).mockResolvedValue({ id: 'f1', name: 'tile-sources.json' } as never);
        vi.mocked(api.readFileText).mockResolvedValue(JSON.stringify(sources));
        const result = await loadTileSources('tok');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('test');
    });

    it('drops pmtiles-overlay sources whose filename cannot be resolved', async () => {
        const sources: TileSource[] = [
            { ...BASE, type: 'pmtiles-overlay', filename: 'missing.pmtiles', sourceLayer: 'l' },
        ];
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([
            { id: 'cfg', name: 'config' },
            { id: 'gen', name: 'generated' },
        ] as never);
        vi.mocked(api.findFileByName)
            .mockResolvedValueOnce({ id: 'f1', name: 'tile-sources.json' } as never)
            .mockResolvedValueOnce(null);
        vi.mocked(api.readFileText).mockResolvedValue(JSON.stringify(sources));
        const result = await loadTileSources('tok');
        expect(result).toHaveLength(0);
    });

    it('resolves pmtiles-overlay fileId from generated/ folder', async () => {
        const sources: TileSource[] = [
            { ...BASE, type: 'pmtiles-overlay', filename: 'row.pmtiles', sourceLayer: 'row' },
        ];
        vi.mocked(isReady).mockReturnValue(true);
        vi.mocked(api.getRootFolderId).mockResolvedValue('root');
        vi.mocked(api.listFolders).mockResolvedValue([
            { id: 'cfg', name: 'config' },
            { id: 'gen', name: 'generated' },
        ] as never);
        vi.mocked(api.findFileByName)
            .mockResolvedValueOnce({ id: 'f1', name: 'tile-sources.json' } as never)
            .mockResolvedValueOnce({ id: 'row-file-id', name: 'row.pmtiles' } as never);
        vi.mocked(api.readFileText).mockResolvedValue(JSON.stringify(sources));
        const result = await loadTileSources('tok');
        expect(result).toHaveLength(1);
        expect(result[0].fileId).toBe('row-file-id');
    });
});
