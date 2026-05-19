import { useState, useCallback, useRef } from 'react';
import {
    getRootFolderId,
    listFolders,
    listFiles,
    downloadFileStream,
} from '../lib/driveApi';
import { getCachedJson, setCachedJson, getPMTilesMd5, storePMTiles } from '../lib/localCache';
import { upgradeToLocalPMTiles } from '../lib/drivepmtiles';

export type SyncStatus = 'idle' | 'syncing' | 'done' | 'error';

export interface SyncProgress {
    done: number;
    total: number;
    currentFile: string;
}

export interface SyncState {
    status: SyncStatus;
    progress: SyncProgress | null;
    lastSynced: string | null;
    error: string | null;
}

export function useSync(token: string | null) {
    const [syncState, setSyncState] = useState<SyncState>({
        status: 'idle',
        progress: null,
        lastSynced: localStorage.getItem('doneit-last-synced'),
        error: null,
    });
    const abortRef = useRef<AbortController | null>(null);

    const startSync = useCallback(async () => {
        if (!token) return;

        const controller = new AbortController();
        abortRef.current = controller;
        setSyncState(s => ({ ...s, status: 'syncing', progress: null, error: null }));

        try {
            const rootId = await getRootFolderId(token);
            const rootFolders = await listFolders(token, rootId);
            const configFolder = rootFolders.find(f => f.name === 'config');
            const generatedFolder = rootFolders.find(f => f.name === 'generated');

            const syncable: Array<{ id: string; name: string; md5Checksum?: string }> = [];
            if (configFolder) {
                const files = await listFiles(token, configFolder.id);
                files.filter(f => f.name.endsWith('.json')).forEach(f => syncable.push(f));
            }
            if (generatedFolder) {
                const files = await listFiles(token, generatedFolder.id);
                files.filter(f => f.name.endsWith('.json') || f.name.endsWith('.pmtiles'))
                    .forEach(f => syncable.push(f));
            }

            let done = 0;
            const total = syncable.length;

            for (const file of syncable) {
                if (controller.signal.aborted) break;
                setSyncState(s => ({ ...s, progress: { done, total, currentFile: file.name } }));

                const isPMTiles = file.name.endsWith('.pmtiles');
                const cachedMd5 = isPMTiles
                    ? await getPMTilesMd5(file.id)
                    : (await getCachedJson(file.id))?.md5 ?? null;

                if (cachedMd5 && cachedMd5 === file.md5Checksum) {
                    done++;
                    continue;
                }

                const response = await downloadFileStream(token, file.id, controller.signal);

                if (isPMTiles) {
                    await storePMTiles(file.id, file.md5Checksum ?? '', file.name, response);
                    await upgradeToLocalPMTiles(file.id);
                } else {
                    const content = await response.text();
                    await setCachedJson(file.id, file.md5Checksum ?? '', content, file.name);
                }

                done++;
                setSyncState(s => ({ ...s, progress: { done, total, currentFile: file.name } }));
            }

            if (!controller.signal.aborted) {
                const now = new Date().toISOString();
                localStorage.setItem('doneit-last-synced', now);
                setSyncState({ status: 'done', progress: null, lastSynced: now, error: null });
            } else {
                setSyncState(s => ({ ...s, status: 'idle', progress: null }));
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                setSyncState(s => ({
                    ...s,
                    status: 'error',
                    progress: null,
                    error: err instanceof Error ? err.message : String(err),
                }));
            } else {
                setSyncState(s => ({ ...s, status: 'idle', progress: null }));
            }
        } finally {
            abortRef.current = null;
        }
    }, [token]);

    const cancelSync = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    return { syncState, startSync, cancelSync };
}
