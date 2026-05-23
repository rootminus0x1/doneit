import type { TileSource } from '../lib/tileConfig';
import type { OverlayEntry } from '../hooks/useDriveData';
import { RowAccessSlider } from './RowAccessSlider';

interface Props {
    sources: TileSource[];
    activeId: string;
    onSelect: (id: string) => void;
    rowAccessLevel: number;
    onRowAccessChange: (value: number) => void;
    overlayEntries: OverlayEntry[];
    hiddenOverlayFilenames: string[];
    onToggleOverlayFilename: (filename: string) => void;
}

export function LayersPanel({
    sources,
    activeId,
    onSelect,
    rowAccessLevel,
    onRowAccessChange,
    overlayEntries,
    hiddenOverlayFilenames,
    onToggleOverlayFilename,
}: Props) {
    const baseSources = sources.filter(s => s.type !== 'pmtiles-overlay');
    const overlaySources = sources.filter(s => s.type === 'pmtiles-overlay');
    const rowOverlays = overlaySources.filter(s => s.minAccessLevel !== undefined);
    const hasOverlays = rowOverlays.length > 0 || overlayEntries.length > 0;

    return (
        <div style={styles.container}>
            <div style={styles.col}>
                <div style={styles.colHeader}>Base map</div>
                {baseSources.map(s => {
                    const isActive = s.id === activeId;
                    return (
                        <button
                            key={s.id}
                            style={{ ...styles.mapRow, ...(isActive ? styles.mapRowActive : {}) }}
                            onClick={() => onSelect(s.id)}
                        >
                            <img
                                src={`data:image/svg+xml,${encodeURIComponent(s.icon)}`}
                                alt=""
                                width={28}
                                height={28}
                                style={styles.mapThumb}
                            />
                            <span style={{ ...styles.mapLabel, ...(isActive ? styles.mapLabelActive : {}) }}>
                                {s.label}
                            </span>
                            {isActive && <span style={styles.check}>✓</span>}
                        </button>
                    );
                })}
            </div>

            <div style={styles.divider} />

            <div style={styles.col}>
                <div style={styles.colHeader}>Overlays</div>
                {!hasOverlays ? (
                    <p style={styles.empty}>No overlays</p>
                ) : (
                    <>
                        {rowOverlays.length > 0 && (
                            <>
                                <div style={styles.overlayName}>Rights of Way</div>
                                <RowAccessSlider value={rowAccessLevel} onChange={onRowAccessChange} />
                            </>
                        )}
                        {overlayEntries.map(ov => {
                            const hidden = hiddenOverlayFilenames.includes(ov.filename);
                            return (
                                <button
                                    key={ov.filename}
                                    style={styles.overlayRow}
                                    onClick={() => onToggleOverlayFilename(ov.filename)}
                                >
                                    <span style={{ ...styles.overlaySwatch, background: ov.color, opacity: hidden ? 0.3 : 1 }} />
                                    <span style={{ ...styles.overlayLabel, opacity: hidden ? 0.4 : 1 }}>
                                        {ov.displayName}
                                        {ov.lengthKm !== null && (
                                            <span style={styles.meta}> · {ov.lengthKm.toFixed(1)} km</span>
                                        )}
                                    </span>
                                    <span style={styles.toggle}>{hidden ? '○' : '●'}</span>
                                </button>
                            );
                        })}
                    </>
                )}
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        display: 'flex',
        flexDirection: 'row',
        gap: 0,
        padding: '4px 0',
    },
    col: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
    },
    colHeader: {
        fontSize: 11,
        fontWeight: 600,
        color: '#888',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 6,
        padding: '0 4px',
    },
    divider: {
        width: 1,
        background: '#eee',
        margin: '0 10px',
        flexShrink: 0,
    },
    mapRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '4px 4px',
        borderRadius: 6,
    },
    mapRowActive: {
        background: '#e8f0fe',
    },
    mapThumb: {
        borderRadius: 4,
        flexShrink: 0,
        display: 'block',
    },
    mapLabel: {
        fontSize: 12,
        color: '#333',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
    },
    mapLabelActive: {
        color: '#1a73e8',
        fontWeight: 600,
    },
    check: {
        fontSize: 12,
        color: '#1a73e8',
        flexShrink: 0,
    },
    overlayName: {
        fontSize: 12,
        fontWeight: 500,
        color: '#333',
        padding: '2px 4px 4px',
    },
    overlayRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '4px 4px',
        borderRadius: 4,
    },
    toggle: { fontSize: 12, color: '#1a73e8', flexShrink: 0 },
    overlaySwatch: {
        width: 10,
        height: 10,
        borderRadius: 2,
        flexShrink: 0,
        background: '#1d4ed8',
    },
    meta: { fontSize: 11, color: '#999' },
    overlayLabel: {
        fontSize: 12,
        color: '#333',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
    },
    empty: {
        fontSize: 12,
        color: '#999',
        fontStyle: 'italic',
        padding: '2px 4px',
        margin: 0,
    },
};
