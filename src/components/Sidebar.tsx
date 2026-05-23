import { useState, useMemo, useRef, useEffect } from 'react';
import type { TrackCategory, LoadedRoute } from '../hooks/useDriveData';
import type { SyncStatus, SyncProgress } from '../hooks/useSync';
import type { PanelId } from './IconBar';
import type { TileSource } from '../lib/tileConfig';
import type { OverlayEntry } from '../hooks/useDriveData';
import { LayersPanel } from './LayersPanel';

type RouteSortOrder = 'date' | 'closest' | 'name' | 'length';

function routeDistanceSq(route: LoadedRoute, mapLat: number, mapLng: number): number {
    const bbox = route.bbox;
    if (!bbox) return Infinity;
    const clat = (bbox.south + bbox.north) / 2;
    const clng = (bbox.west + bbox.east) / 2;
    const dlat = clat - mapLat;
    const dlng = (clng - mapLng) * Math.cos(mapLat * Math.PI / 180);
    return dlat * dlat + dlng * dlng;
}

interface PeakCategory {
    name: string;
    label: string;
    count: number;
    color: string;
    indexed: boolean;
}

interface Props {
    open: boolean;
    onClose: () => void;
    activeSection: PanelId | null;
    sources: TileSource[];
    activeSourceId: string;
    onSelectSource: (id: string) => void;
    rowAccessLevel: number;
    onRowAccessChange: (value: number) => void;
    categories: TrackCategory[];
    hiddenCategories: string[];
    onToggleCategory: (name: string) => void;
    trackTypes: string[];
    hiddenTrackTypes: string[];
    onToggleTrackType: (t: string) => void;
    peakCategories: PeakCategory[];
    hiddenPeakCategories: string[];
    onTogglePeakCategory: (name: string) => void;
    baggedCountByCategory: Record<string, number>;
    trackCount: number;
    indexGenerated: string | null;
    unindexedCount: number;
    zoom: number;
    syncStatus: SyncStatus;
    syncProgress: SyncProgress | null;
    lastSynced: string | null;
    onSync: () => void;
    onCancelSync: () => void;
    loadedRoutes: LoadedRoute[];
    hiddenRoutes: string[];
    onToggleRoute: (fileId: string) => void;
    rowPmtilesFileId: string | null;
    overlayEntries: OverlayEntry[];
    hiddenOverlayFilenames: string[];
    onToggleOverlayFilename: (filename: string) => void;
    mapCenter: [number, number];
}

const SECTION_TITLE: Partial<Record<PanelId, string>> = {
    layers:   'Layers',
    tracks:   'Tracks',
    peaks:    'Peaks',
    routes:   'Routes',
    settings: 'Settings',
};

