import { useState, useRef } from 'react';
import type { TileSource } from '../lib/tileConfig';

const IS_TOUCH = window.matchMedia('(hover: none)').matches;

interface Props {
    sources: TileSource[];
    activeId: string;
    sidebarOpen: boolean;
    onSelect: (id: string) => void;
}

const CARD = 64;
const STEP = 5; // px offset per stacked card

export function MapStyleSelector({
    sources,
    activeId,
    sidebarOpen,
    onSelect,
}: Props) {
    const [open, setOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Delayed close so the mouse can travel from stack to panel (or back) without flickering
    const scheduleClose = () => {
        closeTimer.current = setTimeout(() => setOpen(false), 150);
    };
    const cancelClose = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
    };
    const handleEnter = () => {
        cancelClose();
        setOpen(true);
    };
    const handleLeave = () => scheduleClose();

    const baseSources = sources;
    const active = baseSources.find(s => s.id === activeId) ?? baseSources[0];
    if (!active) return null;
    const behind = baseSources.filter(s => s.id !== activeId).slice(0, 2);

    // On desktop: click cycles to the next source. On touch: tap toggles the panel open/closed.
    const handleStackClick = () => {
        if (IS_TOUCH) {
            setOpen(prev => !prev);
        } else {
            const idx = baseSources.findIndex(s => s.id === activeId);
            onSelect(baseSources[(idx + 1) % baseSources.length].id);
        }
    };

    // Container is big enough for all stacked cards (they offset bottom-right)
    const containerSize = CARD + behind.length * STEP;

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 28,
                left: sidebarOpen ? 312 : 12,
                zIndex: 10,
                transition: 'left 0.25s ease',
            }}
        >
            {/* Panel — appears on hover, above the stack */}
            {open && (
                <div style={styles.panel} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
                    {/* Left column: base map list */}
                    <div style={styles.column}>
                        <div style={styles.columnHeader}>Base map</div>
                        {baseSources.map(s => (
                            <button
                                key={s.id}
                                style={{
                                    ...styles.option,
                                    outline: s.id === activeId ? '3px solid #1a73e8' : '2px solid transparent',
                                }}
                                onClick={() => { onSelect(s.id); if (IS_TOUCH) setOpen(false); }}
                            >
                                <div style={styles.optionThumb}>
                                    <img
                                        src={`data:image/svg+xml,${encodeURIComponent(s.icon)}`}
                                        alt=""
                                        width={48}
                                        height={48}
                                        style={{ display: 'block', borderRadius: 6 }}
                                    />
                                </div>
                                <span style={styles.optionLabel}>{s.label}</span>
                            </button>
                        ))}
                    </div>

                </div>
            )}

            {/* Stack trigger — hover to expand, click to cycle */}
            <div
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onMouseEnter={handleEnter}
                onMouseLeave={handleLeave}
                onClick={handleStackClick}
            >
                <div
                    style={{
                        position: 'relative',
                        width: containerSize,
                        height: containerSize,
                    }}
                >
                    {/* Behind cards — offset bottom-right so their edges peek out */}
                    {behind.map((s, i) => {
                        const offset = (i + 1) * STEP;
                        return (
                            <div
                                key={s.id}
                                style={{
                                    position: 'absolute',
                                    top: offset,
                                    left: offset,
                                    width: CARD,
                                    height: CARD,
                                    borderRadius: 8,
                                    overflow: 'hidden',
                                    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                                    opacity: 0.7 - i * 0.15,
                                }}
                            >
                                <img
                                    src={`data:image/svg+xml,${encodeURIComponent(s.icon)}`}
                                    alt=""
                                    width={CARD}
                                    height={CARD}
                                    style={{ display: 'block' }}
                                />
                            </div>
                        );
                    })}
                    {/* Front card — active style, top-left */}
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: CARD,
                            height: CARD,
                            borderRadius: 8,
                            overflow: 'hidden',
                            boxShadow: '0 3px 10px rgba(0,0,0,0.45)',
                            zIndex: 2,
                        }}
                    >
                        <img
                            src={`data:image/svg+xml,${encodeURIComponent(active.icon)}`}
                            alt={active.label}
                            width={CARD}
                            height={CARD}
                            style={{ display: 'block' }}
                        />
                    </div>
                </div>
                <div style={styles.stackLabel}>Layers</div>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    panel: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 8,
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        padding: 8,
        display: 'flex',
        flexDirection: 'row',
        gap: 0,
        alignItems: 'flex-start',
    },
    column: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 150,
    },
    columnHeader: {
        fontSize: 10,
        fontWeight: 700,
        color: '#999',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        padding: '2px 8px 4px',
    },
    divider: {
        width: 1,
        alignSelf: 'stretch',
        background: '#eee',
        margin: '0 6px',
    },
    option: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'none',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        padding: '5px 8px',
        textAlign: 'left',
        outlineOffset: 2,
    },
    optionThumb: {
        flexShrink: 0,
        width: 48,
        height: 48,
        borderRadius: 6,
        overflow: 'hidden',
    },
    optionLabel: {
        fontSize: 13,
        fontWeight: 500,
        color: '#333',
        flex: 1,
    },
    overlayRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'none',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        padding: '6px 8px',
        textAlign: 'left',
        width: '100%',
        transition: 'opacity 0.15s',
    },
    swatch: {
        flexShrink: 0,
        width: 14,
        height: 14,
        borderRadius: 3,
    },
    toggle: {
        flexShrink: 0,
        width: 26,
        height: 14,
        borderRadius: 7,
        position: 'relative',
        transition: 'background 0.15s',
    },
    toggleThumb: {
        position: 'absolute',
        top: 1,
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: '#fff',
        transition: 'transform 0.15s',
    },
    stackLabel: {
        marginTop: 4,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        textShadow: '0 1px 3px rgba(0,0,0,0.6)',
        letterSpacing: 0.3,
    },
};
