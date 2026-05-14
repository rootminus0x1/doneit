import { useState, useEffect, useCallback, useRef } from 'react';
import { api, isReady } from '../lib/dataApi';
import { upsertJsonFile } from '../lib/driveApi';
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

export interface RawPeakCategory {
    name: string;
    count: number;
}

export interface BaggedEntry {
    category: string;
    name: string;
    lat: number;
    lng: number;
    ele: number;
    baggedOn: string;
    trackFileId: string | null;
}

export type PeakShape = 'circle' | 'triangle' | 'square' | 'diamond';

export interface PeakCategoryDisplay {
    label?: string;
    color?: string;
    strokeColor?: string;
    radius?: number;
    opacity?: number;
    shape?: PeakShape;
}

export interface DriveDataState {
    ready: boolean;
    error: string | null;
    trackIndex: TrackIndex | null;
    categories: TrackCategory[];
    peakSets: ParsedPeaks[];
    peakCategories: RawPeakCategory[];
    peakDisplayConfig: Record<string, PeakCategoryDisplay>;
    peakDefaultHidden: string[];
    tracksPmtilesFileId: string | null;
    peaksPmtilesFileId: string | null;
    unindexedFiles: UnindexedFile[];
    baggedEntries: BaggedEntry[];
    baggedSet: Set<string>;
    addBaggedEntry: (entry: BaggedEntry) => void;
    removeBaggedEntry: (category: string, name: string) => void;
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
    const [peakCategories, setPeakCategories] = useState<RawPeakCategory[]>([]);
    const [peakDisplayConfig, setPeakDisplayConfig] = useState<Record<string, PeakCategoryDisplay>>({});
    const [peakDefaultHidden, setPeakDefaultHidden] = useState<string[]>([]);
    const [tracksPmtilesFileId, setTracksPmtilesFileId] = useState<string | null>(null);
    const [peaksPmtilesFileId, setPeaksPmtilesFileId] = useState<string | null>(null);
    const [unindexedFiles, setUnindexedFiles] = useState<UnindexedFile[]>([]);
    const [baggedEntries, setBaggedEntries] = useState<BaggedEntry[]>([]);

