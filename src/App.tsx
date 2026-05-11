import { useState, useCallback, useRef } from 'react'
import { useGoogleAuth } from './hooks/useGoogleAuth'
import { useDriveData } from './hooks/useDriveData'
import { useTileSource } from './hooks/useTileSource'
import { useViewportTracks } from './hooks/useViewportTracks'
import { MapView } from './components/MapView'
import { MapControls } from './components/MapControls'
import { Sidebar } from './components/Sidebar'
import type { TrackBbox } from './lib/gpxParser'

const PEAK_COLORS = [
  '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f97316',
]

export default function App() {
  const { token, signIn, signOut, error: authError } = useGoogleAuth()
  const {
    ready, building, progress,
    trackIndex, categories, peakSets,
    rebuildIndex,
  } = useDriveData(token)
  const { allSources, activeSource, setSource } = useTileSource()

  const savedCenter = useRef<[number, number]>([-4.0, 57.0])
  const savedZoom = useRef<number>(7)
  const handleMove = useCallback((center: [number, number], zoom: number) => {
    savedCenter.current = center
    savedZoom.current = zoom
  }, [])

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [viewport, setViewport] = useState<TrackBbox | null>(null)
  const [flyToBbox, setFlyToBbox] = useState<TrackBbox | null>(null)
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set())
  const [hiddenTrackIds, setHiddenTrackIds] = useState<Set<string>>(new Set())
  const [hiddenPeakCats, setHiddenPeakCats] = useState<Set<string>>(new Set())
  const [popup, setPopup] = useState<{ title: string; body: string } | null>(null)

  const loadedTracks = useViewportTracks(token, trackIndex, viewport)

  // Assign colours to peak sets
  const loadedPeaks = peakSets.map((ps, i) => ({
    ...ps,
    color: PEAK_COLORS[i % PEAK_COLORS.length],
  }))

  const toggleCategory = useCallback((name: string) => {
    setHiddenCategories(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleTrack = useCallback((fileId: string) => {
    setHiddenTrackIds(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const togglePeakCat = useCallback((cat: string) => {
    setHiddenPeakCats(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const handleTrackClick = useCallback((fileId: string) => {
    const entry = trackIndex?.tracks.find(t => t.fileId === fileId)
    if (!entry) return
    setPopup({ title: entry.displayName, body: entry.date ?? '' })
  }, [trackIndex])

  const handlePeakClick = useCallback((name: string, elevation: number, category: string) => {
    setPopup({
      title: name,
      body: `${category}  ·  ${Math.round(elevation).toLocaleString()} m`,
    })
  }, [])

  const visibleTracks = trackIndex?.tracks.filter(t =>
    loadedTracks.some(lt => lt.fileId === t.fileId)
  ) ?? []

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Map fills viewport */}
      <MapView
        key={activeSource.id}
        source={activeSource}
        initialCenter={savedCenter.current}
        initialZoom={savedZoom.current}
        onMove={handleMove}
        categories={categories}
        loadedTracks={loadedTracks}
        loadedPeaks={loadedPeaks}
        hiddenCategories={hiddenCategories}
        hiddenPeakCategories={hiddenPeakCats}
        hiddenTrackIds={hiddenTrackIds}
        onBoundsChange={setViewport}
        onTrackClick={handleTrackClick}
        onPeakClick={handlePeakClick}
        flyToBbox={flyToBbox}
      />

      {/* Hamburger */}
      <button style={styles.hamburger} onClick={() => setSidebarOpen(true)} title="Menu">
        ☰
      </button>

      {/* Auth button */}
      <div style={styles.authArea}>
        {token ? (
          <button style={styles.authBtn} onClick={signOut}>Sign out</button>
        ) : (
          <button style={styles.authBtn} onClick={() => signIn()}>Sign in</button>
        )}
      </div>

      {/* Loading indicator */}
      {token && !ready && (
        <div style={styles.loadingBanner}>
          {building ? (progress ?? 'Building index…') : 'Loading…'}
        </div>
      )}

      {/* Auth error */}
      {authError && (
        <div style={{ ...styles.loadingBanner, background: '#c62828' }}>
          {authError}
        </div>
      )}

      {/* Location + controls */}
      <MapControls onLocate={setFlyToBbox} />

      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        categories={categories}
        visibleTracks={visibleTracks}
        hiddenCategories={hiddenCategories}
        hiddenTrackIds={hiddenTrackIds}
        onToggleCategory={toggleCategory}
        onToggleTrack={toggleTrack}
        onFlyToTrack={bbox => { setFlyToBbox(bbox); setSidebarOpen(false) }}
        peakSets={peakSets}
        hiddenPeakCategories={hiddenPeakCats}
        onTogglePeakCategory={togglePeakCat}
        allSources={allSources}
        activeSourceId={activeSource.id}
        onSelectSource={(id) => { setSource(id); setSidebarOpen(false) }}
        indexGenerated={trackIndex?.generated ?? null}
        indexTrackCount={trackIndex?.tracks.length ?? 0}
        building={building}
        progress={progress}
        onRebuild={rebuildIndex}
      />

      {/* Popup */}
      {popup && (
        <div style={styles.popupOverlay} onClick={() => setPopup(null)}>
          <div style={styles.popup} onClick={e => e.stopPropagation()}>
            <div style={styles.popupTitle}>{popup.title}</div>
            {popup.body && <div style={styles.popupBody}>{popup.body}</div>}
            <button style={styles.popupClose} onClick={() => setPopup(null)}>✕</button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  hamburger: {
    position: 'absolute', top: 12, left: 12, zIndex: 10,
    width: 40, height: 40, borderRadius: 8,
    background: '#fff', border: 'none',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    cursor: 'pointer', fontSize: 20,
  },
  authArea: {
    position: 'absolute', top: 12, right: 12, zIndex: 10,
  },
  authBtn: {
    padding: '8px 16px', borderRadius: 20,
    background: '#1a73e8', color: '#fff',
    border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500,
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
  },
  loadingBanner: {
    position: 'absolute', bottom: 80, left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.75)', color: '#fff',
    padding: '8px 16px', borderRadius: 20,
    fontSize: 13, zIndex: 10, maxWidth: '80vw',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  popupOverlay: {
    position: 'fixed', inset: 0, zIndex: 30,
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    paddingBottom: 80,
  },
  popup: {
    background: '#fff', borderRadius: 12,
    padding: '16px 20px', minWidth: 200, maxWidth: '90vw',
    boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
    position: 'relative',
  },
  popupTitle: { fontSize: 16, fontWeight: 600, marginBottom: 4, paddingRight: 24 },
  popupBody: { fontSize: 14, color: '#555' },
  popupClose: {
    position: 'absolute', top: 10, right: 12,
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 16, color: '#888',
  },
}
