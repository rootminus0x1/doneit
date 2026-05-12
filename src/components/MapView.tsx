import { useEffect, useRef, useState } from 'react'
import maplibregl, { type LngLatBoundsLike, type StyleSpecification, type SourceSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { TileSource } from '../lib/tileConfig'
import { buildRasterStyle } from '../lib/tileConfig'
import type { TrackCategory } from '../hooks/useDriveData'
import type { FeatureCollection, LineString, Point } from 'geojson'
import type { TrackBbox } from '../lib/gpxParser'

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)

function styleFor(source: TileSource): string | StyleSpecification {
  return source.type === 'raster'
    ? buildRasterStyle(source) as StyleSpecification
    : source.styleUrl!
}

export interface LoadedTrack {
  fileId: string
  category: string
  geojson: FeatureCollection<LineString>
}

export interface LoadedPeaks {
  category: string
  geojson: FeatureCollection<Point>
  color: string
}

interface Props {
  source: TileSource
  initialCenter: [number, number]
  initialZoom: number
  categories: TrackCategory[]
  loadedTracks: LoadedTrack[]
  loadedPeaks: LoadedPeaks[]
  onBoundsChange: (bounds: TrackBbox) => void
  onMove: (center: [number, number], zoom: number) => void
  onTrackClick: (fileId: string) => void
  onPeakClick: (name: string, elevation: number, category: string) => void
  onError: (message: string) => void
  onStyleLoad?: (sourceId: string) => void
  onStyleFail?: (message: string) => void
  flyToBbox?: TrackBbox | null
}

// Copies track/peak sources and layers from the previous style into the next one
// so they remain visible throughout a style switch.
function preserveCustomLayers(
  prev: StyleSpecification | undefined,
  next: StyleSpecification
): StyleSpecification {
  if (!prev) return next
  const customSources: Record<string, SourceSpecification> = {}
  for (const [id, src] of Object.entries(prev.sources ?? {})) {
    if (id.startsWith('track-') || id.startsWith('peaks-')) {
      customSources[id] = src as SourceSpecification
    }
  }
  const customLayers = (prev.layers ?? []).filter(
    l => l.id.startsWith('track-line-') || l.id.startsWith('peaks-circle-')
  )
  return {
    ...next,
    sources: { ...next.sources, ...customSources },
    layers: [...next.layers, ...customLayers],
  }
}

