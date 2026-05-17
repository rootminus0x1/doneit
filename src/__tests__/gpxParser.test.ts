import { describe, it, expect } from 'vitest';
import { filenameToCategoryLabel, parsePeaksGpx, parseTrackGpx } from '../lib/gpxParser';

const PEAKS_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <wpt lat="56.7969" lon="-4.9976"><ele>1345</ele><name>Ben Nevis</name></wpt>
  <wpt lat="56.8218" lon="-4.9496"><ele>1220</ele><name>Carn Mor Dearg</name></wpt>
</gpx>`;

const TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Ridge Walk</name>
    <type>hiking</type>
    <trkseg>
      <trkpt lat="56.7969" lon="-4.9976"><ele>1345</ele></trkpt>
      <trkpt lat="56.8000" lon="-4.9800"><ele>1200</ele></trkpt>
      <trkpt lat="56.8218" lon="-4.9496"><ele>1220</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('filenameToCategoryLabel', () => {
    it('strips .gpx and title-cases words', () => {
        expect(filenameToCategoryLabel('munros.gpx')).toBe('Munros');
    });

    it('converts hyphens to spaces', () => {
        expect(filenameToCategoryLabel('munro-tops.gpx')).toBe('Munro Tops');
    });

    it('converts underscores to spaces', () => {
        expect(filenameToCategoryLabel('mountain_peaks.gpx')).toBe('Mountain Peaks');
    });

    it('handles mixed separators', () => {
        expect(filenameToCategoryLabel('my-great_hills.gpx')).toBe('My Great Hills');
    });

    it('handles a name without extension', () => {
        expect(filenameToCategoryLabel('corbetts')).toBe('Corbetts');
    });
});

describe('parsePeaksGpx', () => {
    it('extracts waypoints as Point features', () => {
        const result = parsePeaksGpx(PEAKS_GPX, 'munros');
        expect(result.category).toBe('munros');
        expect(result.geojson.type).toBe('FeatureCollection');
        expect(result.geojson.features).toHaveLength(2);
        expect(result.geojson.features[0].geometry.type).toBe('Point');
    });

    it('preserves peak names in properties', () => {
        const result = parsePeaksGpx(PEAKS_GPX, 'munros');
        const names = result.geojson.features.map(f => f.properties?.name);
        expect(names).toContain('Ben Nevis');
        expect(names).toContain('Carn Mor Dearg');
    });

    it('sets coordinates as [lon, lat]', () => {
        const result = parsePeaksGpx(PEAKS_GPX, 'munros');
        const [lon, lat] = result.geojson.features[0].geometry.coordinates as number[];
        expect(lon).toBeCloseTo(-4.9976, 4);
        expect(lat).toBeCloseTo(56.7969, 4);
    });

    it('returns empty feature collection for GPX with no waypoints', () => {
        const gpx = '<gpx version="1.1"><trk><trkseg/></trk></gpx>';
        const result = parsePeaksGpx(gpx, 'munros');
        expect(result.geojson.features).toHaveLength(0);
    });

    it('throws on invalid XML', () => {
        expect(() => parsePeaksGpx('<not valid xml<<<', 'munros')).toThrow();
    });
});

describe('parseTrackGpx', () => {
    it('returns a LineString feature collection', () => {
        const result = parseTrackGpx(TRACK_GPX, 'fallback');
        expect(result.geojson.features).toHaveLength(1);
        expect(result.geojson.features[0].geometry.type).toBe('LineString');
    });

    it('extracts display name from trk/name', () => {
        expect(parseTrackGpx(TRACK_GPX, 'fallback').displayName).toBe('Ridge Walk');
    });

    it('falls back to provided name when trk/name is absent', () => {
        const gpx = '<gpx><trk><trkseg><trkpt lat="0" lon="0"/></trkseg></trk></gpx>';
        expect(parseTrackGpx(gpx, 'activity_1234').displayName).toBe('activity_1234');
    });

    it('computes a bounding box that contains all track points', () => {
        const { bbox } = parseTrackGpx(TRACK_GPX, 'fallback');
        expect(bbox.west).toBeCloseTo(-4.9976, 4);
        expect(bbox.east).toBeCloseTo(-4.9496, 4);
        expect(bbox.south).toBeCloseTo(56.7969, 4);
        expect(bbox.north).toBeCloseTo(56.8218, 4);
    });

    it('extracts track type', () => {
        expect(parseTrackGpx(TRACK_GPX, 'fallback').trackType).toBe('hiking');
    });
});
