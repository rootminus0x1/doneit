import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification, type SourceSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Compass } from 'maplibre-compass-pro';
import 'maplibre-compass-pro/dist/style.css';
import '../lib/drivepmtiles'; // registers pmtiles:// protocol with MapLibre
import type { TileSource } from '../lib/tileConfig';
import { buildRasterStyle } from '../lib/tileConfig';
import type { TrackCategory, PeakShape } from '../hooks/useDriveData';
import type { LoadedTrack } from '../hooks/useViewportTracks';
import type { FeatureCollection, Geometry, Point } from 'geojson';
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

interface TrackPopupData {
    displayName: string;
    trackType: string | null;
    category: string;
    filename: string;
    datetime: string | null;
    linkText: string | null;
    fileId: string | null;
    lengthKm: number | null;
    ascentM: number | null;
    durationS: number | null;
    movingTimeS: number | null;
}

interface OverlayPopupData {
    overlayId: string;
    overlayLabel: string;
    name: string | null;
    rowType: string | null;
    authorityName: string | null;
    lengthKm: number | null;
}

export type PopupData =
    | ({ kind: 'track' } & TrackPopupData)
    | { kind: 'peak'; name: string; elevation: number; category: string; lat: number; lng: number }
    | ({ kind: 'overlay' } & OverlayPopupData);

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
    onFeatureClick: (data: PopupData) => void;
    onFeatureHover: (data: PopupData | null) => void;
    baggedSet: Set<string>;
    onPeakHoverEnd?: () => void;
    onError: (message: string) => void;
    onStyleLoad?: (sourceId: string) => void;
    onStyleFail?: (message: string) => void;
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
const HIGHLIGHT_SOURCE = 'highlight-line';
const HIGHLIGHT_GLOW_LAYER = 'highlight-line-glow';
const HIGHLIGHT_LAYER = 'highlight-line';
export const HIGHLIGHT_COLOR = '#06b6d4';

const HEADING_SOURCE = 'user-heading-cone';
const HEADING_LAYER = 'user-heading-cone-fill';

function buildHeadingCone(lng: number, lat: number, headingDeg: number): GeoJSON.FeatureCollection {
    const toRad = Math.PI / 180;
    const radiusM = 80;
    const halfWidthDeg = 30;
    const steps = 24;
    const coords: [number, number][] = [[lng, lat]];
    for (let i = 0; i <= steps; i++) {
        const bearing = (headingDeg - halfWidthDeg + (2 * halfWidthDeg * i / steps)) * toRad;
        const dLat = (radiusM / 111320) * Math.cos(bearing);
        const dLng = (radiusM / (111320 * Math.cos(lat * toRad))) * Math.sin(bearing);
        coords.push([lng + dLng, lat + dLat]);
    }
    coords.push([lng, lat]);
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} }] };
}

// True on touch-only devices (phones/tablets with no mouse hover support).
// Used to skip mouseenter/mouseleave handlers that are meaningless on touch.
const IS_TOUCH = window.matchMedia('(hover: none)').matches;

function setHighlightGeom(map: maplibregl.Map, geom: Geometry | null): void {
    const src = map.getSource(HIGHLIGHT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (geom && (geom.type === 'LineString' || geom.type === 'MultiLineString')) {
        src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: {} }] });
        if (map.getLayer(HIGHLIGHT_GLOW_LAYER)) map.moveLayer(HIGHLIGHT_GLOW_LAYER);
        if (map.getLayer(HIGHLIGHT_LAYER)) map.moveLayer(HIGHLIGHT_LAYER);
    } else if (!geom) {
        src.setData({ type: 'FeatureCollection', features: [] });
    }
}

