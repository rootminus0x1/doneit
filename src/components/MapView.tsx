import { useEffect, useRef, useState } from 'react';
import maplibregl, { type LngLatBoundsLike, type StyleSpecification, type SourceSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../lib/drivepmtiles'; // registers pmtiles:// protocol with MapLibre
import type { TileSource } from '../lib/tileConfig';
import { buildRasterStyle } from '../lib/tileConfig';
import type { TrackCategory, PeakShape } from '../hooks/useDriveData';
import type { LoadedTrack } from '../hooks/useViewportTracks';
import type { FeatureCollection, Point } from 'geojson';
import type { TrackBbox } from '../lib/gpxParser';

function generatePeakIcon(shape: PeakShape, color: string, strokeColor: string, radius: number): ImageData {
    const dim = Math.ceil(radius * 2 + 4);
    const canvas = document.createElement('canvas');
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d')!;
    const cx = dim / 2;
    const cy = dim / 2;
    const r = radius - 0.75; // inset slightly so stroke doesn't clip

    ctx.fillStyle = color;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (shape === 'circle') {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (shape === 'triangle') {
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * Math.sin((2 * Math.PI) / 3), cy - r * Math.cos((2 * Math.PI) / 3));
        ctx.lineTo(cx + r * Math.sin((4 * Math.PI) / 3), cy - r * Math.cos((4 * Math.PI) / 3));
        ctx.closePath();
    } else if (shape === 'square') {
        const h = r * 0.9;
        ctx.rect(cx - h, cy - h, h * 2, h * 2);
    } else {
        // diamond
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * 0.75, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r * 0.75, cy);
        ctx.closePath();
    }

    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, dim, dim);
}

function styleFor(source: TileSource): string | StyleSpecification {
    return source.type === 'raster' ? (buildRasterStyle(source) as StyleSpecification) : source.styleUrl!;
}

export interface TrackPopupData {
    displayName: string;
    trackType: string | null;
    filename: string;
    datetime: string | null;
    linkText: string | null;
    fileId: string | null;
    lengthKm: number | null;
}

export interface LoadedPeaks {
    category: string;
    geojson: FeatureCollection<Point>;
    color: string;
    strokeColor: string;
    radius: number;
    opacity: number;
    shape: PeakShape;
}

export interface PeakCategory {
    name: string;
    color: string;
    strokeColor: string;
    radius: number;
    opacity: number;
    shape: PeakShape;
}

interface Props {
    source: TileSource;
    initialCenter: [number, number];
    initialZoom: number;
    categories: TrackCategory[];
    loadedTracks: LoadedTrack[];
    loadedPeaks: LoadedPeaks[];
    overlays: TileSource[];
    tracksPmtilesFileId?: string;
    peaksPmtilesFileId?: string;
    peakCategories: PeakCategory[];
    onBoundsChange: (bounds: TrackBbox) => void;
    onMove: (center: [number, number], zoom: number) => void;
    onTrackClick: (data: TrackPopupData) => void;
    onTrackHover: (data: TrackPopupData | null) => void;
    onPeakClick: (name: string, elevation: number, category: string, lat: number, lng: number) => void;
    onPeakHover?: (name: string, elevation: number, category: string, lat: number, lng: number) => void;
    baggedSet: Set<string>;
    onPeakHoverEnd?: () => void;
    onBearingChange?: (bearing: number) => void;
    northTrigger?: number;
    onError: (message: string) => void;
    onStyleLoad?: (sourceId: string) => void;
    onStyleFail?: (message: string) => void;
    flyToBbox?: TrackBbox | null;
    hiddenCategories: string[];
    hiddenTrackTypes: string[];
    hiddenPeakCategories: string[];
    hiddenOverlays: string[];
}

// Copies track/peak/overlay sources and layers from the previous style into the next one
// so they remain visible throughout a style switch.
const PMTILES_SOURCE = 'tracks-pmtiles';
const trackPmtilesLayerId = (cat: string) => `tracks-pmtiles-${cat}`;
const PEAKS_PMTILES_SOURCE = 'peaks-pmtiles';
const peakPmtilesLayerId = (name: string) => `peaks-pmtiles-symbol-${name}`;
const overlaySourceId = (id: string) => `overlay-${id}`;
const overlayLayerId = (id: string) => `overlay-${id}`; // single-color (no lineStyle)
const overlayOuterLayerId = (id: string) => `overlay-${id}-outer`;
const overlayInnerLayerId = (id: string) => `overlay-${id}-inner`;

