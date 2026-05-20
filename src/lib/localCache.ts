const DB_NAME = 'doneit-cache';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('json-cache')) db.createObjectStore('json-cache', { keyPath: 'fileId' });
            if (!db.objectStoreNames.contains('pmtiles-meta'))
                db.createObjectStore('pmtiles-meta', { keyPath: 'fileId' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn('IndexedDB open blocked');
    });
    return dbPromise;
}

export interface CachedJson {
    md5: string;
    content: string;
    name: string;
}

export async function getCachedJson(fileId: string): Promise<CachedJson | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction('json-cache', 'readonly').objectStore('json-cache').get(fileId);
        req.onsuccess = () => resolve((req.result as CachedJson | undefined) ?? null);
        req.onerror = () => reject(req.error);
    });
}

export async function setCachedJson(fileId: string, md5: string, content: string, name: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('json-cache', 'readwrite');
        tx.objectStore('json-cache').put({ fileId, md5, content, name });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getPMTilesMd5(fileId: string): Promise<string | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction('pmtiles-meta', 'readonly').objectStore('pmtiles-meta').get(fileId);
        req.onsuccess = () => resolve((req.result as { md5: string } | undefined)?.md5 ?? null);
        req.onerror = () => reject(req.error);
    });
}

export async function getLocalPMTilesFile(fileId: string): Promise<File | null> {
    try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('pmtiles', { create: false });
        const handle = await dir.getFileHandle(`${fileId}.pmtiles`, { create: false });
        return handle.getFile();
    } catch {
        return null;
    }
}

export async function storePMTiles(
    fileId: string,
    md5: string,
    name: string,
    response: Response,
    onProgress?: (bytes: number) => void,
): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pmtiles', { create: true });
    const handle = await dir.getFileHandle(`${fileId}.pmtiles`, { create: true });
    const writable = await handle.createWritable();
    try {
        const reader = response.body!.getReader();
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writable.write(value);
            total += value.byteLength;
            onProgress?.(total);
        }
        await writable.close();
    } catch (err) {
        await writable.abort();
        throw err;
    }

    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pmtiles-meta', 'readwrite');
        tx.objectStore('pmtiles-meta').put({ fileId, md5, name });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