// Collect all tile fragments for the feature identified by props[matchProp] and highlight
// the merged geometry. Vector tile sources clip features at tile boundaries, so a single
// logical feature may arrive as many fragments — this merges them into one MultiLineString.
// Uses queryRenderedFeatures (rendered tile cache) rather than querySourceFeatures so it
// works correctly with Drive-backed PMTiles sources.
function highlightAllFragments(map: maplibregl.Map, layerId: string, props: Record<string, unknown>, matchProp: string, fallbackGeom: Geometry | null): void {
    const matchVal = props[matchProp];
    if (matchVal === undefined || matchVal === null) {
        setHighlightGeom(map, fallbackGeom);
        return;
    }

    const filter = ['==', ['get', matchProp], matchVal] as unknown as maplibregl.FilterSpecification;
    const canvas = map.getCanvas();
    const fragments = map.queryRenderedFeatures(
        [[0, 0], [canvas.width, canvas.height]],
        { layers: [layerId], filter },
    );

    const rings: number[][][] = [];
    for (const f of fragments) {
        if (f.geometry.type === 'LineString') rings.push(f.geometry.coordinates);
        else if (f.geometry.type === 'MultiLineString') rings.push(...f.geometry.coordinates);
    }
    if (rings.length === 0) {
        setHighlightGeom(map, fallbackGeom);
        return;
    }
    const geom: Geometry = rings.length === 1
        ? { type: 'LineString', coordinates: rings[0] }
        : { type: 'MultiLineString', coordinates: rings };
    setHighlightGeom(map, geom);
}

// Single point where MapLibre layer events are bound. All layer types use this so the
// click/hover pattern can't diverge between tracks, peaks, and overlays.
//
// clickOnAll=true  (tracks, overlays): click fires on all devices; hover fires on non-touch.
// clickOnAll=false (peaks):            click fires on touch only; hover fires on non-touch.
// isLine=true      (tracks, overlays): hover shows/clears highlight; mouseleave clears it.
// isLine=false     (peaks):            no highlight — prevents peak mouseleave clearing a line highlight.
// matchProp        (PMTiles sources):  property used to identify the full feature across tile fragments.
//                                      When set, querySourceFeatures gathers all fragments so the
//                                      entire visible track/path is highlighted, not just the current tile.
function bindInteraction(
    map: maplibregl.Map,
    layerId: string,
    getData: (e: { features?: maplibregl.MapGeoJSONFeature[] }) => PopupData | null,
    clickRef: { current: (d: PopupData) => void },
    hoverRef: { current: (d: PopupData | null) => void },
    clickOnAll = true,
    isLine = true,
    matchProp?: string,
): void {
    const applyHighlight = (e: { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!isLine) return;
        const props = e.features?.[0]?.properties ?? {};
        if (matchProp) {
            highlightAllFragments(map, layerId, props, matchProp, e.features?.[0]?.geometry ?? null);
        } else {
            setHighlightGeom(map, e.features?.[0]?.geometry ?? null);
        }
    };

    if (clickOnAll || IS_TOUCH) {
        map.on('click', layerId, e => {
            const data = getData(e);
            if (data) {
                applyHighlight(e);
                clickRef.current(data);
            }
        });
    }
    if (!IS_TOUCH) {
        map.on('mouseenter', layerId, e => {
            map.getCanvas().style.cursor = 'pointer';
            applyHighlight(e);
            hoverRef.current(getData(e));
        });
        map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            if (isLine) setHighlightGeom(map, null);
            hoverRef.current(null);
        });
    }
}

// Scale peak icons with zoom: small at overview, full-size when zoomed in
const PEAK_ICON_SIZE = ['interpolate', ['linear'], ['zoom'], 7, 0.4, 11, 0.9, 15, 1.5] as unknown as maplibregl.ExpressionSpecification;

// Done-tick scales with zoom to stay proportional to the peak icon it overlays
const DONE_TICK_SIZE = ['interpolate', ['linear'], ['zoom'], 7, 10, 11, 18, 15, 28] as unknown as maplibregl.ExpressionSpecification;

// Overlay line width scales with zoom: minimum at overview, full-size when zoomed in.
// Anchored at zoom 0 so extrapolation below the first stop never reaches 0.
const zoomLineWidth = (base: number): maplibregl.ExpressionSpecification =>
    ['interpolate', ['linear'], ['zoom'], 0, base * 0.3, 12, base * 0.65, 16, base] as unknown as maplibregl.ExpressionSpecification;

