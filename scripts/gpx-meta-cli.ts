/**
 * CLI entry point used by build_pmtiles.py.
 * Reads each GPX file passed as an argument and writes a JSON array of
 * GpxMeta objects to stdout — one entry per file, in argument order.
 *
 * Usage: tsx scripts/gpx-meta-cli.ts file1.gpx file2.gpx ...
 */
import { readFileSync } from 'node:fs';
import { parseGpxMeta } from '../src/lib/gpxMeta';

const results = process.argv.slice(2).map(filepath => {
    const xml = readFileSync(filepath, 'utf-8');
    return parseGpxMeta(xml);
});

process.stdout.write(JSON.stringify(results) + '\n');
