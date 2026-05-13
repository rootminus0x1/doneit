import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useGoogleAuth } from './hooks/useGoogleAuth';
import { useDriveData } from './hooks/useDriveData';
import { useTileSource } from './hooks/useTileSource';
import { useUnindexedTracks } from './hooks/useViewportTracks';
import { MapView } from './components/MapView';
import { MapControls } from './components/MapControls';
import { MapStyleSelector } from './components/MapStyleSelector';
import { Sidebar } from './components/Sidebar';
import { registerDrivePMTiles } from './lib/drivepmtiles';

const PEAK_COLORS = ['#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f97316'];

export default function App() {
    const { token, signIn, signOut, error: authError } = useGoogleAuth();
    const {
        ready,
        error: driveError,
        trackIndex,
        categories,
        peakSets,
        tracksPmtilesFileId,
        unindexedFiles,
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
    const lastGoodSourceIdRef = useRef<string | null>(null);
    const [popup, setPopup] = useState<{ title: string; body: string } | null>(null);

    const [hiddenCountries, setHiddenCountries] = useState<string[]>([]);
    const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);

    const toggleCountry = useCallback(
        (c: string) => setHiddenCountries(prev => (prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])),
        [],
    );
    const toggleCategory = useCallback(
        (c: string) => setHiddenCategories(prev => (prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])),
        [],
    );

    const availableCountries = useMemo(
        () =>
            [...new Set((trackIndex?.tracks ?? []).map(t => t.country).filter((c): c is string => c !== null))].sort(),
        [trackIndex],
    );

    // Keep a ref so DriveSource closures always use the current token without re-registering
    const tokenRef = useRef(token);
    tokenRef.current = token;

    useEffect(() => {
        allSources
            .filter(s => s.type === 'pmtiles-drive' && s.fileId)
            .forEach(s => registerDrivePMTiles(s.fileId!, () => tokenRef.current ?? ''));
        if (tracksPmtilesFileId) {
            registerDrivePMTiles(tracksPmtilesFileId, () => tokenRef.current ?? '');
        }
    }, [allSources, tracksPmtilesFileId]);

    // Load raw GPX only for files not yet included in the PMTiles build
    const loadedTracks = useUnindexedTracks(token, unindexedFiles);

    const loadedPeaks = peakSets.map((ps, i) => ({
        ...ps,
        color: PEAK_COLORS[i % PEAK_COLORS.length],
    }));

    const handleTrackClick = useCallback(
        (fileId: string) => {
            const entry = trackIndex?.tracks.find(t => t.fileId === fileId);
            if (entry) {
                setPopup({ title: entry.displayName, body: entry.date ?? '' });
            }
        },
        [trackIndex],
    );

    const handlePeakClick = useCallback((name: string, elevation: number, category: string) => {
        setPopup({ title: name, body: `${category}  ·  ${Math.round(elevation).toLocaleString()} m` });
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
                    onBoundsChange={() => {}}
                    onTrackClick={handleTrackClick}
                    onPeakClick={handlePeakClick}
                    onError={msg => setMapError(msg)}
                    onStyleLoad={handleStyleLoad}
                    onStyleFail={handleStyleFail}
                    tracksPmtilesFileId={tracksPmtilesFileId ?? undefined}
                    hiddenCountries={hiddenCountries}
                    hiddenCategories={hiddenCategories}
                    flyToBbox={flyToBbox}
                />
            )}

            <MapStyleSelector
                sources={allSources}
                activeId={activeSource?.id ?? ''}
                sidebarOpen={sidebarOpen}
                onSelect={setSource}
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

            {token && !ready && <div style={styles.loadingBanner}>Loading…</div>}

            {authError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{authError}</div>}
            {driveError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{driveError}</div>}
            {loadError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map config error: {loadError}</div>
            )}
            {mapError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map style error: {mapError}</div>
            )}

            <MapControls onLocate={setFlyToBbox} />

            <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                categories={categories}
                hiddenCategories={hiddenCategories}
                onToggleCategory={toggleCategory}
                countries={availableCountries}
                hiddenCountries={hiddenCountries}
                onToggleCountry={toggleCountry}
                peakSets={peakSets}
                trackCount={trackIndex?.tracks.length ?? 0}
                indexGenerated={trackIndex?.generated ?? null}
                unindexedCount={unindexedFiles.length}
            />

            {popup && (
                <div style={styles.popupOverlay} onClick={() => setPopup(null)}>
                    <div style={styles.popup} onClick={e => e.stopPropagation()}>
                        <div style={styles.popupTitle}>{popup.title}</div>
                        {popup.body && <div style={styles.popupBody}>{popup.body}</div>}
                        <button style={styles.popupClose} onClick={() => setPopup(null)}>
                            ✕
                        </button>
                    </div>
                </div>
            )}
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
};
