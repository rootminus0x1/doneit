/**
 * GPX metadata extraction — single implementation used by both the browser
 * (imported by gpxParser.ts) and the Python build script (via gpx-meta-cli.ts).
 *
 * Uses only string operations — no DOM or Node APIs.
 */

export interface GpxMeta {
    displayName: string | null;
    trackType: string | null;
    datetime: string | null;
    linkText: string | null;
}

/**
 * Extract text content of a nested XML element by local tag names,
 * ignoring namespace prefixes.
 *
 * findGpxText(xml, 'trk', 'name')  ≡  extractText(doc, 'trk > name')
 */
export function findGpxText(xml: string, ...path: string[]): string | null {
    let src = xml;
    for (const tag of path) {
        const openRe = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>`, 'i');
        const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, 'i');
        const openMatch = openRe.exec(src);
        if (!openMatch) return null;
        const after = src.slice(openMatch.index + openMatch[0].length);
        const closeMatch = closeRe.exec(after);
        if (!closeMatch) return null;
        src = after.slice(0, closeMatch.index);
    }
    return src.trim() || null;
}

/** Extract all standard metadata from a raw GPX XML string. */
export function parseGpxMeta(xml: string): GpxMeta {
    return {
        displayName: findGpxText(xml, 'trk', 'name') ?? findGpxText(xml, 'name'),
        trackType: findGpxText(xml, 'trk', 'type'),
        datetime: findGpxText(xml, 'metadata', 'time') ?? findGpxText(xml, 'trkpt', 'time'),
        linkText: findGpxText(xml, 'metadata', 'link', 'text'),
    };
}
