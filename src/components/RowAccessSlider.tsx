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

const SLIDER_CSS = `
.row-access-slider { -webkit-appearance: none; appearance: none; background: transparent; width: 100%; cursor: pointer; height: 20px; }
.row-access-slider::-webkit-slider-runnable-track { background: #ddd; height: 4px; border-radius: 2px; }
.row-access-slider::-moz-range-track { background: #ddd; height: 4px; border-radius: 2px; }
.row-access-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #555; margin-top: -5px; }
.row-access-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #555; border: none; }
`;

export function RowAccessSlider({ value, onChange }: Props) {
    return (
        <div style={{ padding: '2px 8px 6px' }}>
            <style>{SLIDER_CSS}</style>
            <input
                type="range"
                className="row-access-slider"
                min={0}
                max={3}
                step={1}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
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
                            opacity: i <= value ? 1 : 0.3,
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
