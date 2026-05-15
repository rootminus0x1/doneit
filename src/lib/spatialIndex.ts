import type { TrackBbox } from './gpxParser';

export interface IndexEntry {
    fileId: string;
    filename: string;
    category: string;
    displayName: string;
    date: string | null;
    country: string | null;
    trackType: string | null;
    bbox: TrackBbox;
}

export interface TrackIndex {
    version: number;
    generated: string;
    tracks: IndexEntry[];
}
