import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    getRootFolderId,
    findOrCreateFolder,
    listFolders,
    listFiles,
    readFileText,
    findFileByName,
    upsertJsonFile,
} from '../lib/localDataApi';

const mockFetch = vi.spyOn(globalThis, 'fetch');

function makeResponse(body: unknown, ok = true): Response {
    return {
        ok,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

describe('localDataApi', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        localStorage.clear();
    });

    it('getRootFolderId returns empty string', async () => {
        expect(await getRootFolderId(null)).toBe('');
    });

    describe('findOrCreateFolder', () => {
        it('joins parent and child with slash', async () => {
            expect(await findOrCreateFolder(null, 'peaks', 'DoneIt')).toBe('DoneIt/peaks');
        });

        it('returns child alone when parent is empty', async () => {
            expect(await findOrCreateFolder(null, 'tracks', '')).toBe('tracks');
        });
    });

    describe('listFolders', () => {
        it('returns only directory entries', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([
                { name: 'tracks', type: 'directory' },
                { name: 'tile-sources.json', type: 'file' },
                { name: 'peaks', type: 'directory' },
            ]));
            const result = await listFolders(null, '');
            expect(result).toHaveLength(2);
            expect(result.map(f => f.name)).toEqual(['tracks', 'peaks']);
        });

        it('builds file ID from parentId and name', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([{ name: 'hiking', type: 'directory' }]));
            const [folder] = await listFolders(null, 'tracks');
            expect(folder.id).toBe('tracks/hiking');
        });

        it('returns empty array when fetch fails', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse(null, false));
            expect(await listFolders(null, 'missing')).toEqual([]);
        });
    });

    describe('listFiles', () => {
        it('returns only file entries', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([
                { name: 'display.json', type: 'file' },
                { name: 'activity_1234.gpx', type: 'file' },
                { name: 'subdir', type: 'directory' },
            ]));
            const result = await listFiles(null, 'tracks/hiking');
            expect(result).toHaveLength(2);
        });

        it('filters by nameContains', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([
                { name: 'display.json', type: 'file' },
                { name: 'activity_1234.gpx', type: 'file' },
                { name: 'activity_5678.gpx', type: 'file' },
            ]));
            const result = await listFiles(null, 'tracks/hiking', { nameContains: '.gpx' });
            expect(result).toHaveLength(2);
            expect(result.every(f => f.name.endsWith('.gpx'))).toBe(true);
        });

        it('assigns gpx mimeType for .gpx files', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([{ name: 'activity_1.gpx', type: 'file' }]));
            const [file] = await listFiles(null, 'tracks/hiking');
            expect(file.mimeType).toBe('application/gpx+xml');
        });
    });

    describe('readFileText', () => {
        it('fetches and returns text content', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse('hello gpx content'));
            const text = await readFileText(null, 'peaks/munros.gpx');
            expect(text).toBe('hello gpx content');
        });

        it('throws when fetch returns not-ok', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse(null, false));
            await expect(readFileText(null, 'missing.json')).rejects.toThrow('Local file not found');
        });

        it('reads from localStorage for __ls__: IDs', async () => {
            localStorage.setItem('local:tracks/tracks-index.json', '"cached"');
            const text = await readFileText(null, '__ls__:local:tracks/tracks-index.json');
            expect(text).toBe('"cached"');
        });
    });

    describe('findFileByName', () => {
        it('checks localStorage before fetching', async () => {
            localStorage.setItem('local:tracks/tracks-index.json', '{}');
            const file = await findFileByName(null, 'tracks-index.json', 'tracks');
            expect(file).not.toBeNull();
            expect(file!.id).toMatch(/^__ls__:/);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('falls through to fetch when not in localStorage', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([
                { name: 'peaks-index.json', type: 'file' },
            ]));
            const file = await findFileByName(null, 'peaks-index.json', 'peaks');
            expect(file).not.toBeNull();
            expect(file!.name).toBe('peaks-index.json');
        });

        it('returns null when file is not found', async () => {
            mockFetch.mockResolvedValueOnce(makeResponse([]));
            expect(await findFileByName(null, 'nonexistent.json', 'peaks')).toBeNull();
        });
    });

    describe('upsertJsonFile', () => {
        it('saves content to localStorage', async () => {
            await upsertJsonFile(null, 'tracks-index.json', 'tracks', { version: 1 });
            const stored = localStorage.getItem('local:tracks/tracks-index.json');
            expect(stored).not.toBeNull();
            expect(JSON.parse(stored!)).toEqual({ version: 1 });
        });
    });
});
