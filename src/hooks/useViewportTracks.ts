import { useState, useEffect, useRef, useCallback } from 'react'
import { queryByBbox } from '../lib/spatialIndex'
import { parseTrackGpx } from '../lib/gpxParser'
import { api, isReady } from '../lib/dataApi'
import type { TrackIndex } from '../lib/spatialIndex'
import type { TrackBbox } from '../lib/gpxParser'
import type { FeatureCollection, LineString } from 'geojson'

const MIN_ZOOM_APPROX_DEG = 10.0  // roughly zoom 6 in degrees-per-viewport

export interface LoadedTrack {
  fileId: string
  category: string
  displayName: string
  date: string | null
  geojson: FeatureCollection<LineString>
}

export function useViewportTracks(
  token: string | null,
  trackIndex: TrackIndex | null,
  viewport: TrackBbox | null
) {
  const [loadedTracks, setLoadedTracks] = useState<LoadedTrack[]>([])
  const cacheRef = useRef<Map<string, LoadedTrack>>(new Map())
  const loadingRef = useRef<Set<string>>(new Set())

  const loadTracks = useCallback(async (
    tok: string | null,
    fileIds: string[],
    index: TrackIndex
  ) => {
    const toLoad = fileIds.filter(id => !cacheRef.current.has(id) && !loadingRef.current.has(id))
    if (toLoad.length === 0) return

    toLoad.forEach(id => loadingRef.current.add(id))

    const CONCURRENCY = 5
    for (let i = 0; i < toLoad.length; i += CONCURRENCY) {
      const batch = toLoad.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async fileId => {
        const entry = index.tracks.find(t => t.fileId === fileId)
        if (!entry) return
        try {
          const text = await api.readFileText(tok, fileId)
          const parsed = parseTrackGpx(text, entry.filename)
          const loaded: LoadedTrack = {
            fileId,
            category: entry.category,
            displayName: entry.displayName,
            date: entry.date,
            geojson: parsed.geojson,
          }
          cacheRef.current.set(fileId, loaded)
        } catch {
          // skip unreadable tracks
        } finally {
          loadingRef.current.delete(fileId)
        }
      }))

      setLoadedTracks([...cacheRef.current.values()])
    }
  }, [])

  useEffect(() => {
    if (!isReady(token) || !trackIndex || !viewport) return

    const viewportSpan = viewport.east - viewport.west
    if (viewportSpan > MIN_ZOOM_APPROX_DEG) return  // too zoomed out

    const matching = queryByBbox(trackIndex, viewport)
    const ids = matching.map(e => e.fileId)
    if (ids.length === 0) return

    loadTracks(token, ids, trackIndex)
  }, [token, trackIndex, viewport, loadTracks])

  // Clear cache on sign-out (Drive mode only)
  useEffect(() => {
    if (!isReady(token)) {
      cacheRef.current.clear()
      setLoadedTracks([])
    }
  }, [token])

  return loadedTracks
}
