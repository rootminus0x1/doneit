import { useState, useCallback, useRef, useEffect } from 'react';
import { useGoogleAuth } from './hooks/useGoogleAuth';
import { useDriveData } from './hooks/useDriveData';
import { useTileSource } from './hooks/useTileSource';
import { useViewportTracks } from './hooks/useViewportTracks';
import { MapView } from './components/MapView';
import { MapControls } from './components/MapControls';
import { MapStyleSelector } from './components/MapStyleSelector';
import { Sidebar } from './components/Sidebar';
import type { TrackBbox } from './lib/gpxParser';
import { registerDrivePMTiles } from './lib/drivepmtiles';

const PEAK_COLORS = ['#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f97316'];

export default function App() {
    const { token, signIn, signOut, error: authError } = useGoogleAuth();
    const {
        ready,
        building,
        progress,
        error: driveError,
        trackIndex,
        categories,
        peakSets,
        rebuildIndex,
    } = useDriveData(token);
    const { allSources, activeSource, setSource, loadError } = useTileSource(token);

    const savedCenter = useRef<[number, number]>([-4.0, 57.0]);
    const savedZoom = useRef<number>(7);
    const handleMove = useCallback((center: [number, number], zoom: number) => {
        savedCenter.current = center;
        savedZoom.current = zoom;
    }, []);

    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [viewport, setViewport] = useState<TrackBbox | null>(null);

    const [flyToBbox, setFlyToBbox] = useState<TrackBbox | null>(null);
    const [mapError, setMapError] = useState<string | null>(null);
    const lastGoodSourceIdRef = useRef<string | null>(null);
    const [popup, setPopup] = useState<{ title: string; body: string } | null>(null);

    // Keep a ref so DriveSource closures always use the current token without re-registering
    const tokenRef = useRef(token);
    tokenRef.current = token;

    // Register any Drive-hosted PMTiles base maps with the shared protocol.
    // Runs whenever the source list changes (e.g. after tile-sources.json loads).
    useEffect(() => {
        allSources
            .filter(s => s.type === 'pmtiles-drive' && s.fileId)
            .forEach(s => registerDrivePMTiles(s.fileId!, () => tokenRef.current ?? ''));
    }, [allSources]);

    const loadedTracks = useViewportTracks(token, trackIndex, viewport, categories);

    // Assign colours to peak sets
    const loadedPeaks = peakSets.map((ps, i) => ({
        ...ps,
        color: PEAK_COLORS[i % PEAK_COLORS.length],
    }));

    const handleTrackClick = useCallback(
        (fileId: string) => {
            const entry = trackIndex?.tracks.find(t => t.fileId === fileId);
            if (!entry) return;
            setPopup({ title: entry.displayName, body: entry.date ?? '' });
        },
        [trackIndex],
    );

    const handlePeakClick = useCallback((name: string, elevation: number, category: string) => {
        setPopup({
            title: name,
            body: `${category}  ·  ${Math.round(elevation).toLocaleString()} m`,
        });
    }, []);

    const handleStyleLoad = useCallback((sourceId: string) => {
        lastGoodSourceIdRef.current = sourceId;
        setMapError(null);
    }, []);

    const handleMapError = useCallback((message: string) => {
        setMapError(message);
    }, []);

    const handleStyleFail = useCallback(
        (message: string) => {
            setMapError(message);
            const fallback = lastGoodSourceIdRef.current;
            if (fallback) setSource(fallback);
        },
        [setSource],
    );

    const allIndexedTracks = trackIndex?.tracks ?? [];

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            {/* Map fills viewport — only rendered once a source is available */}
            {activeSource && (
                <MapView
                    source={activeSource}
                    initialCenter={savedCenter.current}
                    initialZoom={savedZoom.current}
                    onMove={handleMove}
                    categories={categories}
                    loadedTracks={loadedTracks}
                    loadedPeaks={loadedPeaks}
                    onBoundsChange={setViewport}
                    onTrackClick={handleTrackClick}
                    onPeakClick={handlePeakClick}
                    onError={handleMapError}
                    onStyleLoad={handleStyleLoad}
                    onStyleFail={handleStyleFail}
                    flyToBbox={flyToBbox}
                />
            )}

            <MapStyleSelector
                sources={allSources}
                activeId={activeSource?.id ?? ''}
                sidebarOpen={sidebarOpen}
                onSelect={setSource}
            />

            {/* Hamburger */}
            <button style={styles.hamburger} onClick={() => setSidebarOpen(true)} title="Menu">
                ☰
            </button>

            {/* Auth button */}
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

            {/* Loading indicator */}
            {token && !ready && (
                <div style={styles.loadingBanner}>{building ? (progress ?? 'Building index…') : 'Loading…'}</div>
            )}

            {/* Auth error */}
            {authError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{authError}</div>}

            {/* Drive data error (init or rebuild failure) */}
            {driveError && <div style={{ ...styles.loadingBanner, background: '#c62828' }}>{driveError}</div>}

            {/* Tile source config error */}
            {loadError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map config error: {loadError}</div>
            )}

            {/* Map style load error */}
            {mapError && (
                <div style={{ ...styles.loadingBanner, background: '#c62828' }}>Map style error: {mapError}</div>
            )}

            {/* Location + controls */}
            <MapControls onLocate={setFlyToBbox} />

            {/* Sidebar */}
            <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                categories={categories}
                visibleTracks={allIndexedTracks}
                onFlyToTrack={bbox => {
                    setFlyToBbox(bbox);
                    setSidebarOpen(false);
                }}
                peakSets={peakSets}
                indexGenerated={trackIndex?.generated ?? null}
                indexTrackCount={trackIndex?.tracks.length ?? 0}
                building={building}
                progress={progress}
                onRebuild={rebuildIndex}
            />

            {/* Popup */}
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
    authArea: {
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 10,
    },
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
    popupTitle: {
        fontSize: 16,
        fontWeight: 600,
        marginBottom: 4,
        paddingRight: 24,
    },
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
