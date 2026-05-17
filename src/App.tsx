import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useGoogleAuth } from './hooks/useGoogleAuth';
import { useDriveData } from './hooks/useDriveData';
import { useTileSource } from './hooks/useTileSource';
import { useUnindexedTracks } from './hooks/useViewportTracks';
import { MapView } from './components/MapView';
import type { TrackPopupData } from './components/MapView';
import { MapControls } from './components/MapControls';
import { MapStyleSelector } from './components/MapStyleSelector';
import { Sidebar } from './components/Sidebar';
import { registerDrivePMTiles } from './lib/drivepmtiles';
import { filenameToCategoryLabel } from './lib/gpxParser';

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
    const { token, signIn, signOut, error: authError } = useGoogleAuth();
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

    const savedCenter = useRef<[number, number]>([-4.0, 57.0]);
    const savedZoom = useRef<number>(7);
    const handleMove = useCallback((center: [number, number], zoom: number) => {
        savedCenter.current = center;
        savedZoom.current = zoom;
    }, []);

    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [flyToBbox, setFlyToBbox] = useState(null as null | import('./lib/gpxParser').TrackBbox);
    const [mapError, setMapError] = useState<string | null>(null);
    const [bearing, setBearing] = useState(0);
    const [northTrigger, setNorthTrigger] = useState(0);
    const [hoverPeak, setHoverPeak] = useState<{
        name: string;
        elevation: number;
        category: string;
        lat: number;
        lng: number;
    } | null>(null);
    const lastGoodSourceIdRef = useRef<string | null>(null);
    const [popup, setPopup] = useState<{
        title: string;
        body: string;
        peakMeta?: { name: string; category: string; lat: number; lng: number; ele: number };
    } | null>(null);
    const [hoverTrack, setHoverTrack] = useState<TrackPopupData | null>(null);
    const [clickedTrack, setClickedTrack] = useState<TrackPopupData | null>(null);

    const [showVersion, setShowVersion] = useState(true);
    useEffect(() => {
        const t = setTimeout(() => setShowVersion(false), 4000);
        return () => clearTimeout(t);
    }, []);

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

    const overlays = allSources.filter(s => s.type === 'pmtiles-overlay');

    const hiddenOverlays = useMemo(
        () => overlays.filter(ov => (ov.minAccessLevel ?? 0) > rowAccessLevel).map(ov => ov.id),
        [overlays, rowAccessLevel],
    );

    useEffect(() => {
        allSources
            .filter(s => (s.type === 'pmtiles-drive' || s.type === 'pmtiles-overlay') && s.fileId)
            .forEach(s => registerDrivePMTiles(s.fileId!, () => tokenRef.current ?? ''));
        if (tracksPmtilesFileId) {
            registerDrivePMTiles(tracksPmtilesFileId, () => tokenRef.current ?? '');
        }
        if (peaksPmtilesFileId) {
            registerDrivePMTiles(peaksPmtilesFileId, () => tokenRef.current ?? '');
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

    const handleTrackClick = useCallback((data: TrackPopupData) => {
        setClickedTrack(data);
        setHoverTrack(null);
    }, []);

    const handleTrackHover = useCallback((data: TrackPopupData | null) => {
        setHoverTrack(data);
    }, []);

    const handlePeakClick = useCallback(
        (name: string, elevation: number, category: string, lat: number, lng: number) => {
            setPopup({
                title: name,
                body: `${category}  ·  ${Math.round(elevation).toLocaleString()} m  ·  ${formatCoord(lat, lng)}`,
                peakMeta: { name, category, lat, lng, ele: elevation },
            });
        },
        [],
    );

    const handlePeakHover = useCallback(
        (name: string, elevation: number, category: string, lat: number, lng: number) => {
            setHoverPeak({ name, elevation, category, lat, lng });
        },
        [],
    );

    const handlePeakHoverEnd = useCallback(() => setHoverPeak(null), []);

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
                    onTrackClick={handleTrackClick}
                    onTrackHover={handleTrackHover}
                    onPeakClick={handlePeakClick}
                    onPeakHover={handlePeakHover}
                    onPeakHoverEnd={handlePeakHoverEnd}
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

            {showVersion && <div style={styles.versionToast}>Version: {formatDatetime(__BUILD_TIME__)}</div>}

            {token && !ready && <div style={styles.loadingBanner}>Loading…</div>}

            {authError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{authError}</div>}
            {driveError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{driveError}</div>}
            {loadError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map config error: {loadError}</div>
            )}
            {mapError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map style error: {mapError}</div>
            )}

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
            />

            {popup && (
                <div style={styles.popupOverlay} onClick={() => setPopup(null)}>
                    <div style={styles.popup} onClick={e => e.stopPropagation()}>
                        <div style={styles.popupTitle}>{popup.title}</div>
                        {popup.body && <div style={styles.popupBody}>{popup.body}</div>}
                        {popup.peakMeta &&
                            (() => {
                                const meta = popup.peakMeta!;
                                const key = `${meta.category}:${meta.name}`;
                                if (!baggedSet.has(key)) return null;
                                const dates = baggedTracks
                                    .filter(bt =>
                                        bt.peaks.some(
                                            bp => bp.category === meta.category && bp.names.includes(meta.name),
                                        ),
                                    )
                                    .map(bt => bt.date)
                                    .filter((d): d is string => d !== null)
                                    .sort()
                                    .map(formatDate);
                                return (
                                    <div style={styles.popupBaggedDate}>
                                        ✔ Bagged{dates.length > 0 ? `: ${dates.join(', ')}` : ''}
                                    </div>
                                );
                            })()}
                        <button style={styles.popupClose} onClick={() => setPopup(null)}>
                            ✕
                        </button>
                    </div>
                </div>
            )}

            {hoverPeak && !hoverTrack && !clickedTrack && (
                <div style={styles.hoverPopupContainer}>
                    <div style={{ ...styles.popup, pointerEvents: 'none' }}>
                        <div style={styles.popupTitle}>{hoverPeak.name}</div>
                        <div style={styles.popupBody}>
                            {hoverPeak.category} · {Math.round(hoverPeak.elevation).toLocaleString()} m ·{' '}
                            {formatCoord(hoverPeak.lat, hoverPeak.lng)}
                        </div>
                        {(() => {
                            const key = `${hoverPeak.category}:${hoverPeak.name}`;
                            if (!baggedSet.has(key)) return null;
                            const dates = baggedTracks
                                .filter(bt =>
                                    bt.peaks.some(
                                        bp => bp.category === hoverPeak.category && bp.names.includes(hoverPeak.name),
                                    ),
                                )
                                .map(bt => bt.date)
                                .filter((d): d is string => d !== null)
                                .sort()
                                .map(formatDate);
                            return (
                                <div style={styles.popupBaggedDate}>
                                    ✔ Bagged{dates.length > 0 ? `: ${dates.join(', ')}` : ''}
                                </div>
                            );
                        })()}
                    </div>
                </div>
            )}

            {(() => {
                const trackPopup = clickedTrack ?? hoverTrack;
                const pinned = clickedTrack !== null;
                if (!trackPopup) return null;
                const bagged = baggedTracks.find(bt => bt.track === trackPopup.filename);
                const baggedNames = bagged ? bagged.peaks.flatMap(bp => bp.names) : [];
                return (
                    <div
                        style={pinned ? styles.popupOverlay : styles.hoverPopupContainer}
                        onClick={pinned ? () => setClickedTrack(null) : undefined}
                    >
                        <div style={styles.popup} onClick={e => e.stopPropagation()}>
                            <div style={styles.popupTitle}>{trackPopup.displayName}</div>
                            <div style={styles.popupBody}>
                                {trackPopup.trackType && <div>{trackPopup.trackType}</div>}
                                <div>{trackPopup.filename}</div>
                                {trackPopup.datetime && <div>{formatDatetime(trackPopup.datetime)}</div>}
                                {trackPopup.lengthKm !== null && <div>{trackPopup.lengthKm.toFixed(1)} km</div>}
                                {trackPopup.linkText && <div>{trackPopup.linkText}</div>}
                                {baggedNames.length > 0 && (
                                    <div style={{ marginTop: 4 }}>✔ {baggedNames.join(', ')}</div>
                                )}
                            </div>
                            {pinned && (
                                <button style={styles.popupClose} onClick={() => setClickedTrack(null)}>
                                    ✕
                                </button>
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
};
