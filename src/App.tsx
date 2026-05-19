import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { toast, Toaster } from 'sonner';
import { useGoogleAuth } from './hooks/useGoogleAuth';
import { useDriveData } from './hooks/useDriveData';
import { useTileSource } from './hooks/useTileSource';
import { useUnindexedTracks } from './hooks/useViewportTracks';
import { MapView } from './components/MapView';
import type { PopupData } from './components/MapView';
import { MapControls } from './components/MapControls';
import { MapStyleSelector } from './components/MapStyleSelector';
import { Sidebar } from './components/Sidebar';
import { registerDrivePMTiles, upgradeToLocalPMTiles } from './lib/drivepmtiles';
import { useSync } from './hooks/useSync';
import { filenameToCategoryLabel } from './lib/gpxParser';

function useErrorToast(error: string | null) {
    const prev = useRef<string | null>(null);
    useEffect(() => {
        if (error && error !== prev.current) {
            toast.error(error, {
                duration: Infinity,
                action: { label: 'Copy', onClick: () => navigator.clipboard.writeText(error) },
            });
        }
        prev.current = error;
    }, [error]);
}

const PEAK_COLORS = ['#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f97316'];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDatetime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${DAYS[d.getDay()]} ${day}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${hh}:${mm}`;
}

function formatCoord(lat: number, lng: number): string {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
}

function formatDate(date: string): string {
    const d = new Date(date + 'T12:00:00');
    if (isNaN(d.getTime())) return date;
    return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

export default function App() {
    const { token, signIn, signOut, error: authError, needsReauth } = useGoogleAuth();
    const {
        ready,
        error: driveError,
        trackIndex,
        categories,
        peakSets,
        peakCategories,
        peakDisplayConfig,
        peakDefaultHidden,
        tracksPmtilesFileId,
        peaksPmtilesFileId,
        unindexedFiles,
        baggedTracks,
        baggedSet,
    } = useDriveData(token);
    const { allSources, activeSource, setSource, loadError } = useTileSource(token);

    let initCenter: [number, number] = [-4.0, 57.0];
    try {
        const s = localStorage.getItem('doneit-map-center');
        if (s) initCenter = JSON.parse(s) as [number, number];
    } catch { /* ignore */ }
    const initZoom = parseFloat(localStorage.getItem('doneit-map-zoom') ?? '') || 7;
    const savedCenter = useRef<[number, number]>(initCenter);
    const savedZoom = useRef<number>(initZoom);
    const [mapCenter, setMapCenter] = useState<[number, number]>(savedCenter.current);
    const [mapZoom, setMapZoom] = useState<number>(savedZoom.current);
    const handleMove = useCallback((center: [number, number], zoom: number) => {
        savedCenter.current = center;
        savedZoom.current = zoom;
        localStorage.setItem('doneit-map-center', JSON.stringify(center));
        localStorage.setItem('doneit-map-zoom', String(zoom));
        setMapCenter(center);
        setMapZoom(zoom);
    }, []);

    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [flyToBbox, setFlyToBbox] = useState(null as null | import('./lib/gpxParser').TrackBbox);
    const [mapError, setMapError] = useState<string | null>(null);

    const { syncState, startSync, cancelSync } = useSync(token);

    useErrorToast(authError);
    useErrorToast(driveError);
    useErrorToast(loadError);
    useErrorToast(mapError);
    useErrorToast(syncState.error);
    const [bearing, setBearing] = useState(0);
    const [northTrigger, setNorthTrigger] = useState(0);
    const lastGoodSourceIdRef = useRef<string | null>(null);
    const [hoveredFeature, setHoveredFeature] = useState<PopupData | null>(null);
    const [clickedFeature, setClickedFeature] = useState<PopupData | null>(null);


    const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
    const [hiddenTrackTypes, setHiddenTrackTypes] = useState<string[]>([]);
    const [hiddenPeakCategories, setHiddenPeakCategories] = useState<string[]>([]);
    const [rowAccessLevel, setRowAccessLevel] = useState(0); // 0=off, 1=motor, 2=cycle, 3=foot
    const peakDefaultsApplied = useRef(false);

    const toggleCategory = useCallback(
        (c: string) => setHiddenCategories(prev => (prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])),
        [],
    );
    const toggleTrackType = useCallback(
        (t: string) => setHiddenTrackTypes(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])),
        [],
    );
    const togglePeakCategory = useCallback(
        (c: string) => setHiddenPeakCategories(prev => (prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])),
        [],
    );

    useEffect(() => {
        if (peakDefaultsApplied.current || (peakCategories.length === 0 && peakSets.length === 0)) return;
        peakDefaultsApplied.current = true;
        setHiddenPeakCategories(peakDefaultHidden);
    }, [peakDefaultHidden, peakCategories, peakSets]);

    const availableTrackTypes = useMemo(
        () =>
            [
                ...new Set((trackIndex?.tracks ?? []).map(t => t.trackType).filter((t): t is string => t !== null)),
            ].sort(),
        [trackIndex],
    );

    const tokenRef = useRef(token);
    tokenRef.current = token;

    const overlays = useMemo(
        () => allSources.filter(s => s.type === 'pmtiles-overlay'),
        [allSources],
    );


    const hiddenOverlays = useMemo(
        () => overlays.filter(ov => (ov.minAccessLevel ?? 0) > rowAccessLevel).map(ov => ov.id),
        [overlays, rowAccessLevel],
    );

    useEffect(() => {
        allSources
            .filter(s => (s.type === 'pmtiles-drive' || s.type === 'pmtiles-overlay') && s.fileId)
            .forEach(s => {
                registerDrivePMTiles(s.fileId!, () => tokenRef.current ?? '');
                void upgradeToLocalPMTiles(s.fileId!);
            });
        if (tracksPmtilesFileId) {
            registerDrivePMTiles(tracksPmtilesFileId, () => tokenRef.current ?? '');
            void upgradeToLocalPMTiles(tracksPmtilesFileId);
        }
        if (peaksPmtilesFileId) {
            registerDrivePMTiles(peaksPmtilesFileId, () => tokenRef.current ?? '');
            void upgradeToLocalPMTiles(peaksPmtilesFileId);
        }
    }, [allSources, tracksPmtilesFileId, peaksPmtilesFileId]);

    const loadedTracks = useUnindexedTracks(token, unindexedFiles);

    const loadedPeaks = peakSets.map((ps, i) => {
        const d = peakDisplayConfig[ps.category] ?? {};
        return {
            ...ps,
            color: d.color ?? PEAK_COLORS[(peakCategories.length + i) % PEAK_COLORS.length],
            strokeColor: d.strokeColor ?? '#ffffff',
            radius: d.radius ?? 5,
            opacity: d.opacity ?? 0.9,
            shape: d.shape ?? ('circle' as const),
        };
    });

    const enrichedPeakCategories = useMemo(
        () => [
            ...peakCategories.map((pc, i) => {
                const d = peakDisplayConfig[pc.name] ?? {};
                return {
                    name: pc.name,
                    label: d.label ?? filenameToCategoryLabel(pc.name),
                    count: pc.count,
                    color: d.color ?? PEAK_COLORS[i % PEAK_COLORS.length],
                    strokeColor: d.strokeColor ?? '#ffffff',
                    radius: d.radius ?? 5,
                    opacity: d.opacity ?? 0.9,
                    shape: d.shape ?? ('circle' as const),
                    indexed: true as const,
                };
            }),
            ...peakSets.map((ps, i) => {
                const d = peakDisplayConfig[ps.category] ?? {};
                return {
                    name: ps.category,
                    label: d.label ?? filenameToCategoryLabel(ps.category),
                    count: ps.geojson.features.length,
                    color: d.color ?? PEAK_COLORS[(peakCategories.length + i) % PEAK_COLORS.length],
                    strokeColor: d.strokeColor ?? '#ffffff',
                    radius: d.radius ?? 5,
                    opacity: d.opacity ?? 0.9,
                    shape: d.shape ?? ('circle' as const),
                    indexed: false as const,
                };
            }),
        ],
        [peakCategories, peakSets, peakDisplayConfig],
    );

    const baggedCountByCategory = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const key of baggedSet) {
            const category = key.split(':')[0];
            counts[category] = (counts[category] ?? 0) + 1;
        }
        return counts;
    }, [baggedSet]);

    const handleFeatureClick = useCallback((data: PopupData) => {
        setClickedFeature(data);
        setHoveredFeature(null);
    }, []);

    const handleFeatureHover = useCallback((data: PopupData | null) => {
        setHoveredFeature(data);
    }, []);

    const handleStyleLoad = useCallback((sourceId: string) => {
        lastGoodSourceIdRef.current = sourceId;
        setMapError(null);
    }, []);

    const handleStyleFail = useCallback(
        (message: string) => {
            setMapError(message);
            const fallback = lastGoodSourceIdRef.current;
            if (fallback) setSource(fallback);
        },
        [setSource],
    );

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            {activeSource && (
                <MapView
                    source={activeSource}
                    initialCenter={savedCenter.current}
                    initialZoom={savedZoom.current}
                    onMove={handleMove}
                    categories={categories}
                    loadedTracks={loadedTracks}
                    loadedPeaks={loadedPeaks}
                    overlays={overlays}
                    onBoundsChange={() => {}}
                    onFeatureClick={handleFeatureClick}
                    onFeatureHover={handleFeatureHover}
                    onBearingChange={setBearing}
                    northTrigger={northTrigger}
                    onError={msg => setMapError(msg)}
                    onStyleLoad={handleStyleLoad}
                    onStyleFail={handleStyleFail}
                    tracksPmtilesFileId={tracksPmtilesFileId ?? undefined}
                    peaksPmtilesFileId={peaksPmtilesFileId ?? undefined}
                    peakCategories={enrichedPeakCategories}
                    hiddenCategories={hiddenCategories}
                    hiddenTrackTypes={hiddenTrackTypes}
                    hiddenPeakCategories={hiddenPeakCategories}
                    hiddenOverlays={hiddenOverlays}
                    baggedSet={baggedSet}
                    flyToBbox={flyToBbox}
                />
            )}

            <MapStyleSelector
                sources={allSources}
                activeId={activeSource?.id ?? ''}
                sidebarOpen={sidebarOpen}
                onSelect={setSource}
                rowAccessLevel={rowAccessLevel}
                onRowAccessChange={setRowAccessLevel}
            />

            <button style={styles.hamburger} onClick={() => setSidebarOpen(true)} title="Menu">
                ☰
            </button>

            <div style={styles.authArea}>
                {token ? (
                    <button style={styles.authBtn} onClick={signOut}>
                        Sign out
                    </button>
                ) : (
                    <button style={styles.authBtn} onClick={() => signIn()}>
                        Sign in
                    </button>
                )}
            </div>

            {!token && <div style={styles.versionToast}>Version: {formatDatetime(__BUILD_TIME__)}</div>}

            {token && !ready && <div style={styles.loadingBanner}>Loading…</div>}

            {needsReauth && (
                <div style={{ ...styles.loadingBanner, background: '#e65100', display: 'flex', gap: 10, alignItems: 'center', whiteSpace: 'normal' }}>
                    Session expired
                    <button style={styles.reconnectBtn} onClick={() => signIn()}>Reconnect</button>
                </div>
            )}

            <Toaster position="bottom-right" richColors expand offset={{ bottom: 40 }} />

            <div style={styles.coordDisplay}>
                {formatCoord(mapCenter[1], mapCenter[0])}
            </div>

            <MapControls onLocate={setFlyToBbox} bearing={bearing} onResetNorth={() => setNorthTrigger(n => n + 1)} />

            <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                categories={categories}
                hiddenCategories={hiddenCategories}
                onToggleCategory={toggleCategory}
                trackTypes={availableTrackTypes}
                hiddenTrackTypes={hiddenTrackTypes}
                onToggleTrackType={toggleTrackType}
                peakCategories={enrichedPeakCategories}
                hiddenPeakCategories={hiddenPeakCategories}
                onTogglePeakCategory={togglePeakCategory}
                baggedCountByCategory={baggedCountByCategory}
                trackCount={trackIndex?.tracks.length ?? 0}
                indexGenerated={trackIndex?.generated ?? null}
                unindexedCount={unindexedFiles.length}
                zoom={mapZoom}
                syncStatus={syncState.status}
                syncProgress={syncState.progress}
                lastSynced={syncState.lastSynced}
                onSync={startSync}
                onCancelSync={cancelSync}
            />

            {(() => {
                const feature = clickedFeature ?? hoveredFeature;
                const pinned = clickedFeature !== null;
                if (!feature) return null;

                let title: string;
                let body: React.ReactNode;

                if (feature.kind === 'track') {
                    const bagged = baggedTracks.find(bt => bt.track === feature.filename);
                    const baggedNames = bagged ? bagged.peaks.flatMap(bp => bp.names) : [];
                    title = feature.displayName;
                    body = (
                        <>
                            {feature.trackType && <div>{feature.trackType}</div>}
                            <div>{feature.filename}</div>
                            {feature.datetime && <div>{formatDatetime(feature.datetime)}</div>}
                            {feature.lengthKm !== null && <div>{feature.lengthKm.toFixed(1)} km</div>}
                            {feature.linkText && <div>{feature.linkText}</div>}
                            {baggedNames.length > 0 && (
                                <div style={{ marginTop: 4 }}>✔ {baggedNames.join(', ')}</div>
                            )}
                        </>
                    );
                } else if (feature.kind === 'peak') {
                    const key = `${feature.category}:${feature.name}`;
                    const dates = baggedSet.has(key)
                        ? baggedTracks
                              .filter(bt =>
                                  bt.peaks.some(
                                      bp => bp.category === feature.category && bp.names.includes(feature.name),
                                  ),
                              )
                              .map(bt => bt.date)
                              .filter((d): d is string => d !== null)
                              .sort()
                              .map(formatDate)
                        : null;
                    title = feature.name;
                    body = (
                        <>
                            <div>
                                {feature.category} · {Math.round(feature.elevation).toLocaleString()} m ·{' '}
                                {formatCoord(feature.lat, feature.lng)}
                            </div>
                            {dates !== null && (
                                <div style={styles.popupBaggedDate}>
                                    ✔ Bagged{dates.length > 0 ? `: ${dates.join(', ')}` : ''}
                                </div>
                            )}
                        </>
                    );
                } else {
                    const p = feature.properties;
                    const rowType = p.row_type ? String(p.row_type).replace(/_/g, ' ') : null;
                    const name = p.Name ? String(p.Name) : null;
                    const description = p.Description ? String(p.Description) : null;
                    title = String(p.authority_name ?? feature.overlayLabel);
                    body = (
                        <>
                            {rowType && <div>{rowType}</div>}
                            {name && <div>{name}</div>}
                            {description && <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{description}</div>}
                        </>
                    );
                }

                return (
                    <div
                        style={pinned ? styles.popupOverlay : styles.hoverPopupContainer}
                        onClick={pinned ? () => setClickedFeature(null) : undefined}
                    >
                        <div
                            style={{ ...styles.popup, pointerEvents: pinned ? 'auto' : 'none' }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div style={styles.popupTitle}>{title}</div>
                            <div style={styles.popupBody}>{body}</div>
                            {pinned && (
                                <button style={styles.popupClose} onClick={() => setClickedFeature(null)}>✕</button>
                            )}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    hamburger: {
        position: 'absolute',
        top: 12,
        left: 12,
        zIndex: 10,
        width: 40,
        height: 40,
        borderRadius: 8,
        background: '#fff',
        border: 'none',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        fontSize: 20,
    },
    authArea: { position: 'absolute', top: 12, right: 12, zIndex: 10 },
    authBtn: {
        padding: '8px 16px',
        borderRadius: 20,
        background: '#1a73e8',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 500,
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    },
    loadingBanner: {
        position: 'absolute',
        bottom: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.75)',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: 20,
        fontSize: 13,
        zIndex: 10,
        maxWidth: '80vw',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    popupOverlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: 80,
    },
    hoverPopupContainer: {
        position: 'fixed',
        bottom: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
        pointerEvents: 'none',
    },
    popup: {
        background: '#fff',
        borderRadius: 12,
        padding: '16px 20px',
        minWidth: 200,
        maxWidth: '90vw',
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        position: 'relative',
    },
    popupTitle: { fontSize: 16, fontWeight: 600, marginBottom: 4, paddingRight: 24 },
    popupBody: { fontSize: 14, color: '#555' },
    versionToast: {
        position: 'absolute',
        top: 60,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.55)',
        color: '#fff',
        padding: '5px 12px',
        borderRadius: 12,
        fontSize: 11,
        zIndex: 10,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
    },
    popupClose: {
        position: 'absolute',
        top: 10,
        right: 12,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 16,
        color: '#888',
    },
    popupBaggedDate: { fontSize: 13, color: '#2e7d32', marginTop: 6 },
    reconnectBtn: {
        padding: '4px 12px',
        borderRadius: 14,
        background: '#fff',
        color: '#e65100',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        flexShrink: 0,
    },
    coordDisplay: {
        position: 'absolute',
        bottom: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(255,255,255,0.85)',
        color: '#333',
        padding: '3px 10px',
        borderRadius: 10,
        fontSize: 11,
        fontFamily: 'monospace',
        zIndex: 10,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
    },
};