// True on touch-only devices (phones/tablets with no mouse hover support).
// Used to skip mouseenter/mouseleave handlers that are meaningless on touch.
const IS_TOUCH = window.matchMedia('(hover: none)').matches;

const DONE_TICK_LAYOUT = {
    'text-field': '✔',
    'text-size': 25,
    'text-anchor': 'center' as const,
    'text-offset': [0.15, -0.2] as [number, number],
    'text-allow-overlap': true,
    'text-ignore-placement': true,
};

const DONE_TICK_PAINT = {
    'text-color': '#000000',
    'text-halo-color': '#ffffff',
    'text-halo-width': 1,
};

// Scale peak icons with zoom: small at overview, full-size when zoomed in
const PEAK_ICON_SIZE = [
    'interpolate',
    ['linear'],
    ['zoom'],
    7,
    0.4,
    11,
    0.9,
    15,
    1.5,
] as unknown as maplibregl.ExpressionSpecification;

function preserveCustomLayers(prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
    if (!prev) return next;
    const customSources: Record<string, SourceSpecification> = {};
    for (const [id, src] of Object.entries(prev.sources ?? {})) {
        if (
            id.startsWith('track-') ||
            id.startsWith('peaks-') ||
            id === PMTILES_SOURCE ||
            id === PEAKS_PMTILES_SOURCE ||
            id.startsWith('overlay-')
        ) {
            customSources[id] = src as SourceSpecification;
        }
    }
    const customLayers = (prev.layers ?? []).filter(
        l =>
            l.id.startsWith('track-line-') ||
            l.id.startsWith('peaks-') ||
            l.id.startsWith('tracks-pmtiles-') ||
            l.id.startsWith('overlay-'),
    );
    return {
        ...next,
        sources: { ...next.sources, ...customSources },
        layers: [...next.layers, ...customLayers],
    };
}

function buildTrackPopup(props: Record<string, unknown>): TrackPopupData {
    return {
        displayName: String(props.display_name ?? ''),
        trackType: props.track_type ? String(props.track_type) : null,
        filename: String(props.filename ?? ''),
        datetime: props.datetime ? String(props.datetime) : null,
        linkText: props.link_text ? String(props.link_text) : null,
        fileId: props.file_id ? String(props.file_id) : null,
        lengthKm: typeof props.length_km === 'number' ? props.length_km : null,
    };
}

