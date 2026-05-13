import { useState, useEffect, useCallback } from 'react';
import { api, isReady } from '../lib/dataApi';
import { parsePeaksGpx, filenameToCategoryLabel } from '../lib/gpxParser';
import type { TrackIndex } from '../lib/spatialIndex';
import type { ParsedPeaks } from '../lib/gpxParser';

export interface TrackCategory {
    id: string;
    name: string;
    label: string;
    color: string;
    width: number;
    opacity: number;
    dashArray: number[] | null;
    maxViewportSpan: number | null;
}

export interface UnindexedFile {
    fileId: string;
    category: string;
    filename: string;
}

export interface DriveDataState {
    ready: boolean;
    error: string | null;
    trackIndex: TrackIndex | null;
    categories: TrackCategory[];
    peakSets: ParsedPeaks[];
    tracksPmtilesFileId: string | null;
    unindexedFiles: UnindexedFile[];
}

interface DisplayConfig {
    label?: string;
    color: string;
    width?: number;
    opacity?: number;
    dashArray?: number[] | null;
    maxViewportSpan?: number | null;
}

export function useDriveData(token: string | null): DriveDataState {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [trackIndex, setTrackIndex] = useState<TrackIndex | null>(null);
    const [categories, setCategories] = useState<TrackCategory[]>([]);
    const [peakSets, setPeakSets] = useState<ParsedPeaks[]>([]);
    const [tracksPmtilesFileId, setTracksPmtilesFileId] = useState<string | null>(null);
    const [unindexedFiles, setUnindexedFiles] = useState<UnindexedFile[]>([]);

    const loadPeaks = useCallback(async (tok: string | null, rootId: string) => {
        const rootFolders = await api.listFolders(tok, rootId);
        const peaksFolder = rootFolders.find(f => f.name === 'peaks');
        if (!peaksFolder) return;
        const gpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' });
        const loaded: ParsedPeaks[] = [];
        for (const f of gpxFiles) {
            try {
                const text = await api.readFileText(tok, f.id);
                const category = filenameToCategoryLabel(f.name);
                loaded.push(parsePeaksGpx(text, category));
            } catch {
                // skip unreadable peaks file
            }
        }
        setPeakSets(loaded);
    }, []);

    const init = useCallback(
        async (tok: string | null) => {
            setReady(false);
            setError(null);
            try {
                const rootId = await api.getRootFolderId(tok);
                await loadPeaks(tok, rootId);

                const tracksFId = await api.findOrCreateFolder(tok, 'tracks', rootId);

                // Load categories from display.json files
                const subfolders = await api.listFolders(tok, tracksFId);
                const cats: TrackCategory[] = await Promise.all(
                    subfolders.map(async f => {
                        const displayFile = await api.findFileByName(tok, 'display.json', f.id);
                        if (!displayFile) throw new Error(`Category "${f.name}" is missing display.json`);
                        const display: DisplayConfig = JSON.parse(await api.readFileText(tok, displayFile.id));
                        if (!display.color) throw new Error(`Category "${f.name}" display.json must define a color`);
                        return {
                            id: f.id,
                            name: f.name,
                            label: display.label ?? filenameToCategoryLabel(f.name),
                            color: display.color,
                            width: display.width ?? 3,
                            opacity: display.opacity ?? 0.8,
                            dashArray: display.dashArray ?? null,
                            maxViewportSpan: display.maxViewportSpan ?? null,
                        };
                    }),
                );
                setCategories(cats);

                // Load pre-built index (written by build_pmtiles.py — not built here)
                const indexFile = await api.findFileByName(tok, 'tracks-index.json', tracksFId);
                let index: TrackIndex | null = null;
                if (indexFile) {
                    index = JSON.parse(await api.readFileText(tok, indexFile.id));
                    setTrackIndex(index);
                }

                // Check for pre-built PMTiles overlay
                const pmtilesFile = await api.findFileByName(tok, 'tracks.pmtiles', tracksFId);
                setTracksPmtilesFileId(pmtilesFile?.id ?? null);

                // Scan category subfolders for GPX files not yet in the index
                const indexedFilenames = new Set(index?.tracks.map(t => t.filename) ?? []);
                const unindexed: UnindexedFile[] = [];
                for (const cat of cats) {
                    const gpxFiles = await api.listFiles(tok, cat.id, { nameContains: '.gpx' });
                    for (const f of gpxFiles) {
                        if (!indexedFilenames.has(f.name)) {
                            unindexed.push({ fileId: f.id, category: cat.name, filename: f.name });
                        }
                    }
                }
                setUnindexedFiles(unindexed);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setReady(true);
            }
        },
        [loadPeaks],
    );

    useEffect(() => {
        if (!isReady(token)) {
            setReady(false);
            setTrackIndex(null);
            setCategories([]);
            setPeakSets([]);
            setTracksPmtilesFileId(null);
            setUnindexedFiles([]);
            return;
        }
        init(token);
    }, [token, init]);

    return { ready, error, trackIndex, categories, peakSets, tracksPmtilesFileId, unindexedFiles };
}
