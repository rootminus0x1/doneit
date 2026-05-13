import { gpx } from '@tmcw/togeojson';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';

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

function extractText(doc: Document, selector: string): string | null {
    const el = doc.querySelector(selector);
    return el?.textContent?.trim() || null;
}

export function parseTrackGpx(gpxText: string, fallbackName: string): ParsedTrack {
    const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error(`Invalid GPX: ${parseError.textContent?.trim().slice(0, 120)}`);
    const geojson = gpx(doc) as FeatureCollection;

    const trackFeatures = geojson.features.filter((f): f is Feature<LineString> => f.geometry?.type === 'LineString');

    const allCoords = trackFeatures.flatMap(f => f.geometry.coordinates as number[][]);
    const bbox = allCoords.length > 0 ? bboxFromCoords(allCoords) : { west: 0, east: 0, south: 0, north: 0 };

    const displayName = extractText(doc, 'trk > name') || extractText(doc, 'name') || fallbackName;

    const dateStr = extractText(doc, 'metadata > time') || extractText(doc, 'trkpt > time') || null;

    const date = dateStr ? dateStr.slice(0, 10) : null;

    return {
        geojson: { type: 'FeatureCollection', features: trackFeatures },
        bbox,
        displayName,
        date,
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
