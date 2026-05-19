import { useState, useEffect, useCallback } from 'react';
import { api, isReady } from '../lib/dataApi';
import { DriveAuthError } from '../lib/driveApi'; // used only to suppress error display (reconnect banner handles it)
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

export interface BaggedPeak {
    category: string;
    names: string[];
}

export interface BaggedTrack {
    track: string; // GPX filename, e.g. "activity_1234.gpx"
    date: string | null; // "2026-05-14"
    peaks: BaggedPeak[];
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
    baggedTracks: BaggedTrack[];
    baggedSet: Set<string>;
    unindexedFiles: UnindexedFile[];
}

interface TrackDisplayConfig {
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
    const [baggedTracks, setBaggedTracks] = useState<BaggedTrack[]>([]);
    const [unindexedFiles, setUnindexedFiles] = useState<UnindexedFile[]>([]);

    const init = useCallback(async (tok: string | null) => {
        setReady(false);
        setError(null);
        try {
            const rootId = await api.getRootFolderId(tok);

            // Read consolidated display config from config/display.json
            const configFolderId = await api.findOrCreateFolder(tok, 'config', rootId);
            const displayFile = await api.findFileByName(tok, 'display.json', configFolderId);
            if (!displayFile) throw new Error('config/display.json not found in Drive');

            const disp = JSON.parse(await api.readFileText(tok, displayFile.id));
            const tracksDisplay: Record<string, TrackDisplayConfig> =
                (disp.tracks as Record<string, TrackDisplayConfig>) ?? {};

            let peakDisplayConfigMap: Record<string, PeakCategoryDisplay> = {};
            let defaultVisibleSet: Set<string> | null = null;
            const peaksSection = disp.peaks as
                | { defaultVisible?: string[]; categories?: Record<string, PeakCategoryDisplay> }
                | undefined;
            if (peaksSection) {
                if (peaksSection.categories) peakDisplayConfigMap = peaksSection.categories;
                if (Array.isArray(peaksSection.defaultVisible))
                    defaultVisibleSet = new Set(peaksSection.defaultVisible);
            }
            setPeakDisplayConfig(peakDisplayConfigMap);

            const computeDefaultHidden = (names: string[]) =>
                defaultVisibleSet ? names.filter(n => !defaultVisibleSet!.has(n)) : [];

            // Generated artifacts: PMTiles + index files
            const generatedFolderId = await api.findOrCreateFolder(tok, 'generated', rootId);

            // Track categories from tracks/ subfolders; display from config/display.json
            const tracksFId = await api.findOrCreateFolder(tok, 'tracks', rootId);
            const subfolders = await api.listFolders(tok, tracksFId);
            const cats: TrackCategory[] = subfolders.map(f => {
                const display = tracksDisplay[f.name];
                if (!display)
                    throw new Error(`Category "${f.name}" has no display config in config/display.json`);
                if (!display.color)
                    throw new Error(`Category "${f.name}" in config/display.json must define a color`);
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
            });
            setCategories(cats);

            // Track index and PMTiles from generated/
            const indexFile = await api.findFileByName(tok, 'tracks-index.json', generatedFolderId);
            let index: TrackIndex | null = null;
            if (indexFile) {
                index = JSON.parse(await api.readFileText(tok, indexFile.id));
                setTrackIndex(index);
            }

            const pmtilesFile = await api.findFileByName(tok, 'tracks.pmtiles', generatedFolderId);
            setTracksPmtilesFileId(pmtilesFile?.id ?? null);

            // Unindexed track GPX files (shown immediately without a rebuild)
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

            // Peaks
            const rootFolders = await api.listFolders(tok, rootId);
            const peaksFolder = rootFolders.find(f => f.name === 'peaks');
            if (peaksFolder) {
                const gpxNameToCategory = (filename: string) => filename.replace(/\.gpx$/i, '').toLowerCase();

                const [peaksPmtiles, peaksIndex, manualFile] = await Promise.all([
                    api.findFileByName(tok, 'peaks.pmtiles', generatedFolderId),
                    api.findFileByName(tok, 'peaks-index.json', generatedFolderId),
                    api.findFileByName(tok, 'peaks-manual.json', configFolderId),
                ]);

                if (peaksPmtiles && peaksIndex) {
                    setPeaksPmtilesFileId(peaksPmtiles.id);
                    const idx = JSON.parse(await api.readFileText(tok, peaksIndex.id)) as Record<string, unknown>;
                    if (idx.version !== 2) {
                        throw new Error(
                            `peaks-index.json has an incompatible format (version ${idx.version ?? 'none'}, expected 2). ` +
                                `Run "yarn data" to rebuild, or delete peaks-index.json from Drive and re-run. ` +
                                `Expected: { version: 2, categories: [{name, count}], ` +
                                `bagged: [{track, date, peaks: [{category, names}]}] }`,
                        );
                    }
                    const peakCats: RawPeakCategory[] = Array.isArray(idx.categories)
                        ? (idx.categories as RawPeakCategory[])
                        : [];
                    const displayOrder = Object.keys(peakDisplayConfigMap);
                    const orderedCats =
                        displayOrder.length > 0
                            ? [
                                  ...displayOrder
                                      .map(name => peakCats.find(c => c.name === name))
                                      .filter((c): c is RawPeakCategory => c !== undefined),
                                  ...peakCats.filter(c => !displayOrder.includes(c.name)),
                              ]
                            : peakCats;
                    setPeakCategories(orderedCats);
                    setPeakDefaultHidden(computeDefaultHidden(orderedCats.map(c => c.name)));

                    const autoBagged: BaggedTrack[] = Array.isArray(idx.bagged)
                        ? (idx.bagged as BaggedTrack[])
                        : [];
                    let manualBagged: BaggedTrack[] = [];
                    if (manualFile) {
                        try {
                            const manual = JSON.parse(await api.readFileText(tok, manualFile.id));
                            if (Array.isArray(manual.bagged)) manualBagged = manual.bagged as BaggedTrack[];
                        } catch {
                            /* ignore unreadable or malformed manual file */
                        }
                    }
                    setBaggedTracks([...autoBagged, ...manualBagged]);

                    // Load GPX files not yet in the PMTiles index so they appear immediately
                    const indexedCategories = new Set(peakCats.map(c => c.name));
                    const allGpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' });
                    const unindexedPeaks: ParsedPeaks[] = [];
                    for (const f of allGpxFiles) {
                        const cat = gpxNameToCategory(f.name);
                        if (!indexedCategories.has(cat)) {
                            try {
                                const text = await api.readFileText(tok, f.id);
                                unindexedPeaks.push(parsePeaksGpx(text, cat));
                            } catch {
                                /* skip unreadable file */
                            }
                        }
                    }
                    if (unindexedPeaks.length > 0) setPeakSets(unindexedPeaks);
                } else {
                    // GPX fallback: load all files, use lowercase name as category key
                    const gpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' });
                    const loaded: ParsedPeaks[] = [];
                    for (const f of gpxFiles) {
                        try {
                            const text = await api.readFileText(tok, f.id);
                            loaded.push(parsePeaksGpx(text, gpxNameToCategory(f.name)));
                        } catch {
                            /* skip unreadable peaks file */
                        }
                    }
                    setPeakSets(loaded);
                    setPeakDefaultHidden(computeDefaultHidden(loaded.map(ps => ps.category)));
                }
            }
        } catch (err: unknown) {
            if (!(err instanceof DriveAuthError)) {
                setError(err instanceof Error ? err.message : String(err));
            }
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => {
        if (!isReady(token)) {
            setReady(false);
            setError(null);
            setTrackIndex(null);
            setCategories([]);
            setPeakSets([]);
            setPeakCategories([]);
            setPeakDisplayConfig({});
            setPeakDefaultHidden([]);
            setTracksPmtilesFileId(null);
            setPeaksPmtilesFileId(null);
            setBaggedTracks([]);
            setUnindexedFiles([]);
            return;
        }
        init(token);
    }, [token, init]);

    const baggedSet = new Set(
        baggedTracks.flatMap(bt => bt.peaks.flatMap(bp => bp.names.map(n => `${bp.category}:${n}`))),
    );

    return {
        ready,
        error,
        trackIndex,
        categories,
        peakSets,
        peakCategories,
        peakDisplayConfig,
        peakDefaultHidden,
        tracksPmtilesFileId,
        peaksPmtilesFileId,
        baggedTracks,
        baggedSet,
        unindexedFiles,
    };
}
