import type { TrackCategory } from '../hooks/useDriveData';

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
    hiddenDonePeakCategories: string[];
    onToggleDonePeakCategory: (name: string) => void;
    trackCount: number;
    indexGenerated: string | null;
    unindexedCount: number;
}

export function Sidebar({
    open,
    onClose,
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
    hiddenDonePeakCategories,
    onToggleDonePeakCategory,
    trackCount,
    indexGenerated,
    unindexedCount,
}: Props) {
    return (
        <>
            {open && <div style={styles.backdrop} />}
            <div style={{ ...styles.drawer, transform: open ? 'translateX(0)' : 'translateX(-100%)' }}>
                <div style={styles.header}>
                    <span style={styles.title}>Done It</span>
                    <button style={styles.closeBtn} onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div style={styles.body}>
                    {/* Category visibility */}
                    <Section label="Categories">
                        {categories.map(cat => {
                            const hidden = hiddenCategories.includes(cat.name);
                            return (
                                <button
                                    key={cat.name}
                                    style={styles.filterRow}
                                    onClick={() => onToggleCategory(cat.name)}
                                >
                                    <span
                                        style={{ ...styles.swatch, background: cat.color, opacity: hidden ? 0.3 : 1 }}
                                    />
                                    <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>
                                        {cat.label}
                                    </span>
                                    <span style={styles.toggle}>{hidden ? '○' : '●'}</span>
                                </button>
                            );
                        })}
                        {categories.length === 0 && <p style={styles.empty}>No categories found</p>}
                    </Section>

                    {/* Track type visibility */}
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

                    {/* Peaks */}
                    {peakCategories.length > 0 && (
                        <Section label="Peaks">
                            {peakCategories.map(pc => {
                                const hidden = pc.indexed && hiddenPeakCategories.includes(pc.name);
                                const doneHidden = hiddenDonePeakCategories.includes(pc.name);
                                const doneCount = pc.indexed ? (baggedCountByCategory[pc.name] ?? 0) : 0;
                                return (
                                    <div key={pc.name} style={styles.filterRow}>
                                        <span
                                            style={{
                                                ...styles.swatch,
                                                background: pc.color,
                                                borderRadius: '50%',
                                                opacity: hidden ? 0.3 : 1,
                                            }}
                                        />
                                        <span style={{ ...styles.filterLabel, opacity: hidden ? 0.4 : 1 }}>
                                            {pc.label}
                                        </span>
                                        {doneCount > 0 && (
                                            <span style={styles.doneCount}>
                                                {doneCount}/{pc.count}
                                            </span>
                                        )}
                                        {pc.indexed && doneCount > 0 && (
                                            <button
                                                style={styles.doneToggleBtn}
                                                onClick={() => onToggleDonePeakCategory(pc.name)}
                                                title={doneHidden ? 'Show done' : 'Hide done'}
                                            >
                                                {doneHidden ? '○' : '●'}
                                            </button>
                                        )}
                                        {pc.indexed && (
                                            <button
                                                style={styles.toggleBtn}
                                                onClick={() => onTogglePeakCategory(pc.name)}
                                                title={hidden ? 'Show' : 'Hide'}
                                            >
                                                {hidden ? '○' : '●'}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </Section>
                    )}

                    {/* Info */}
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
                    </Section>
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
    backdrop: {
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: 300,
        right: 0,
        background: 'rgba(0,0,0,0.3)',
        zIndex: 19,
        pointerEvents: 'none',
    },
    drawer: {
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        width: 300,
        background: '#fff',
        boxShadow: '2px 0 12px rgba(0,0,0,0.2)',
        zIndex: 20,
        transition: 'transform 0.25s ease',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'hidden',
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
    filterLabel: { fontSize: 14, flex: 1, color: '#222' },
    toggle: { fontSize: 12, color: '#1a73e8', flexShrink: 0 },
    toggleBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#1a73e8', flexShrink: 0, padding: 0 },
    doneToggleBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#4caf50', flexShrink: 0, padding: 0 },
    doneCount: { fontSize: 11, color: '#4caf50', flexShrink: 0 },
    metaRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
    count: { fontSize: 11, color: '#999', marginLeft: 'auto' },
    meta: { fontSize: 12, color: '#666', margin: '0 0 4px' },
    empty: { fontSize: 13, color: '#999', fontStyle: 'italic' },
};