export function Sidebar({
    open,
    onClose,
    activeSection,
    sources,
    activeSourceId,
    onSelectSource,
    rowAccessLevel,
    onRowAccessChange,
    categories,
    hiddenCategories,
    onToggleCategory,
    trackTypes,
    hiddenTrackTypes,
    onToggleTrackType,
    peakCategories,
    hiddenPeakCategories,
    onTogglePeakCategory,
    baggedCountByCategory,
    trackCount,
    indexGenerated,
    unindexedCount,
    zoom,
    syncStatus,
    syncProgress,
    lastSynced,
    onSync,
    onCancelSync,
    loadedRoutes,
    hiddenRoutes,
    onToggleRoute,
    rowPmtilesFileId,
    overlayEntries,
    hiddenOverlayFilenames,
    onToggleOverlayFilename,
    mapCenter,
}: Props) {
    const [routeSortOrder, setRouteSortOrder] = useState<RouteSortOrder>('date');
    const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(300, window.innerWidth - 16));
    const isDragging = useRef(false);
    const dragStartX = useRef(0);
    const dragStartWidth = useRef(0);

    useEffect(() => {
        const onMove = (e: MouseEvent | TouchEvent) => {
            if (!isDragging.current) return;
            const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const newWidth = Math.max(200, Math.min(dragStartWidth.current + x - dragStartX.current, window.innerWidth - 16));
            setSidebarWidth(newWidth);
        };
        const onUp = () => { isDragging.current = false; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: true });
        window.addEventListener('touchend', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
        };
    }, []);

    const handleResizeStart = (e: React.MouseEvent | React.TouchEvent) => {
        isDragging.current = true;
        dragStartX.current = 'touches' in e ? e.touches[0].clientX : e.clientX;
        dragStartWidth.current = sidebarWidth;
        e.preventDefault();
    };

    const sortedRoutes = useMemo(() => {
        const [mapLng, mapLat] = mapCenter;
        return [...loadedRoutes].sort((a, b) => {
            switch (routeSortOrder) {
                case 'date':    return (b.date ?? '').localeCompare(a.date ?? '');
                case 'name':    return a.displayName.localeCompare(b.displayName);
                case 'length':  return (b.lengthKm ?? 0) - (a.lengthKm ?? 0);
                case 'closest': return routeDistanceSq(a, mapLat, mapLng) - routeDistanceSq(b, mapLat, mapLng);
            }
        });
    }, [loadedRoutes, routeSortOrder, mapCenter]);

    const title = activeSection ? (SECTION_TITLE[activeSection] ?? 'Done It') : 'Done It';

    return (
        <>

            <div style={{ ...styles.drawer, width: sidebarWidth, transform: open ? 'translateX(0)' : 'translateX(-100%)', pointerEvents: open ? 'auto' : 'none' }}>
                <div
                    style={styles.resizeHandle}
                    onMouseDown={handleResizeStart}
                    onTouchStart={handleResizeStart}
                />
                <div style={styles.header}>
                    <span style={styles.title}>{title}</span>
                    <button style={styles.closeBtn} onClick={onClose}>✕</button>
                </div>

                <div style={styles.body}>
                    {activeSection === 'layers' && (
                        <div style={styles.layersBody}>
                            <LayersPanel
                                sources={sources}
                                activeId={activeSourceId}
                                onSelect={onSelectSource}
                                rowPmtilesFileId={rowPmtilesFileId}
                                rowAccessLevel={rowAccessLevel}
                                onRowAccessChange={onRowAccessChange}
                                overlayEntries={overlayEntries}
                                hiddenOverlayFilenames={hiddenOverlayFilenames}
                                onToggleOverlayFilename={onToggleOverlayFilename}
                            />
                        </div>
                    )}

                    {activeSection === 'tracks' && (
                        <>
                            <Section label="Categories">
                                {categories.map(cat => {
                                    const hidden = hiddenCategories.includes(cat.name);
                                    return (
                                        <button key={cat.name} style={styles.filterRow} onClick={() => onToggleCategory(cat.name)}>
                                            <span style={{ ...styles.swatch, background: cat.color, opacity: hidden ? 0.3 : 1 }} />
                                            <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>{cat.label}</span>
                                            <span style={styles.toggle}>{hidden ? '○' : '●'}</span>
                                        </button>
                                    );
                                })}
                                {categories.length === 0 && <p style={styles.empty}>No categories found</p>}
                            </Section>

                            {trackTypes.length > 0 && (
                                <Section label="Activity type">
                                    {trackTypes.map(t => {
                                        const hidden = hiddenTrackTypes.includes(t);
                                        return (
                                            <button key={t} style={styles.filterRow} onClick={() => onToggleTrackType(t)}>
                                                <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>{t}</span>
                                                <span style={styles.toggle}>{hidden ? '○' : '●'}</span>
                                            </button>
                                        );
                                    })}
                                </Section>
                            )}
                        </>
                    )}

                    {activeSection === 'peaks' && (
                        <Section label="Peaks">
                            {peakCategories.length === 0 && <p style={styles.empty}>No peaks loaded</p>}
                            {peakCategories.map(pc => {
                                const hidden = pc.indexed && hiddenPeakCategories.includes(pc.name);
                                const doneCount = pc.indexed ? (baggedCountByCategory[pc.name] ?? 0) : 0;
                                return (
                                    <button
                                        key={pc.name}
                                        style={{ ...styles.filterRow, cursor: pc.indexed ? 'pointer' : 'default' }}
                                        onClick={pc.indexed ? () => onTogglePeakCategory(pc.name) : undefined}
                                    >
                                        <span style={{ ...styles.swatch, background: pc.color, borderRadius: '50%', opacity: hidden ? 0.3 : 1 }} />
                                        <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>{pc.label}</span>
                                        {doneCount > 0 && <span style={styles.doneCount}>{doneCount}/{pc.count}</span>}
                                        {pc.indexed && <span style={styles.toggle}>{hidden ? '○' : '●'}</span>}
                                    </button>
                                );
                            })}
                        </Section>
                    )}

                    {activeSection === 'routes' && (
                        <Section label="Routes">
                            {loadedRoutes.length === 0 && <p style={styles.empty}>No routes loaded</p>}
                            <div style={styles.chipRow}>
                                {(['date', 'name', 'length', 'closest'] as RouteSortOrder[]).map(order => (
                                    <button
                                        key={order}
                                        style={{ ...styles.chip, ...(routeSortOrder === order ? styles.chipActive : {}) }}
                                        onClick={() => setRouteSortOrder(order)}
                                    >
                                        {order === 'closest' ? 'Nearest' : order.charAt(0).toUpperCase() + order.slice(1)}
                                    </button>
                                ))}
                            </div>
                            {sortedRoutes.map(route => {
                                const hidden = hiddenRoutes.includes(route.fileId);
                                return (
                                    <button key={route.fileId} style={styles.filterRow} onClick={() => onToggleRoute(route.fileId)}>
                                        <span style={{ ...styles.routeSwatch, background: route.color, opacity: hidden ? 0.3 : 1 }} />
                                        <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>
                                            {route.displayName}
                                            {route.lengthKm !== null && <span style={styles.routeMeta}> · {route.lengthKm.toFixed(1)} km</span>}
                                        </span>
                                        <span style={styles.toggle}>{hidden ? '○' : '●'}</span>
                                    </button>
                                );
                            })}
                        </Section>
                    )}

                    {activeSection === 'settings' && (
                        <>
                            <Section label="Index">
                                <p style={styles.meta}>
                                    {trackCount} tracks in PMTiles
                                    {indexGenerated && ` · built ${indexGenerated.slice(0, 10)}`}
                                </p>
                                {unindexedCount > 0 && (
                                    <p style={styles.meta}>
                                        {unindexedCount} new track{unindexedCount !== 1 ? 's' : ''} (GPX, not yet in PMTiles)
                                    </p>
                                )}
                                <p style={styles.meta}>Zoom: {zoom.toFixed(1)}</p>
                            </Section>

                            <Section label="Offline cache">
                                {syncStatus === 'syncing' && syncProgress ? (
                                    <p style={styles.meta}>{syncProgress.currentFile} ({syncProgress.done}/{syncProgress.total})</p>
                                ) : lastSynced ? (
                                    <p style={styles.meta}>Last synced: {lastSynced.slice(0, 10)}</p>
                                ) : (
                                    <p style={styles.meta}>Not yet synced</p>
                                )}
                                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                    <button style={styles.syncBtn} onClick={onSync} disabled={syncStatus === 'syncing'}>
                                        {syncStatus === 'syncing' ? 'Syncing…' : 'Sync now'}
                                    </button>
                                    {syncStatus === 'syncing' && (
                                        <button style={styles.syncBtn} onClick={onCancelSync}>Cancel</button>
                                    )}
                                </div>
                            </Section>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={styles.section}>
            <div style={styles.sectionLabel}>{label}</div>
            {children}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {

    drawer: {
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 96,   // stops above icon bar
        background: '#fff',
        boxShadow: '2px 0 12px rgba(0,0,0,0.2)',
        zIndex: 20,
        transition: 'transform 0.25s ease',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'hidden',
    },
    resizeHandle: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 8,
        cursor: 'col-resize',
        zIndex: 1,
        touchAction: 'none',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 16px 12px',
        borderBottom: '1px solid #eee',
        flexShrink: 0,
    },
    title: { fontSize: 18, fontWeight: 600, color: '#1a73e8' },
    closeBtn: {
        background: 'none',
        border: 'none',
        fontSize: 18,
        cursor: 'pointer',
        color: '#666',
        width: 44,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: -8,
    },
    body: { overflowY: 'auto', flex: 1, padding: '8px 0' },
    section: { padding: '12px 16px', borderBottom: '1px solid #f0f0f0' },
    sectionLabel: {
        fontSize: 11,
        fontWeight: 600,
        color: '#888',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 8,
    },
    filterRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '5px 0',
    },
    swatch: { width: 12, height: 12, borderRadius: 2, flexShrink: 0 },
    filterLabel: { fontSize: 14, flex: 1, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
    toggle: { fontSize: 12, color: '#1a73e8', flexShrink: 0 },
    doneCount: { fontSize: 11, color: '#4caf50', flexShrink: 0 },
    meta: { fontSize: 12, color: '#666', margin: '0 0 4px' },
    empty: { fontSize: 13, color: '#999', fontStyle: 'italic' },
    chipRow: { display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' as const },
    chip: {
        padding: '2px 8px',
        borderRadius: 10,
        background: '#f0f0f0',
        border: '1px solid #ddd',
        cursor: 'pointer',
        fontSize: 11,
        color: '#555',
    },
    chipActive: { background: '#1a73e8', color: '#fff', borderColor: '#1a73e8' },
    routeSwatch: {
        display: 'inline-block',
        width: 14,
        height: 4,
        borderRadius: 2,
        flexShrink: 0,
    },
    routeMeta: { fontSize: 11, color: '#999' },
    layersBody: {
        padding: '12px 16px',
    },
    syncBtn: {
        padding: '5px 12px',
        borderRadius: 14,
        background: '#1a73e8',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 500,
    },
};
