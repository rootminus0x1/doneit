import { useEffect, useRef, useState } from 'react'
import maplibregl, { type LngLatBoundsLike, type StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { TileSource } from '../lib/tileConfig'
import { buildRasterStyle } from '../lib/tileConfig'
import type { TrackCategory } from '../hooks/useDriveData'
import type { FeatureCollection, LineString, Point } from 'geojson'
import type { TrackBbox } from '../lib/gpxParser'

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)

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
  hiddenCategories: Set<string>
  hiddenPeakCategories: Set<string>
  hiddenTrackIds: Set<string>
  onBoundsChange: (bounds: TrackBbox) => void
  onMove: (center: [number, number], zoom: number) => void
  onTrackClick: (fileId: string) => void
  onPeakClick: (name: string, elevation: number, category: string) => void
  flyToBbox?: TrackBbox | null
}

function buildStyle(source: TileSource): StyleSpecification | string {
  if (source.type === 'vector') return source.styleUrl!
  return buildRasterStyle(source) as StyleSpecification
}

export function MapView({
  source,
  initialCenter,
  initialZoom,
  categories,
  loadedTracks,
  loadedPeaks,
  hiddenCategories,
  hiddenPeakCategories,
  hiddenTrackIds,
  onBoundsChange,
  onMove,
  onTrackClick,
  onPeakClick,
  flyToBbox,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  // Stable callback refs — changes to these never re-run the init effect
  const onBoundsChangeRef = useRef(onBoundsChange)
  const onMoveRef = useRef(onMove)
  const onTrackClickRef = useRef(onTrackClick)
  const onPeakClickRef = useRef(onPeakClick)
  useEffect(() => { onBoundsChangeRef.current = onBoundsChange })
  useEffect(() => { onMoveRef.current = onMove })
  useEffect(() => { onTrackClickRef.current = onTrackClick })
  useEffect(() => { onPeakClickRef.current = onPeakClick })

  // Triggers layer effects after style finishes loading
  const [mapVersion, setMapVersion] = useState(0)

  // Initialise once per mount. The parent uses key={source.id} to remount
  // when the source changes — same code path as initial load.
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(source),
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    mapRef.current = map

    map.on('moveend', () => {
      const c = map.getCenter()
      onMoveRef.current([c.lng, c.lat], map.getZoom())
      const b = map.getBounds()
      onBoundsChangeRef.current({
        west: b.getWest(), east: b.getEast(),
        south: b.getSouth(), north: b.getNorth(),
      })
    })

    map.on('load', () => {
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
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync track layers — reruns when tracks change or after style loads
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return

    const catLookup: Record<string, TrackCategory> = Object.fromEntries(
      categories.map(c => [c.name, c])
    )

    for (const track of loadedTracks) {
      const sid = `track-${track.fileId}`
      const lid = `track-line-${track.fileId}`
      const cat = catLookup[track.category]
      const hidden = hiddenCategories.has(track.category) || hiddenTrackIds.has(track.fileId)

      if (!map.getSource(sid)) {
        map.addSource(sid, { type: 'geojson', data: track.geojson })
        map.addLayer({
          id: lid,
          type: 'line',
          source: sid,
          paint: {
            'line-color': cat?.color ?? '#e53935',
            'line-width': cat?.width ?? 3,
            'line-opacity': cat?.opacity ?? 0.8,
            ...(cat?.dashArray ? { 'line-dasharray': cat.dashArray } : {}),
          },
        })
        map.on('click', lid, e => {
          if (e.features?.[0]) onTrackClickRef.current(track.fileId)
        })
        map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = '' })
      }

      if (map.getLayer(lid)) {
        map.setLayoutProperty(lid, 'visibility', hidden ? 'none' : 'visible')
      }
    }
  }, [loadedTracks, categories, hiddenCategories, hiddenTrackIds, mapVersion])

  // Sync peak layers — reruns when peaks change or after style loads
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return

    for (const ps of loadedPeaks) {
      const sid = `peaks-${ps.category}`
      const lid = `peaks-circle-${ps.category}`
      const hidden = hiddenPeakCategories.has(ps.category)

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

      if (map.getLayer(lid)) {
        map.setLayoutProperty(lid, 'visibility', hidden ? 'none' : 'visible')
      }
    }
  }, [loadedPeaks, hiddenPeakCategories, mapVersion])

  // Fly to bbox
  useEffect(() => {
    const map = mapRef.current
    if (!map || !flyToBbox) return
    const { west, east, south, north } = flyToBbox
    map.fitBounds([west, south, east, north] as LngLatBoundsLike, { padding: 40 })
  }, [flyToBbox])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}
