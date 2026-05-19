import { authExpiredEvent } from './authEvents';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_FOLDER = 'DoneIt';
const TIMEOUT_MS = 30_000;

export class DriveAuthError extends Error {
    constructor() {
        super('Google Drive session expired — please reconnect');
        this.name = 'DriveAuthError';
        authExpiredEvent.emit();
    }
}

async function assertOk(res: Response): Promise<void> {
    if (res.status === 401) throw new DriveAuthError();
    if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
}

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
}

function driveSignal(): AbortSignal {
    return AbortSignal.timeout(TIMEOUT_MS);
}

function timeoutMessage(err: unknown): string {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return 'Google Drive request timed out — check your connection';
    }
    return err instanceof Error ? err.message : String(err);
}

async function request<T>(url: string, token: string | null, options?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(url, {
            ...options,
            signal: driveSignal(),
            headers: {
                Authorization: `Bearer ${token}`,
                ...(options?.headers ?? {}),
            },
        });
    } catch (err) {
        throw new Error(timeoutMessage(err));
    }
    await assertOk(res);
    return res.json() as Promise<T>;
}

export async function listFiles(
    token: string | null,
    parentId: string,
    opts: { mimeType?: string; nameContains?: string } = {},
): Promise<DriveFile[]> {
    const q: string[] = [`'${parentId}' in parents`, 'trashed = false'];
    if (opts.mimeType) q.push(`mimeType = '${opts.mimeType}'`);
    if (opts.nameContains) q.push(`name contains '${opts.nameContains}'`);

    const params = new URLSearchParams({
        q: q.join(' and '),
        fields: 'files(id,name,mimeType,size)',
        pageSize: '1000',
    });
    const res = await request<{ files: DriveFile[] }>(`${DRIVE_API}/files?${params}`, token);
    return res.files;
}

export async function listFolders(token: string | null, parentId: string): Promise<DriveFile[]> {
    return listFiles(token, parentId, {
        mimeType: 'application/vnd.google-apps.folder',
    });
}

export async function readFileText(token: string | null, fileId: string): Promise<string> {
    let res: Response;
    try {
        res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
            signal: driveSignal(),
            headers: { Authorization: `Bearer ${token}` },
        });
    } catch (err) {
        throw new Error(timeoutMessage(err));
    }
    await assertOk(res);
    return res.text();
}

export async function findOrCreateFolder(token: string | null, name: string, parentId: string): Promise<string> {
    const existing = await listFiles(token, parentId, {
        mimeType: 'application/vnd.google-apps.folder',
    });
    console.log(
        `[Drive] findOrCreateFolder("${name}") — found folders:`,
        existing.map(f => f.name),
    );
    const found = existing.find(f => f.name === name);
    if (found) {
        console.log(`[Drive] found folder "${name}" id=${found.id}`);
        return found.id;
    }

    console.warn(`[Drive] folder "${name}" not found — creating new one`);
    const res = await request<DriveFile>(`${DRIVE_API}/files`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        }),
    });
    return res.id;
}

export async function findFileByName(token: string | null, name: string, parentId: string): Promise<DriveFile | null> {
    const files = await listFiles(token, parentId);
    return files.find(f => f.name === name) ?? null;
}

export async function upsertJsonFile(
    token: string | null,
    name: string,
    parentId: string,
    content: unknown,
): Promise<void> {
    const existing = await findFileByName(token, name, parentId);
    const body = JSON.stringify(content, null, 2);

    if (existing) {
        let res: Response;
        try {
            res = await fetch(`${UPLOAD_API}/files/${existing.id}?uploadType=media`, {
                method: 'PATCH',
                signal: driveSignal(),
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body,
            });
        } catch (err) {
            throw new Error(timeoutMessage(err));
        }
        await assertOk(res);
    } else {
        const metadata = JSON.stringify({ name, parents: [parentId] });
        const blob = new Blob([
            `--boundary\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
            `--boundary\r\nContent-Type: application/json\r\n\r\n${body}\r\n`,
            '--boundary--',
        ]);
        let res: Response;
        try {
            res = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
                method: 'POST',
                signal: driveSignal(),
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'multipart/related; boundary=boundary',
                },
                body: blob,
            });
        } catch (err) {
            throw new Error(timeoutMessage(err));
        }
        await assertOk(res);
    }
}

export async function getRootFolderId(token: string | null): Promise<string> {
    const res = await request<{ id: string }>(`${DRIVE_API}/files/root?fields=id`, token);
    const driveRootId = res.id;
    return findOrCreateFolder(token, DRIVE_FOLDER, driveRootId);
}
