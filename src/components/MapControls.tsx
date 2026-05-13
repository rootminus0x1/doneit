import { useState, useCallback } from "react";
import type { TrackBbox } from "../lib/gpxParser";

interface Props {
  onLocate: (bbox: TrackBbox) => void;
}

export function MapControls({ onLocate }: Props) {
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(false);

  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) return;
    setLocating(true);
    setLocateError(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude: lat, longitude: lon } = pos.coords;
        const d = 0.01;
        onLocate({
          west: lon - d,
          east: lon + d,
          south: lat - d,
          north: lat + d,
        });
      },
      () => {
        setLocating(false);
        setLocateError(true);
      },
      { timeout: 10000 },
    );
  }, [onLocate]);

  return (
    <div style={styles.container}>
      <button style={styles.btn} title="Locate me" onClick={handleLocate}>
        {locating ? "…" : locateError ? "✕" : "◎"}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "absolute",
    bottom: 32,
    right: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    zIndex: 10,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "none",
    background: "#fff",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    cursor: "pointer",
    fontSize: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