export function MapView({
    source,
    initialCenter,
    initialZoom,
    categories,
    loadedTracks,
    loadedPeaks,
    overlays,
    tracksPmtilesFileId,
    peaksPmtilesFileId,
    peakCategories,
    onBoundsChange,
    onMove,
    onTrackClick,
    onTrackHover,
    onPeakClick,
    onPeakHover,
    onPeakHoverEnd,
    onBearingChange,
    northTrigger,
    onError,
    onStyleLoad,
    onStyleFail,
    flyToBbox,
    hiddenCategories,
    hiddenTrackTypes,
    hiddenPeakCategories,
    hiddenOverlays,
    baggedSet,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    // Tracks which source the map is currently showing, to skip redundant setStyle calls
    const loadedSourceIdRef = useRef<string | null>(null);

    // Stable callback refs — updates never re-run the init effect
    const onBoundsChangeRef = useRef(onBoundsChange);
    const onMoveRef = useRef(onMove);
    const onTrackClickRef = useRef(onTrackClick);
    const onTrackHoverRef = useRef(onTrackHover);
    const onPeakClickRef = useRef(onPeakClick);
    const onPeakHoverRef = useRef(onPeakHover);
    const onPeakHoverEndRef = useRef(onPeakHoverEnd);
    const onBearingChangeRef = useRef(onBearingChange);
    const onErrorRef = useRef(onError);
    const onStyleLoadRef = useRef(onStyleLoad);
    const onStyleFailRef = useRef(onStyleFail);
    useEffect(() => {
        onBoundsChangeRef.current = onBoundsChange;
    });
    useEffect(() => {
        onMoveRef.current = onMove;
    });
    useEffect(() => {
        onTrackClickRef.current = onTrackClick;
    });
    useEffect(() => {
        onTrackHoverRef.current = onTrackHover;
    });
    useEffect(() => {
        onPeakClickRef.current = onPeakClick;
    });
    useEffect(() => {
        onPeakHoverRef.current = onPeakHover;
    });
    useEffect(() => {
        onPeakHoverEndRef.current = onPeakHoverEnd;
    });
    useEffect(() => {
        onBearingChangeRef.current = onBearingChange;
    });
    useEffect(() => {
        onErrorRef.current = onError;
    });
    useEffect(() => {
        onStyleLoadRef.current = onStyleLoad;
    });
    useEffect(() => {
        onStyleFailRef.current = onStyleFail;
    });

    // Increments whenever the style finishes loading, triggering layer effects
    const [mapVersion, setMapVersion] = useState(0);
    // True once style.load has fired at least once — used to suppress tile-level error noise
    const styleLoadedRef = useRef(false);

    // Create the map once. Destroyed only on unmount — style switches use setStyle below.
    useEffect(() => {
        if (!containerRef.current) return;

        const map = new maplibregl.Map({
            container: containerRef.current,
            style: styleFor(source),
            center: initialCenter,
            zoom: initialZoom,
            attributionControl: false,
        });

        map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
        mapRef.current = map;
        loadedSourceIdRef.current = source.id;

        map.on('moveend', () => {
            const c = map.getCenter();
            onMoveRef.current([c.lng, c.lat], map.getZoom());
            const b = map.getBounds();
            onBoundsChangeRef.current({
                west: b.getWest(),
                east: b.getEast(),
                south: b.getSouth(),
                north: b.getNorth(),
            });
        });

        map.on('rotate', () => {
            onBearingChangeRef.current?.(map.getBearing());
        });

        map.on('error', e => {
            // Only surface errors before the first style.load — after that, errors are mostly
            // transient tile fetch failures (404, rate limit) which the user can't action.
            if (!styleLoadedRef.current) {
                onErrorRef.current(e.error?.message ?? 'Map error');
            } else {
                console.error('[MapView]', e.error?.message ?? e);
            }
        });

        // style.load fires on initial load AND after every setStyle call
        map.on('style.load', () => {
            styleLoadedRef.current = true;
            onStyleLoadRef.current?.(loadedSourceIdRef.current!);
            const b = map.getBounds();
            onBoundsChangeRef.current({
                west: b.getWest(),
                east: b.getEast(),
                south: b.getSouth(),
                north: b.getNorth(),
            });
            setMapVersion(v => v + 1);
        });

        return () => {
            map.remove();
            mapRef.current = null;
            loadedSourceIdRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Reset north when northTrigger increments
    useEffect(() => {
        if (!northTrigger) return;
        mapRef.current?.resetNorth({ animate: true });
    }, [northTrigger]);

    // When the source prop changes, update the style in place — no remount.
    // For vector sources, fetch and validate the style URL before calling setStyle so a
    // bad URL never reaches MapLibre (which can hang internally without emitting an error).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || loadedSourceIdRef.current === source.id) return;

        if ((source.type === 'vector' || source.type === 'pmtiles-drive') && source.styleUrl) {
            const controller = new AbortController();
            fetch(source.styleUrl, { signal: controller.signal })
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json() as Promise<unknown>;
                })
                .then(json => {
                    if (controller.signal.aborted) return;
                    if (typeof (json as Record<string, unknown>).version !== 'number') {
                        throw new Error('Response is not a MapLibre style document');
                    }
                    loadedSourceIdRef.current = source.id;
                    map.setStyle(source.styleUrl!, {
                        transformStyle: preserveCustomLayers,
                    });
                })
                .catch((err: unknown) => {
                    if ((err as { name?: string }).name === 'AbortError') return;
                    const msg = err instanceof Error ? err.message : String(err);
                    onStyleFailRef.current?.(`Cannot load "${source.label}": ${msg}`);
                });
            return () => {
                controller.abort();
            };
        }

        loadedSourceIdRef.current = source.id;
        map.setStyle(styleFor(source), { transformStyle: preserveCustomLayers });
    }, [source]);

    // Add pmtiles-overlay sources and line layers — must run before track/peak layers
    // so overlays render below tracks and peaks in MapLibre's layer order.
    // Overlays with lineStyle get two stacked layers (outer halo + inner colour);
    // overlays without lineStyle get a single layer.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0) return;
        for (const ov of overlays) {
            if (!ov.fileId || !ov.sourceLayer) continue;
            const srcId = overlaySourceId(ov.id);
            if (!map.getSource(srcId)) {
                map.addSource(srcId, { type: 'vector', url: `pmtiles://${ov.fileId}` });
            }
            const filter = ov.overlayFilter
                ? { filter: ['==', ['get', 'row_type'], ov.overlayFilter] as unknown as maplibregl.FilterSpecification }
                : {};
            const minzoom = ov.overlayMinZoom !== undefined ? { minzoom: ov.overlayMinZoom } : {};

            if (ov.lineStyle) {
                const outerId = overlayOuterLayerId(ov.id);
                const innerId = overlayInnerLayerId(ov.id);
                if (!map.getLayer(outerId)) {
                    map.addLayer({
                        id: outerId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.lineStyle.outerColor,
                            'line-width': ov.lineStyle.outerWidth,
                            'line-opacity': ov.lineStyle.outerOpacity,
                        },
                    });
                }
                if (!map.getLayer(innerId)) {
                    map.addLayer({
                        id: innerId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.lineStyle.innerColor,
                            'line-width': ov.lineStyle.innerWidth,
                            'line-opacity': 1,
                        },
                    });
                }
            } else {
                const layId = overlayLayerId(ov.id);
                if (!map.getLayer(layId)) {
                    map.addLayer({
                        id: layId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.overlayColor ?? '#e8a020',
                            'line-width': ov.overlayWidth ?? 1.5,
                            'line-opacity': ov.overlayOpacity ?? 0.75,
                        },
                    });
                }
            }
        }
    }, [overlays, mapVersion]);

    // Sync track layers — reruns when tracks change or after style loads
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0) return;

        const catLookup: Record<string, TrackCategory> = Object.fromEntries(categories.map(c => [c.name, c]));

        for (const track of loadedTracks) {
            const sid = `track-${track.fileId}`;
            const lid = `track-line-${track.fileId}`;
            const cat = catLookup[track.category];
            if (!cat) {
                console.warn(
                    `Skipping track ${track.fileId}: unknown category "${track.category}" — rebuild index to fix`,
                );
                continue;
            }

            if (!map.getSource(sid)) {
                map.addSource(sid, { type: 'geojson', data: track.geojson });
                map.addLayer({
                    id: lid,
                    type: 'line',
                    source: sid,
                    paint: {
                        'line-color': cat.color,
                        'line-width': cat.width,
                        'line-opacity': cat.opacity,
                        ...(cat.dashArray ? { 'line-dasharray': cat.dashArray } : {}),
                    },
                });
                map.on('click', lid, e => {
                    if (e.features?.[0])
                        onTrackClickRef.current({
                            displayName: track.displayName,
                            trackType: track.trackType,
                            filename: track.filename,
                            datetime: track.datetime,
                            linkText: track.linkText,
                            fileId: track.fileId,
                            lengthKm: null,
                        });
                });
                if (!IS_TOUCH) {
                    map.on('mouseenter', lid, e => {
                        map.getCanvas().style.cursor = 'pointer';
                        if (e.features?.[0])
                            onTrackHoverRef.current({
                                displayName: track.displayName,
                                trackType: track.trackType,
                                filename: track.filename,
                                datetime: track.datetime,
                                linkText: track.linkText,
                                fileId: track.fileId,
                                lengthKm: null,
                            });
                    });
                    map.on('mouseleave', lid, () => {
                        map.getCanvas().style.cursor = '';
                        onTrackHoverRef.current(null);
                    });
                }
            }
        }
    }, [loadedTracks, categories, mapVersion]);

    // Register peak icon images — must run before layer effects and after every style reload
    // (setStyle clears all custom images from the map)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0) return;

        const addOrUpdate = (name: string, shape: PeakShape, color: string, strokeColor: string, radius: number) => {
            const img = generatePeakIcon(shape, color, strokeColor, radius);
            if (map.hasImage(name)) map.removeImage(name);
            map.addImage(name, img);
        };

        addOrUpdate('peak-icon-default', 'circle', '#888888', '#ffffff', 5);
        for (const pc of peakCategories) {
            addOrUpdate(`peak-icon-${pc.name}`, pc.shape, pc.color, pc.strokeColor, pc.radius);
        }
        for (const ps of loadedPeaks) {
            addOrUpdate(`peak-icon-${ps.category}`, ps.shape, ps.color, ps.strokeColor, ps.radius);
        }
    }, [peakCategories, loadedPeaks, mapVersion]);

    // Add GeoJSON peak layers (fallback when no peaks PMTiles).
    // Reversed so the first category in the list ends up on top (last-added = highest z-order).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0) return;

        for (const ps of [...loadedPeaks].reverse()) {
            const sid = `peaks-${ps.category}`;
            const lid = `peaks-symbol-${ps.category}`;

            if (!map.getSource(sid)) {
                map.addSource(sid, { type: 'geojson', data: ps.geojson });
                map.addLayer({
                    id: lid,
                    type: 'symbol',
                    source: sid,
                    layout: {
                        'icon-image': `peak-icon-${ps.category}`,
                        'icon-size': PEAK_ICON_SIZE,
                        'icon-allow-overlap': true,
                    },
                });
                if (IS_TOUCH) {
                    map.on('click', lid, e => {
                        const f = e.features?.[0];
                        if (f) {
                            const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                            onPeakClickRef.current(
                                f.properties?.name ?? '',
                                f.properties?.ele ?? 0,
                                ps.category,
                                coords[1],
                                coords[0],
                            );
                        }
                    });
                } else {
                    map.on('mouseenter', lid, e => {
                        map.getCanvas().style.cursor = 'pointer';
                        const f = e.features?.[0];
                        if (f) {
                            const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                            onPeakHoverRef.current?.(
                                f.properties?.name ?? '',
                                f.properties?.ele ?? 0,
                                ps.category,
                                coords[1],
                                coords[0],
                            );
                        }
                    });
                    map.on('mouseleave', lid, () => {
                        map.getCanvas().style.cursor = '';
                        onPeakHoverEndRef.current?.();
                    });
                }
            }
        }
    }, [loadedPeaks, mapVersion]);

    // Add peaks PMTiles source and one symbol layer per category.
    // Reversed so the first category in the list ends up on top (last-added = highest z-order).
    // Deps include peakCategories: when they arrive after peaksPmtilesFileId, this re-runs
    // and adds the category layers (source already present, each layer guarded by getLayer check).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0 || !peaksPmtilesFileId) return;

        if (!map.getSource(PEAKS_PMTILES_SOURCE)) {
            map.addSource(PEAKS_PMTILES_SOURCE, {
                type: 'vector',
                url: `pmtiles://${peaksPmtilesFileId}`,
            });
        }

        for (const pc of [...peakCategories].reverse()) {
            const lid = peakPmtilesLayerId(pc.name);
            if (map.getLayer(lid)) continue;
            map.addLayer({
                id: lid,
                type: 'symbol',
                source: PEAKS_PMTILES_SOURCE,
                'source-layer': 'peaks',
                filter: ['==', ['get', 'category'], pc.name] as unknown as maplibregl.FilterSpecification,
                layout: {
                    'icon-image': `peak-icon-${pc.name}` as unknown as maplibregl.ExpressionSpecification,
                    'icon-size': PEAK_ICON_SIZE,
                    'icon-allow-overlap': true,
                },
            });
            if (IS_TOUCH) {
                map.on('click', lid, e => {
                    const f = e.features?.[0];
                    if (f) {
                        const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                        onPeakClickRef.current(
                            f.properties?.name ?? '',
                            f.properties?.ele ?? 0,
                            pc.name,
                            coords[1],
                            coords[0],
                        );
                    }
                });
            } else {
                map.on('mouseenter', lid, e => {
                    map.getCanvas().style.cursor = 'pointer';
                    const f = e.features?.[0];
                    if (f) {
                        const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                        onPeakHoverRef.current?.(
                            f.properties?.name ?? '',
                            f.properties?.ele ?? 0,
                            pc.name,
                            coords[1],
                            coords[0],
                        );
                    }
                });
                map.on('mouseleave', lid, () => {
                    map.getCanvas().style.cursor = '';
                    onPeakHoverEndRef.current?.();
                });
            }

            const doneLid = `${lid}-done-tick`;
            if (!map.getLayer(doneLid)) {
                map.addLayer({
                    id: doneLid,
                    type: 'symbol',
                    source: PEAKS_PMTILES_SOURCE,
                    'source-layer': 'peaks',
                    filter: [
                        'all',
                        ['==', ['get', 'category'], pc.name],
                        ['in', ['get', 'name'], ['literal', []]],
                    ] as unknown as maplibregl.FilterSpecification,
                    layout: DONE_TICK_LAYOUT,
                    paint: DONE_TICK_PAINT,
                });
            }
        }
    }, [peaksPmtilesFileId, peakCategories, mapVersion]);

    // Toggle PMTiles peak layer visibility per category
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        for (const pc of peakCategories) {
            const lid = peakPmtilesLayerId(pc.name);
            const vis = hiddenPeakCategories.includes(pc.name) ? 'none' : 'visible';
            if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
            const doneLid = `${lid}-done-tick`;
            if (map.getLayer(doneLid)) map.setLayoutProperty(doneLid, 'visibility', vis);
        }
    }, [peakCategories, hiddenPeakCategories, mapVersion]);

    // Update done-tick filter on PMTiles peak layers whenever baggedSet changes.
    // Uses ['in', name, ['literal', names]] so coordinates come from PMTiles, not client state.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0 || !peaksPmtilesFileId) return;
        for (const pc of peakCategories) {
            const doneLid = `${peakPmtilesLayerId(pc.name)}-done-tick`;
            if (!map.getLayer(doneLid)) continue;
            const doneNames = [...baggedSet]
                .filter(k => k.startsWith(`${pc.name}:`))
                .map(k => k.slice(pc.name.length + 1));
            map.setFilter(doneLid, [
                'all',
                ['==', ['get', 'category'], pc.name],
                ['in', ['get', 'name'], ['literal', doneNames]],
            ] as unknown as maplibregl.FilterSpecification);
        }
    }, [baggedSet, peakCategories, peaksPmtilesFileId, mapVersion]);

    // Sync PMTiles tracks overlay — one layer per category so dashArray can vary.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0 || !tracksPmtilesFileId) return;

        if (!map.getSource(PMTILES_SOURCE)) {
            map.addSource(PMTILES_SOURCE, {
                type: 'vector',
                url: `pmtiles://${tracksPmtilesFileId}`,
            });
        }

        for (const cat of categories) {
            const lid = trackPmtilesLayerId(cat.name);
            if (map.getLayer(lid)) continue;
            map.addLayer({
                id: lid,
                type: 'line',
                source: PMTILES_SOURCE,
                'source-layer': 'tracks',
                filter: ['==', ['get', 'category'], cat.name] as unknown as maplibregl.FilterSpecification,
                paint: {
                    'line-color': cat.color,
                    'line-width': cat.width,
                    'line-opacity': cat.opacity,
                    ...(cat.dashArray ? { 'line-dasharray': cat.dashArray } : {}),
                },
            });
            map.on('click', lid, e => {
                const props = e.features?.[0]?.properties;
                if (props) onTrackClickRef.current(buildTrackPopup(props));
            });
            if (!IS_TOUCH) {
                map.on('mouseenter', lid, e => {
                    map.getCanvas().style.cursor = 'pointer';
                    const props = e.features?.[0]?.properties;
                    if (props) onTrackHoverRef.current(buildTrackPopup(props));
                });
                map.on('mouseleave', lid, () => {
                    map.getCanvas().style.cursor = '';
                    onTrackHoverRef.current(null);
                });
            }
        }
    }, [tracksPmtilesFileId, categories, mapVersion]);

    // Sync overlay visibility when hiddenOverlays changes.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        for (const ov of overlays) {
            const vis = hiddenOverlays.includes(ov.id) ? 'none' : 'visible';
            if (ov.lineStyle) {
                const outerId = overlayOuterLayerId(ov.id);
                const innerId = overlayInnerLayerId(ov.id);
                if (map.getLayer(outerId)) map.setLayoutProperty(outerId, 'visibility', vis);
                if (map.getLayer(innerId)) map.setLayoutProperty(innerId, 'visibility', vis);
            } else {
                const layId = overlayLayerId(ov.id);
                if (map.getLayer(layId)) map.setLayoutProperty(layId, 'visibility', vis);
            }
        }
    }, [overlays, hiddenOverlays, mapVersion]);

    // Toggle PMTiles track layer visibility per category; apply track-type filter.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const typeFilter =
            hiddenTrackTypes.length > 0 ? ['!', ['in', ['get', 'track_type'], ['literal', hiddenTrackTypes]]] : null;
        for (const cat of categories) {
            const lid = trackPmtilesLayerId(cat.name);
            if (!map.getLayer(lid)) continue;
            map.setLayoutProperty(lid, 'visibility', hiddenCategories.includes(cat.name) ? 'none' : 'visible');
            const baseFilter = ['==', ['get', 'category'], cat.name];
            map.setFilter(
                lid,
                (typeFilter ? ['all', baseFilter, typeFilter] : baseFilter) as maplibregl.FilterSpecification,
            );
        }
    }, [hiddenCategories, hiddenTrackTypes, categories, mapVersion]);

    // Fly to bbox
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !flyToBbox) return;
        const { west, east, south, north } = flyToBbox;
        map.fitBounds([west, south, east, north] as LngLatBoundsLike, {
            padding: 40,
        });
    }, [flyToBbox]);

    return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
