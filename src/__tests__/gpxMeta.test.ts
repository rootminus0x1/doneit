import { describe, it, expect } from 'vitest';
import { findGpxText, parseGpxMeta } from '../lib/gpxMeta';

const TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect">
  <metadata>
    <time>2024-06-15T09:30:00Z</time>
    <link href="https://connect.garmin.com/activity/12345">
      <text>Ben Nevis</text>
    </link>
  </metadata>
  <trk>
    <name>Morning Hike</name>
    <type>hiking</type>
    <trkseg>
      <trkpt lat="56.7969" lon="-4.9976"><ele>1345</ele><time>2024-06-15T09:30:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const NAMESPACED_GPX = `<?xml version="1.0"?>
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:trk>
    <gpx:name>Namespaced Track</gpx:name>
    <gpx:type>walking</gpx:type>
  </gpx:trk>
</gpx:gpx>`;

describe('findGpxText', () => {
    it('extracts the first matching element in document order', () => {
        // The first <name> in the document is the track name, not the link text
        expect(findGpxText(TRACK_GPX, 'name')).toBe('Morning Hike');
    });

    it('extracts a nested element', () => {
        expect(findGpxText(TRACK_GPX, 'trk', 'name')).toBe('Morning Hike');
    });

    it('extracts a doubly-nested element', () => {
        expect(findGpxText(TRACK_GPX, 'metadata', 'link', 'text')).toBe('Ben Nevis');
    });

    it('extracts the track type', () => {
        expect(findGpxText(TRACK_GPX, 'trk', 'type')).toBe('hiking');
    });

    it('extracts metadata time', () => {
        expect(findGpxText(TRACK_GPX, 'metadata', 'time')).toBe('2024-06-15T09:30:00Z');
    });

    it('returns null for missing element', () => {
        expect(findGpxText(TRACK_GPX, 'nonexistent')).toBeNull();
    });

    it('returns null for missing nested element', () => {
        expect(findGpxText(TRACK_GPX, 'trk', 'desc')).toBeNull();
    });

    it('handles namespace prefixes', () => {
        expect(findGpxText(NAMESPACED_GPX, 'trk', 'name')).toBe('Namespaced Track');
        expect(findGpxText(NAMESPACED_GPX, 'trk', 'type')).toBe('walking');
    });
});

describe('parseGpxMeta', () => {
    it('extracts all fields from a complete GPX', () => {
        const meta = parseGpxMeta(TRACK_GPX);
        expect(meta.displayName).toBe('Morning Hike');
        expect(meta.trackType).toBe('hiking');
        expect(meta.datetime).toBe('2024-06-15T09:30:00Z');
        expect(meta.linkText).toBe('Ben Nevis');
    });

    it('returns nulls for a minimal GPX', () => {
        const minimal = '<gpx><trk><trkseg><trkpt lat="0" lon="0"/></trkseg></trk></gpx>';
        const meta = parseGpxMeta(minimal);
        expect(meta.displayName).toBeNull();
        expect(meta.trackType).toBeNull();
        expect(meta.datetime).toBeNull();
        expect(meta.linkText).toBeNull();
    });

    it('falls back to top-level name when trk/name is absent', () => {
        const gpx = '<gpx><name>Fallback Name</name><trk><trkseg/></trk></gpx>';
        expect(parseGpxMeta(gpx).displayName).toBe('Fallback Name');
    });
});
