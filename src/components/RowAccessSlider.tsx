const STOPS = [
    { icon: '✕', label: 'Off' },
    { icon: '🚗', label: 'Motor' },
    { icon: '🚲', label: 'Cycle' },
    { icon: '🥾', label: 'Foot' },
] as const;

interface Props {
    value: number;
    onChange: (value: number) => void;
}

export function RowAccessSlider({ value, onChange }: Props) {
    return (
        <div style={{ padding: '2px 8px 6px' }}>
            <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                style={{ width: '100%', cursor: 'pointer', accentColor: '#1a73e8' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                {STOPS.map((s, i) => (
                    <button
                        key={i}
                        onClick={() => onChange(i)}
                        title={s.label}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 15,
                            lineHeight: 1,
                            opacity: value === i ? 1 : 0.35,
                            padding: '2px 0',
                            transition: 'opacity 0.15s',
                        }}
                    >
                        {s.icon}
                    </button>
                ))}
            </div>
        </div>
    );
}
