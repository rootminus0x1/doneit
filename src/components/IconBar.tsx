import { useState } from 'react';

export type PanelId = 'layers' | 'tracks' | 'peaks' | 'routes' | 'settings';

interface IconBarItem {
    id: PanelId;
    label: string;
    icon: string;
}

const ITEMS: IconBarItem[] = [
    { id: 'layers',   label: 'Layers',   icon: '🗺' },
    { id: 'tracks',   label: 'Tracks',   icon: '📊' },
    { id: 'peaks',    label: 'Peaks',    icon: '⛰' },
    { id: 'routes',   label: 'Routes',   icon: '〰' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
];

interface Props {
    active: PanelId | null;
    onSelect: (id: PanelId | null) => void;
}

export function IconBar({ active, onSelect }: Props) {
    const [hovered, setHovered] = useState<PanelId | null>(null);

    return (
        <div style={styles.bar}>
            {ITEMS.map(item => {
                const isActive = active === item.id;
                const isHovered = hovered === item.id;
                return (
                    <button
                        key={item.id}
                        style={{
                            ...styles.btn,
                            ...(isActive ? styles.active : isHovered ? styles.hover : {}),
                        }}
                        onClick={() => onSelect(isActive ? null : item.id)}
                        onMouseEnter={() => setHovered(item.id)}
                        onMouseLeave={() => setHovered(null)}
                        title={item.label}
                        aria-pressed={isActive}
                    >
                        <span style={styles.glyph}>{item.icon}</span>
                        <span style={styles.label}>{item.label}</span>
                    </button>
                );
            })}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    bar: {
        position: 'fixed',
        bottom: 36,
        left: 12,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'row',
        gap: 2,
        background: '#fff',
        borderRadius: 10,
        boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        padding: 4,
    },
    btn: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        width: 50,
        height: 50,
        borderRadius: 8,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: '#444',
        transition: 'background 0.1s, color 0.1s',
    },
    hover: {
        background: '#f0f4ff',
        color: '#1a73e8',
    },
    active: {
        background: '#e8f0fe',
        color: '#1a73e8',
    },
    glyph: {
        fontSize: 20,
        lineHeight: 1,
    },
    label: {
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: 'uppercase' as const,
        color: 'inherit',
    },
};
