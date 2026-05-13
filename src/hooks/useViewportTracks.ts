import { useState, useEffect, useRef, useCallback } from 'react';
import { parseTrackGpx } from '../lib/gpxParser';
import { api, isReady } from '../lib/dataApi';
import type { FeatureCollection, LineString } from 'geojson';
import type { UnindexedFile } from './useDriveData';

export interface LoadedTrack {
    fileId: string;
    category: string;
    displayName: string;
    date: string | null;
    geojson: FeatureCollection<LineString>;
}

export function useUnindexedTracks(token: string | null, files: UnindexedFile[]): LoadedTrack[] {
    const [loadedTracks, setLoadedTracks] = useState<LoadedTrack[]>([]);
    const cacheRef = useRef<Map<string, LoadedTrack>>(new Map());
    const loadingRef = useRef<Set<string>>(new Set());

    const loadFiles = useCallback(async (tok: string | null, toLoad: UnindexedFile[]) => {
        const pending = toLoad.filter(f => !cacheRef.current.has(f.fileId) && !loadingRef.current.has(f.fileId));
        if (pending.length === 0) return;

        pending.forEach(f => loadingRef.current.add(f.fileId));

        const CONCURRENCY = 5;
        for (let i = 0; i < pending.length; i += CONCURRENCY) {
            const batch = pending.slice(i, i + CONCURRENCY);
            await Promise.all(
                batch.map(async entry => {
                    try {
                        const text = await api.readFileText(tok, entry.fileId);
                        const parsed = parseTrackGpx(text, entry.filename);
                        cacheRef.current.set(entry.fileId, {
                            fileId: entry.fileId,
                            category: entry.category,
                            displayName: parsed.displayName,
                            date: parsed.date,
                            geojson: parsed.geojson,
                        });
                    } catch {
                        // skip unreadable track
                    } finally {
                        loadingRef.current.delete(entry.fileId);
                    }
                }),
            );
            setLoadedTracks([...cacheRef.current.values()]);
        }
    }, []);

    useEffect(() => {
        if (!isReady(token) || files.length === 0) return;
        loadFiles(token, files);
    }, [token, files, loadFiles]);

    useEffect(() => {
        if (!isReady(token)) {
            cacheRef.current.clear();
            setLoadedTracks([]);
        }
    }, [token]);

    return loadedTracks;
}