    // Kept in refs so the add/remove callbacks don't need to be recreated when token changes
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; }, [token]);
    const peaksFolderIdRef = useRef<string | null>(null);

    const loadPeaks = useCallback(async (tok: string | null, rootId: string) => {
        const rootFolders = await api.listFolders(tok, rootId);
        const peaksFolder = rootFolders.find(f => f.name === 'peaks');
        if (!peaksFolder) return;

        peaksFolderIdRef.current = peaksFolder.id;

        const [pmtilesFile, indexFile, displayFile, baggedFile] = await Promise.all([
            api.findFileByName(tok, 'peaks.pmtiles', peaksFolder.id),
            api.findFileByName(tok, 'peaks-index.json', peaksFolder.id),
            api.findFileByName(tok, 'display.json', peaksFolder.id),
            api.findFileByName(tok, 'bagged.json', peaksFolder.id),
        ]);

        if (baggedFile) {
            try {
                const data = JSON.parse(await api.readFileText(tok, baggedFile.id));
                if (Array.isArray(data.entries)) setBaggedEntries(data.entries as BaggedEntry[]);
            } catch { /* ignore unreadable bagged file */ }
        }

        // Parse display file once; derive both config and default-hidden list from it
        let displayConfig: Record<string, PeakCategoryDisplay> = {};
        let defaultVisibleSet: Set<string> | null = null;
        if (displayFile) {
            try {
                const disp = JSON.parse(await api.readFileText(tok, displayFile.id));
                if (disp.categories && typeof disp.categories === 'object')
                    displayConfig = disp.categories as Record<string, PeakCategoryDisplay>;
                if (Array.isArray(disp.defaultVisible))
                    defaultVisibleSet = new Set<string>(disp.defaultVisible as string[]);
            } catch { /* ignore bad config */ }
        }
        setPeakDisplayConfig(displayConfig);

        // Category names are always lowercase (matching peaks-index.json and build script)
        const gpxNameToCategory = (filename: string) => filename.replace(/\.gpx$/i, '').toLowerCase();
        const computeDefaultHidden = (categoryNames: string[]) =>
            defaultVisibleSet ? categoryNames.filter(n => !defaultVisibleSet!.has(n)) : [];

        if (pmtilesFile && indexFile) {
            setPeaksPmtilesFileId(pmtilesFile.id);
            try {
                const idx = JSON.parse(await api.readFileText(tok, indexFile.id));
                const cats: RawPeakCategory[] = idx.categories ?? [];
                // Sort by display.json key order so the user's intended ranking drives
                // both sidebar order and map z-ordering (first in display.json = on top).
                const displayOrder = Object.keys(displayConfig);
                const orderedCats = displayOrder.length > 0
                    ? [
                        ...displayOrder.map(name => cats.find(c => c.name === name)).filter((c): c is RawPeakCategory => c !== undefined),
                        ...cats.filter(c => !displayOrder.includes(c.name)),
                      ]
                    : cats;
                setPeakCategories(orderedCats);
                setPeakDefaultHidden(computeDefaultHidden(orderedCats.map(c => c.name)));

                // Load GPX files not yet in the PMTiles index so they appear immediately
                const indexedCategories = new Set(cats.map(c => c.name));
                const allGpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' });
                const unindexed: ParsedPeaks[] = [];
                for (const f of allGpxFiles) {
                    const cat = gpxNameToCategory(f.name);
                    if (!indexedCategories.has(cat)) {
                        try {
                            const text = await api.readFileText(tok, f.id);
                            unindexed.push(parsePeaksGpx(text, cat));
                        } catch { /* skip unreadable file */ }
                    }
                }
                if (unindexed.length > 0) setPeakSets(unindexed);
            } catch {
                // peaks-index.json unreadable — categories stay empty
            }
            return;
        }

        // GPX fallback: load all files, use lowercase name as category key
        const gpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' });
        const loaded: ParsedPeaks[] = [];
        for (const f of gpxFiles) {
            try {
                const text = await api.readFileText(tok, f.id);
                loaded.push(parsePeaksGpx(text, gpxNameToCategory(f.name)));
            } catch { /* skip unreadable peaks file */ }
        }
        setPeakSets(loaded);
        setPeakDefaultHidden(computeDefaultHidden(loaded.map(ps => ps.category)));
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
            setPeakCategories([]);
            setPeakDisplayConfig({});
            setPeakDefaultHidden([]);
            setTracksPmtilesFileId(null);
            setPeaksPmtilesFileId(null);
            setUnindexedFiles([]);
            setBaggedEntries([]);
            peaksFolderIdRef.current = null;
            return;
        }
        init(token);
    }, [token, init]);

    const addBaggedEntry = useCallback((entry: BaggedEntry) => {
        setBaggedEntries(prev => {
            const next = [
                ...prev.filter(e => !(e.category === entry.category && e.name === entry.name)),
                entry,
            ];
            const folderId = peaksFolderIdRef.current;
            if (tokenRef.current && folderId) {
                upsertJsonFile(tokenRef.current, 'bagged.json', folderId, { version: 1, entries: next })
                    .catch(err => console.error('[Drive] failed to save bagged.json:', err));
            }
            return next;
        });
    }, []);

    const removeBaggedEntry = useCallback((category: string, name: string) => {
        setBaggedEntries(prev => {
            const next = prev.filter(e => !(e.category === category && e.name === name));
            const folderId = peaksFolderIdRef.current;
            if (tokenRef.current && folderId) {
                upsertJsonFile(tokenRef.current, 'bagged.json', folderId, { version: 1, entries: next })
                    .catch(err => console.error('[Drive] failed to save bagged.json:', err));
            }
            return next;
        });
    }, []);

    const baggedSet = new Set(baggedEntries.map(e => `${e.category}:${e.name}`));

    return { ready, error, trackIndex, categories, peakSets, peakCategories, peakDisplayConfig, peakDefaultHidden, tracksPmtilesFileId, peaksPmtilesFileId, unindexedFiles, baggedEntries, baggedSet, addBaggedEntry, removeBaggedEntry };
}
