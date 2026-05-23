import { gpx, kml } from '@tmcw/togeojson';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import { findGpxText } from './gpxMeta';

export interface TrackBbox {
    west: number;
    east: number;
    south: number;
    north: number;
}

export interface ParsedTrack {
    geojson: FeatureCollection<LineString>;
    bbox: TrackBbox;
    displayName: string;
    date: string | null;
    datetime: string | null;
    trackType: string | null;
    linkText: string | null;
}

export interface ParsedPeaks {
    geojson: FeatureCollection<Point>;
    category: string;
}

function bboxFromCoords(coords: number[][]): TrackBbox {
    let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
    for (const [lon, lat] of coords) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return { west, east, south, north };
}

export function parseTrackGpx(gpxText: string, fallbackName: string): ParsedTrack {
    const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error(`Invalid GPX: ${parseError.textContent?.trim().slice(0, 120)}`);
    const geojson = gpx(doc) as FeatureCollection;

    const trackFeatures = geojson.features.filter((f): f is Feature<LineString> => f.geometry?.type === 'LineString');

    const allCoords = trackFeatures.flatMap(f => f.geometry.coordinates as number[][]);
    const bbox = allCoords.length > 0 ? bboxFromCoords(allCoords) : { west: 0, east: 0, south: 0, north: 0 };

    const displayName = findGpxText(gpxText, 'trk', 'name') ?? findGpxText(gpxText, 'name') ?? fallbackName;

    const dateStr = findGpxText(gpxText, 'metadata', 'time') ?? findGpxText(gpxText, 'trkpt', 'time');

    const date = dateStr ? dateStr.slice(0, 10) : null;
    const datetime = dateStr ?? null;
    const trackType = findGpxText(gpxText, 'trk', 'type');
    const linkText = findGpxText(gpxText, 'metadata', 'link', 'text');

    return {
        geojson: { type: 'FeatureCollection', features: trackFeatures },
        bbox,
        displayName,
        date,
        datetime,
        trackType,
        linkText,
    };
}

export function parsePeaksGpx(gpxText: string, category: string): ParsedPeaks {
    const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error(`Invalid GPX in ${category}: ${parseError.textContent?.trim().slice(0, 120)}`);
    const geojson = gpx(doc) as FeatureCollection;

    const pointFeatures = geojson.features.filter((f): f is Feature<Point> => f.geometry?.type === 'Point');

    return {
        geojson: { type: 'FeatureCollection', features: pointFeatures },
        category,
    };
}

export function filenameToCategoryLabel(filename: string): string {
    return filename
        .replace(/\.gpx$/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

export interface LoadedRoute {
    fileId: string;
    filename: string;
    displayName: string;
    date: string | null;
    lengthKm: number | null;
    bbox: { west: number; east: number; south: number; north: number } | null;
    color: string;
    geojson: FeatureCollection;
}

export const ROUTE_PALETTE = [
    '#1d4ed8', // dark blue (default)
    '#0891b2', // cyan-blue
    '#059669', // teal-green
    '#7c3aed', // purple
    '#b45309', // amber-brown
    '#be123c', // crimson
    '#0f766e', // dark teal
    '#1e40af', // navy
];

export function simpleHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) & 0xffff;
    return h;
}

function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function lengthFromCoords(coords: number[][]): number {
    let km = 0;
    for (let i = 1; i < coords.length; i++) km += haversineKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    return km;
}

function bboxFromLineCoords(allCoords: number[][]): { west: number; east: number; south: number; north: number } | null {
    if (allCoords.length === 0) return null;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lng, lat] of allCoords) {
        if (lng < west) west = lng;
        if (lng > east) east = lng;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return { west, east, south, north };
}

export function parseRouteFile(text: string, filename: string, fileId: string): LoadedRoute {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    let fc: FeatureCollection;

    if (ext === 'gpx') {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const err = doc.querySelector('parsererror');
        if (err) throw new Error(`Invalid GPX in ${filename}: ${err.textContent?.trim().slice(0, 120)}`);
        fc = gpx(doc) as FeatureCollection;
    } else if (ext === 'kml') {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const err = doc.querySelector('parsererror');
        if (err) throw new Error(`Invalid KML in ${filename}: ${err.textContent?.trim().slice(0, 120)}`);
        fc = kml(doc) as FeatureCollection;
    } else if (ext === 'geojson' || ext === 'json') {
        fc = JSON.parse(text) as FeatureCollection;
    } else {
        throw new Error(`Unsupported route format: ${filename}`);
    }

    const lines = (fc.features ?? []).filter(
        (f): f is Feature<LineString> => f.geometry?.type === 'LineString',
    );

    const displayName =
        (fc.features?.[0]?.properties?.name as string | undefined) ??
        filename.replace(/\.[^.]+$/, '');

    const dateRaw = fc.features?.[0]?.properties?.time as string | undefined;
    const date = dateRaw ? dateRaw.slice(0, 10) : null;

    const allCoords = lines.flatMap(f => f.geometry.coordinates as number[][]);
    const lengthKm = allCoords.length > 1 ? Math.round(lengthFromCoords(allCoords) * 10) / 10 : null;
    const bbox = bboxFromLineCoords(allCoords);
    const color = ROUTE_PALETTE[simpleHash(filename) % ROUTE_PALETTE.length];

    return { fileId, filename, displayName, date, lengthKm, bbox, color, geojson: fc };
}