const DONE_TICK_LAYOUT = {
    'text-field': '✔',
    'text-size': DONE_TICK_SIZE as unknown as number,
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



function preserveCustomLayers(prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
    if (!prev) return next;
    const customSources: Record<string, SourceSpecification> = {};
    for (const [id, src] of Object.entries(prev.sources ?? {})) {
        if (
            id.startsWith('track-') ||
            id.startsWith('peaks-') ||
            id === PMTILES_SOURCE ||
            id === PEAKS_PMTILES_SOURCE ||
            id.startsWith('overlay-') ||
            id === HIGHLIGHT_SOURCE ||
            id === HEADING_SOURCE
        ) {
            customSources[id] = src as SourceSpecification;
        }
    }
    const allCustom = (prev.layers ?? []).filter(
        l =>
            l.id.startsWith('track-line-') ||
            l.id.startsWith('peaks-') ||
            l.id.startsWith('tracks-pmtiles-') ||
            l.id.startsWith('overlay-') ||
            l.id === HEADING_LAYER ||
            l.id === HIGHLIGHT_GLOW_LAYER ||
            l.id === HIGHLIGHT_LAYER,
    );
    const customLayers = allCustom.filter(l => l.id !== HIGHLIGHT_GLOW_LAYER && l.id !== HIGHLIGHT_LAYER && l.id !== HEADING_LAYER);
    const headingLayer = allCustom.find(l => l.id === HEADING_LAYER);
    const highlightLayers = [HIGHLIGHT_GLOW_LAYER, HIGHLIGHT_LAYER]
        .map(id => allCustom.find(l => l.id === id))
        .filter((l): l is (typeof allCustom)[number] => l !== undefined);
    return {
        ...next,
        sources: { ...next.sources, ...customSources },
        layers: [
            ...next.layers,
            ...customLayers,
            ...(headingLayer ? [headingLayer] : []),
            ...highlightLayers,
        ],
    };
}

function buildTrackPopup(props: Record<string, unknown>): TrackPopupData {
    return {
        displayName: String(props.display_name ?? ''),
        trackType: props.track_type ? String(props.track_type) : null,
        category: String(props.category ?? ''),
        filename: String(props.filename ?? ''),
        datetime: props.datetime ? String(props.datetime) : null,
        linkText: props.link_text ? String(props.link_text) : null,
        fileId: props.file_id ? String(props.file_id) : null,
        lengthKm: typeof props.length_km === 'number' ? props.length_km : null,
        ascentM: typeof props.ascent_m === 'number' ? props.ascent_m : null,
        durationS: typeof props.duration_s === 'number' ? props.duration_s : null,
        movingTimeS: typeof props.moving_time_s === 'number' ? props.moving_time_s : null,
    };
}

function buildOverlayPopup(overlayId: string, overlayLabel: string, props: Record<string, unknown>): OverlayPopupData {
    return {
        overlayId,
        overlayLabel,
        name: props.Name ? String(props.Name) : null,
        rowType: props.row_type ? String(props.row_type) : null,
        authorityName: props.authority_name ? String(props.authority_name) : null,
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
    onFeatureClick,
    onFeatureHover,
    onError,
    onStyleLoad,
    onStyleFail,
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
    const onFeatureClickRef = useRef(onFeatureClick);
    const onFeatureHoverRef = useRef(onFeatureHover);
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
        onFeatureClickRef.current = onFeatureClick;
    });
    useEffect(() => {
        onFeatureHoverRef.current = onFeatureHover;
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
        map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');

        const geolocate = new maplibregl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: true,
            showAccuracyCircle: true,
            fitBoundsOptions: { maxZoom: 16, animate: true },
        });
        map.addControl(geolocate, 'bottom-right');
        map.addControl(new Compass({ size: 'sm' }), 'top-right');
        geolocate.on('error', e => {
            onErrorRef.current((e as GeolocationPositionError).message ?? 'Geolocation error');
        });

        // Track user position and device heading to drive the heading cone
        let userPos: { lng: number; lat: number } | null = null;
        let deviceHeading: number | null = null;

        const updateHeadingCone = () => {
            const src = map.getSource(HEADING_SOURCE) as maplibregl.GeoJSONSource | undefined;
            if (!src) return;
            if (userPos === null || deviceHeading === null) {
                src.setData({ type: 'FeatureCollection', features: [] });
            } else {
                src.setData(buildHeadingCone(userPos.lng, userPos.lat, deviceHeading));
            }
        };

        geolocate.on('geolocate', (e: GeolocationPosition) => {
            userPos = { lng: e.coords.longitude, lat: e.coords.latitude };
            updateHeadingCone();
        });
        geolocate.on('trackuserlocationend', () => {
            userPos = null;
            updateHeadingCone();
        });

        const handleOrientation = (e: DeviceOrientationEvent) => {
            // webkitCompassHeading: iOS compass bearing (0=north, clockwise)
            // alpha from deviceorientationabsolute: 0=north, counter-clockwise → convert to clockwise
            const heading =
                (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
                ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null);
            if (heading === null) return;
            deviceHeading = heading;
            updateHeadingCone();
        };
        window.addEventListener('deviceorientationabsolute', handleOrientation as EventListener);
        window.addEventListener('deviceorientation', handleOrientation as EventListener);

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

        map.on('error', e => {
            // Only surface errors before the first style.load — after that, errors are mostly
            // transient tile fetch failures (404, rate limit) which the user can't action.
            if (!styleLoadedRef.current) {
                onErrorRef.current(e.error?.message ?? 'Map error');
            } else {
                const msg = e.error?.message ?? String(e);
                // Always log; highlight overlay errors so they stand out in the console
                if (msg.includes('overlay-') || msg.includes('pmtiles')) {
                    console.error('[MapView overlay ERROR]', msg, e);
                } else {
                    console.error('[MapView]', msg);
                }
            }
        });

        // Suppress "Image X could not be loaded" warnings from base map styles that
        // reference sprite icons their own sprite sheet doesn't include.
        map.on('styleimagemissing', (e: { id: string }) => {
            if (!map.hasImage(e.id)) {
                map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
            }
        });

        // style.load fires on initial load AND after every setStyle call
        map.on('style.load', () => {
            styleLoadedRef.current = true;
            onStyleLoadRef.current?.(loadedSourceIdRef.current!);
            // preserveCustomLayers copies these sources on style switches; add them on first load
            if (!map.getSource(HIGHLIGHT_SOURCE)) {
                map.addSource(HIGHLIGHT_SOURCE, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
            }
            if (!map.getSource(HEADING_SOURCE)) {
                map.addSource(HEADING_SOURCE, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
            }
            const b = map.getBounds();
            onBoundsChangeRef.current({
                west: b.getWest(),
                east: b.getEast(),
                south: b.getSouth(),
                north: b.getNorth(),
            });
            setMapVersion(v => v + 1);
        });

        // Clear highlight when the user clicks on background (no line feature at point)
        map.on('click', e => {
            const lineLayers = (map.getStyle()?.layers ?? [])
                .filter(l =>
                    (l.id.startsWith('track-line-') || l.id.startsWith('tracks-pmtiles-') || l.id.startsWith('overlay-'))
                    && l.id !== HIGHLIGHT_LAYER,
                )
                .map(l => l.id);
            if (lineLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: lineLayers }).length > 0) return;
            setHighlightGeom(map, null);
        });

        return () => {
            window.removeEventListener('deviceorientationabsolute', handleOrientation as EventListener);
            window.removeEventListener('deviceorientation', handleOrientation as EventListener);
            map.remove();
            mapRef.current = null;
            loadedSourceIdRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

            const getOverlayData = (e: { features?: maplibregl.MapGeoJSONFeature[] }): PopupData | null => {
                const props = e.features?.[0]?.properties;
                return props ? { kind: 'overlay', ...buildOverlayPopup(ov.id, ov.label, props) } : null;
            };

            if (ov.lineStyle) {
                const outerId = overlayOuterLayerId(ov.id);
                const innerId = overlayInnerLayerId(ov.id);
                if (!map.getLayer(outerId)) {
                    map.addLayer({
                        id: outerId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.lineStyle.outerColor,
                            'line-width': zoomLineWidth(ov.lineStyle.outerWidth),
                            'line-opacity': ov.lineStyle.outerOpacity,
                        },
                    });
                    bindInteraction(map, outerId, getOverlayData, onFeatureClickRef, onFeatureHoverRef, true, true, 'Name');
                }
                if (!map.getLayer(innerId)) {
                    map.addLayer({
                        id: innerId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.lineStyle.innerColor,
                            'line-width': zoomLineWidth(ov.lineStyle.innerWidth),
                            'line-opacity': 1,
                        },
                    });
                    bindInteraction(map, innerId, getOverlayData, onFeatureClickRef, onFeatureHoverRef, true, true, 'Name');
                }
            } else {
                const layId = overlayLayerId(ov.id);
                if (!map.getLayer(layId)) {
                    map.addLayer({
                        id: layId, type: 'line', source: srcId, 'source-layer': ov.sourceLayer,
                        ...minzoom, ...filter,
                        paint: {
                            'line-color': ov.overlayColor ?? '#e8a020',
                            'line-width': zoomLineWidth(ov.overlayWidth ?? 1.5),
                            'line-opacity': ov.overlayOpacity ?? 0.75,
                        },
                    });
                    bindInteraction(map, layId, getOverlayData, onFeatureClickRef, onFeatureHoverRef, true, true, 'Name');
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
                bindInteraction(map, lid, () => ({
                    kind: 'track',
                    displayName: track.displayName,
                    trackType: track.trackType,
                    category: track.category,
                    filename: track.filename,
                    datetime: track.datetime,
                    linkText: track.linkText,
                    fileId: track.fileId,
                    lengthKm: null,
                    ascentM: null,
                    durationS: null,
                    movingTimeS: null,
                }), onFeatureClickRef, onFeatureHoverRef);
            }
        }
    }, [loadedTracks, categories, mapVersion]);

    // Sync PMTiles tracks overlay — one layer per category so dashArray can vary.
    // Defined before peak effects so PMTiles tracks render below peaks in MapLibre's layer order.
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
            bindInteraction(map, lid, e => {
                const p = e.features?.[0]?.properties;
                return p ? { kind: 'track', ...buildTrackPopup(p) } : null;
            }, onFeatureClickRef, onFeatureHoverRef, true, true, 'filename');
        }
    }, [tracksPmtilesFileId, categories, mapVersion]);

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
                bindInteraction(map, lid, e => {
                    const f = e.features?.[0];
                    if (!f) return null;
                    const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                    return { kind: 'peak', name: String(f.properties?.name ?? ''), elevation: Number(f.properties?.ele ?? 0), category: ps.category, lat, lng };
                }, onFeatureClickRef, onFeatureHoverRef, false, false);
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
            bindInteraction(map, lid, e => {
                const f = e.features?.[0];
                if (!f) return null;
                const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
                return { kind: 'peak', name: String(f.properties?.name ?? ''), elevation: Number(f.properties?.ele ?? 0), category: pc.name, lat, lng };
            }, onFeatureClickRef, onFeatureHoverRef, false, false);

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

    // Heading cone layer — semi-transparent fill rendered above tracks, below highlight.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0 || !map.getSource(HEADING_SOURCE)) return;
        if (!map.getLayer(HEADING_LAYER)) {
            map.addLayer({
                id: HEADING_LAYER,
                type: 'fill',
                source: HEADING_SOURCE,
                paint: {
                    'fill-color': '#4285f4',
                    'fill-opacity': 0.25,
                },
            });
        }
    }, [mapVersion]);

    // Two-layer highlight: soft white glow (outer) + crisp cyan line (inner), both topmost.
    // Shown on hover and click for line features. preserveCustomLayers keeps them across style switches.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || mapVersion === 0 || !map.getSource(HIGHLIGHT_SOURCE)) return;
        if (!map.getLayer(HIGHLIGHT_GLOW_LAYER)) {
            map.addLayer({
                id: HIGHLIGHT_GLOW_LAYER,
                type: 'line',
                source: HIGHLIGHT_SOURCE,
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 12,
                    'line-opacity': 0.35,
                    'line-blur': 8,
                },
            });
        }
        if (!map.getLayer(HIGHLIGHT_LAYER)) {
            map.addLayer({
                id: HIGHLIGHT_LAYER,
                type: 'line',
                source: HIGHLIGHT_SOURCE,
                paint: {
                    'line-color': HIGHLIGHT_COLOR,
                    'line-width': 4,
                    'line-opacity': 0.95,
                },
            });
        }
    }, [mapVersion]);

    return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
