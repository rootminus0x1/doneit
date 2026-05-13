import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';

// Shared Protocol instance for the whole app lifetime.
// Registered once here so both base-map tiles and overlay tiles
// (tracks, contours, custom layers) all use the same pmtiles:// scheme.
export const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Implements the PMTiles Source interface against the Drive API.
// getToken is called on every request so token refreshes are picked up automatically.
class DriveSource {
    constructor(
        private readonly fileId: string,
        private readonly getToken: () => string,
    ) {}

    getKey(): string {
        return this.fileId;
    }

    async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<{ data: ArrayBuffer }> {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`, {
            headers: {
                Authorization: `Bearer ${this.getToken()}`,
                Range: `bytes=${offset}-${offset + length - 1}`,
            },
            signal,
        });
        if (!res.ok) throw new Error(`Drive PMTiles fetch failed: HTTP ${res.status}`);
        return { data: await res.arrayBuffer() };
    }
}

// Registers a Drive-hosted PMTiles file with the shared Protocol.
// Returns the URL to use in MapLibre styles: pmtiles://{fileId}
// Safe to call multiple times with the same fileId — the latest registration wins,
// which is desirable when the token is refreshed.
export function registerDrivePMTiles(fileId: string, getToken: () => string): string {
    protocol.add(new PMTiles(new DriveSource(fileId, getToken)));
    return `pmtiles://${fileId}`;
}