export function MapView({
  source,
  initialCenter,
  initialZoom,
  categories,
  loadedTracks,
  loadedPeaks,
  onBoundsChange,
  onMove,
  onTrackClick,
  onPeakClick,
  onError,
  onStyleLoad,
  onStyleFail,
  flyToBbox,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  // Tracks which source the map is currently showing, to skip redundant setStyle calls
  const loadedSourceIdRef = useRef<string | null>(null)

  // Stable callback refs — updates never re-run the init effect
  const onBoundsChangeRef = useRef(onBoundsChange)
  const onMoveRef = useRef(onMove)
  const onTrackClickRef = useRef(onTrackClick)
  const onPeakClickRef = useRef(onPeakClick)
  const onErrorRef = useRef(onError)
  const onStyleLoadRef = useRef(onStyleLoad)
  const onStyleFailRef = useRef(onStyleFail)
  useEffect(() => { onBoundsChangeRef.current = onBoundsChange })
  useEffect(() => { onMoveRef.current = onMove })
  useEffect(() => { onTrackClickRef.current = onTrackClick })
  useEffect(() => { onPeakClickRef.current = onPeakClick })
  useEffect(() => { onErrorRef.current = onError })
  useEffect(() => { onStyleLoadRef.current = onStyleLoad })
  useEffect(() => { onStyleFailRef.current = onStyleFail })

  // Increments whenever the style finishes loading, triggering layer effects
  const [mapVersion, setMapVersion] = useState(0)
  // True once style.load has fired at least once — used to suppress tile-level error noise
  const styleLoadedRef = useRef(false)

  // Create the map once. Destroyed only on unmount — style switches use setStyle below.
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleFor(source),
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    mapRef.current = map
    loadedSourceIdRef.current = source.id

    map.on('moveend', () => {
      const c = map.getCenter()
      onMoveRef.current([c.lng, c.lat], map.getZoom())
      const b = map.getBounds()
      onBoundsChangeRef.current({
        west: b.getWest(), east: b.getEast(),
        south: b.getSouth(), north: b.getNorth(),
      })
    })

    map.on('error', e => {
      // Only surface errors before the first style.load — after that, errors are mostly
      // transient tile fetch failures (404, rate limit) which the user can't action.
      if (!styleLoadedRef.current) {
        onErrorRef.current(e.error?.message ?? 'Map error')
      } else {
        console.error('[MapView]', e.error?.message ?? e)
      }
    })

    // style.load fires on initial load AND after every setStyle call
    map.on('style.load', () => {
      styleLoadedRef.current = true
      onStyleLoadRef.current?.(loadedSourceIdRef.current!)
      const b = map.getBounds()
      onBoundsChangeRef.current({
        west: b.getWest(), east: b.getEast(),
        south: b.getSouth(), north: b.getNorth(),
      })
      setMapVersion(v => v + 1)
    })

    return () => {
      map.remove()
      mapRef.current = null
      loadedSourceIdRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When the source prop changes, update the style in place — no remount.
  // For vector sources, fetch and validate the style URL before calling setStyle so a
  // bad URL never reaches MapLibre (which can hang internally without emitting an error).
  useEffect(() => {
    const map = mapRef.current
    if (!map || loadedSourceIdRef.current === source.id) return

    if (source.type === 'vector' && source.styleUrl) {
      const controller = new AbortController()
      fetch(source.styleUrl, { signal: controller.signal })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json() as Promise<unknown>
        })
        .then(json => {
          if (controller.signal.aborted) return
          if (typeof (json as Record<string, unknown>).version !== 'number') {
            throw new Error('Response is not a MapLibre style document')
          }
          loadedSourceIdRef.current = source.id
          map.setStyle(source.styleUrl!, { transformStyle: preserveCustomLayers })
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return
          const msg = err instanceof Error ? err.message : String(err)
          onStyleFailRef.current?.(`Cannot load "${source.label}": ${msg}`)
        })
      return () => { controller.abort() }
    }

    loadedSourceIdRef.current = source.id
    map.setStyle(styleFor(source), { transformStyle: preserveCustomLayers })
  }, [source])

  // Sync track layers — reruns when tracks change or after style loads
  useEffect(() => {
    const map = mapRef.current
    if (!map || mapVersion === 0) return

    const catLookup: Record<string, TrackCategory> = Object.fromEntries(
      categories.map(c => [c.name, c])
    )

    for (const track of loadedTracks) {
      const sid = `track-${track.fileId}`
      const lid = `track-line-${track.fileId}`
      const cat = catLookup[track.category]
      if (!cat) {
        console.warn(`Skipping track ${track.fileId}: unknown category "${track.category}" — rebuild index to fix`)
        continue
      }

      if (!map.getSource(sid)) {
        map.addSource(sid, { type: 'geojson', data: track.geojson })
        map.addLayer({
          id: lid,
          type: 'line',
          source: sid,
          paint: {
            'line-color': cat.color,
            'line-width': cat.width,
            'line-opacity': cat.opacity,
            ...(cat.dashArray ? { 'line-dasharray': cat.dashArray } : {}),
          },
        })
        map.on('click', lid, e => {
          if (e.features?.[0]) onTrackClickRef.current(track.fileId)
        })
        map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = '' })
      }
    }
  }, [loadedTracks, categories, mapVersion])

  // Sync peak layers — reruns when peaks change or after style loads
  useEffect(() => {
    const map = mapRef.current
    if (!map || mapVersion === 0) return

    for (const ps of loadedPeaks) {
      const sid = `peaks-${ps.category}`
      const lid = `peaks-circle-${ps.category}`

      if (!map.getSource(sid)) {
        map.addSource(sid, { type: 'geojson', data: ps.geojson })
        map.addLayer({
          id: lid,
          type: 'circle',
          source: sid,
          paint: {
            'circle-color': ps.color,
            'circle-radius': 5,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        })
        map.on('click', lid, e => {
          const f = e.features?.[0]
          if (f) onPeakClickRef.current(f.properties?.name ?? '', f.properties?.ele ?? 0, ps.category)
        })
        map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = '' })
      }
    }
  }, [loadedPeaks, mapVersion])

  // Fly to bbox
  useEffect(() => {
    const map = mapRef.current
    if (!map || !flyToBbox) return
    const { west, east, south, north } = flyToBbox
    map.fitBounds([west, south, east, north] as LngLatBoundsLike, { padding: 40 })
  }, [flyToBbox])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}
