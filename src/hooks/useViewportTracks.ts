import { useState, useEffect, useRef, useCallback } from 'react'
import { queryByBbox } from '../lib/spatialIndex'
import { parseTrackGpx } from '../lib/gpxParser'
import { api, isReady } from '../lib/dataApi'
import type { TrackIndex, IndexEntry } from '../lib/spatialIndex'
import type { TrackBbox } from '../lib/gpxParser'
import type { FeatureCollection, LineString } from 'geojson'
import type { TrackCategory } from './useDriveData'

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
  viewport: TrackBbox | null,
  categories: TrackCategory[]
) {
  const [loadedTracks, setLoadedTracks] = useState<LoadedTrack[]>([])
  const cacheRef = useRef<Map<string, LoadedTrack>>(new Map())
  const loadingRef = useRef<Set<string>>(new Set())

  const loadTracks = useCallback(async (tok: string | null, entries: IndexEntry[]) => {
    const toLoad = entries.filter(e => !cacheRef.current.has(e.fileId) && !loadingRef.current.has(e.fileId))
    if (toLoad.length === 0) return

    toLoad.forEach(e => loadingRef.current.add(e.fileId))

    const CONCURRENCY = 5
    for (let i = 0; i < toLoad.length; i += CONCURRENCY) {
      const batch = toLoad.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async entry => {
        try {
          const text = await api.readFileText(tok, entry.fileId)
          const parsed = parseTrackGpx(text, entry.filename)
          cacheRef.current.set(entry.fileId, {
            fileId: entry.fileId,
            category: entry.category,
            displayName: entry.displayName,
            date: entry.date,
            geojson: parsed.geojson,
          })
        } catch {
          // skip unreadable track
        } finally {
          loadingRef.current.delete(entry.fileId)
        }
      }))
      setLoadedTracks([...cacheRef.current.values()])
    }
  }, [])

  useEffect(() => {
    if (!isReady(token) || !trackIndex || !viewport) return

    const viewportSpan = viewport.east - viewport.west
    const catLookup = new Map(categories.map(c => [c.name, c]))

    const matching = queryByBbox(trackIndex, viewport).filter(entry => {
      const cat = catLookup.get(entry.category)
      return !cat?.maxViewportSpan || viewportSpan <= cat.maxViewportSpan
    })

    if (matching.length === 0) return
    loadTracks(token, matching)
  }, [token, trackIndex, viewport, categories, loadTracks])

  // Clear cache on sign-out
  useEffect(() => {
    if (!isReady(token)) {
      cacheRef.current.clear()
      setLoadedTracks([])
    }
  }, [token])

  return loadedTracks
}
