interface Props {
    bearing?: number;
    onResetNorth?: () => void;
}

export function MapControls({ bearing = 0, onResetNorth }: Props) {
    return (
        <div style={styles.container}>
            <button style={styles.btn} title="Reset north" onClick={onResetNorth}>
                <svg
                    viewBox="0 0 24 24"
                    width="22"
                    height="22"
                    style={{
                        transform: `rotate(${-bearing}deg)`,
                        transition: 'transform 0.1s linear',
                        display: 'block',
                    }}
                >
                    <polygon points="12,3 15.5,13 12,11 8.5,13" fill="#d32f2f" />
                    <polygon points="12,21 8.5,11 12,13 15.5,11" fill="#bdbdbd" />
                </svg>
            </button>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        position: 'absolute',
        bottom: 72,
        right: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 10,
    },
    btn: {
        width: 40,
        height: 40,
        borderRadius: '50%',
        border: 'none',
        background: '#fff',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        fontSize: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
};
