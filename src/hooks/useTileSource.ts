import { useState, useEffect, useCallback } from "react";
import { loadTileSources, type TileSource } from "../lib/tileConfig";
import { isReady } from "../lib/dataApi";

const ACTIVE_KEY = "doneit-tile-source";
const CACHE_KEY = "doneit-tile-sources-cache";

function readCache(): TileSource[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as TileSource[]) : [];
  } catch {
    return [];
  }
}

export function useTileSource(token: string | null) {
  const [sources, setSources] = useState<TileSource[]>(readCache);
  const [activeId, setActiveId] = useState<string>(
    () => localStorage.getItem(ACTIVE_KEY) ?? "",
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady(token)) return;
    setLoadError(null);
    loadTileSources(token)
      .then((loaded) => {
        setSources(loaded);
        localStorage.setItem(CACHE_KEY, JSON.stringify(loaded));
        setActiveId((prev) =>
          loaded.some((s) => s.id === prev) ? prev : loaded[0].id,
        );
      })
      .catch((err) => {
        console.error("[useTileSource] Failed to load tile sources:", err);
        setLoadError(String(err?.message ?? err));
      });
  }, [token]);

  const activeSource =
    sources.find((s) => s.id === activeId) ?? sources[0] ?? null;

  const setSource = useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  return { allSources: sources, activeSource, setSource, loadError };
}
