import { useState, useMemo } from 'react'
import type { TrackCategory } from '../hooks/useDriveData'
import type { IndexEntry } from '../lib/spatialIndex'
import type { ParsedPeaks } from '../lib/gpxParser'
import type { TrackBbox } from '../lib/gpxParser'

interface Props {
  open: boolean
  onClose: () => void
  // track data
  categories: TrackCategory[]
  visibleTracks: IndexEntry[]
  onFlyToTrack: (bbox: TrackBbox) => void
  // peaks
  peakSets: ParsedPeaks[]
  // index
  indexGenerated: string | null
  indexTrackCount: number
  building: boolean
  progress: string | null
  onRebuild: () => void
}

export function Sidebar({
  open, onClose,
  categories, visibleTracks, onFlyToTrack,
  peakSets,
  indexGenerated, indexTrackCount, building, progress, onRebuild,
}: Props) {
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(new Set())

  const catLookup = useMemo(
    () => new Map(categories.map(c => [c.name, c])),
    [categories]
  )

  const tracksByCountry = useMemo(() => {
    const map = new Map<string, IndexEntry[]>()
    for (const t of visibleTracks) {
      const key = t.country ?? 'Unknown'
      const bucket = map.get(key)
      if (bucket) bucket.push(t)
      else map.set(key, [t])
    }
    return new Map(
      [...map.entries()].sort(([a], [b]) => {
        if (a === 'Unknown') return 1
        if (b === 'Unknown') return -1
        return a.localeCompare(b)
      })
    )
  }, [visibleTracks])

  function toggleCountry(country: string) {
    setExpandedCountries(prev => {
      const next = new Set(prev)
      if (next.has(country)) next.delete(country)
      else next.add(country)
      return next
    })
  }

  return (
    <>
      {open && <div style={styles.backdrop} />}
      <div style={{ ...styles.drawer, transform: open ? 'translateX(0)' : 'translateX(-100%)' }}>
        <div style={styles.header}>
          <span style={styles.title}>Done It</span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Tracks grouped by country > category */}
          <Section label="Tracks">
            {tracksByCountry.size === 0 && categories.length === 0 && (
              <p style={styles.empty}>No track categories found in Drive</p>
            )}
            {[...tracksByCountry.entries()].map(([country, tracks]) => {
              const expanded = expandedCountries.has(country)
              return (
                <div key={country}>
                  <button style={styles.countryRow} onClick={() => toggleCountry(country)}>
                    <span style={styles.chevron}>{expanded ? '▾' : '▸'}</span>
                    <span style={styles.countryName}>{country}</span>
                    <span style={styles.count}>{tracks.length}</span>
                  </button>
                  {expanded && (
                    <div style={styles.countryContent}>
                      {categories.map(cat => {
                        const catTracks = tracks.filter(t => t.category === cat.name)
                        if (catTracks.length === 0) return null
                        return (
                          <div key={cat.name}>
                            <div style={styles.categoryRow}>
                              <span style={{ ...styles.swatch, background: cat.color }} />
                              <span style={styles.categoryLabel}>{cat.label}</span>
                              <span style={styles.count}>{catTracks.length}</span>
                            </div>
                            {catTracks.map(t => (
                              <div key={t.fileId} style={styles.trackRow}>
                                <button style={styles.trackBtn} onClick={() => onFlyToTrack(t.bbox)}>
                                  <span style={styles.trackName}>{t.displayName}</span>
                                  {t.date && <span style={styles.trackDate}>{t.date}</span>}
                                </button>
                              </div>
                            ))}
                          </div>
                        )
                      })}
                      {/* tracks whose category isn't in the categories list */}
                      {tracks.filter(t => !catLookup.has(t.category)).map(t => (
                        <div key={t.fileId} style={styles.trackRow}>
                          <button style={styles.trackBtn} onClick={() => onFlyToTrack(t.bbox)}>
                            <span style={styles.trackName}>{t.displayName}</span>
                            {t.date && <span style={styles.trackDate}>{t.date}</span>}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </Section>

          {/* Peaks */}
          {peakSets.length > 0 && (
            <Section label="Peaks">
              {peakSets.map(ps => (
                <div key={ps.category} style={styles.categoryRow}>
                  <span style={styles.categoryLabel}>{ps.category}</span>
                  <span style={styles.count}>{ps.geojson.features.length}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Index */}
          <Section label="Index">
            {building ? (
              <p style={styles.progress}>{progress ?? 'Building…'}</p>
            ) : (
              <>
                <p style={styles.meta}>
                  {indexTrackCount} tracks
                  {indexGenerated && ` · built ${indexGenerated.slice(0, 10)}`}
                </p>
                <button style={styles.rebuildBtn} onClick={onRebuild}>
                  Rebuild Index
                </button>
              </>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', top: 0, bottom: 0, left: 300, right: 0,
    background: 'rgba(0,0,0,0.3)', zIndex: 19,
    pointerEvents: 'none',
  },
  drawer: {
    position: 'fixed', top: 0, left: 0, bottom: 0,
    width: 300, background: '#fff',
    boxShadow: '2px 0 12px rgba(0,0,0,0.2)',
    zIndex: 20,
    transition: 'transform 0.25s ease',
    display: 'flex', flexDirection: 'column',
    overflowY: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 16px 12px',
    borderBottom: '1px solid #eee',
    flexShrink: 0,
  },
  title: { fontSize: 18, fontWeight: 600, color: '#1a73e8' },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#666',
  },
  body: { overflowY: 'auto', flex: 1, padding: '8px 0' },
  section: { padding: '12px 16px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8,
  },
  countryRow: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
    padding: '5px 0',
  },
  chevron: { fontSize: 10, color: '#999', width: 12, flexShrink: 0 },
  countryName: { fontSize: 14, fontWeight: 600, flex: 1, color: '#222' },
  countryContent: { paddingLeft: 12 },
  categoryRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, marginTop: 6,
  },
  swatch: { width: 12, height: 12, borderRadius: 2, flexShrink: 0 },
  categoryLabel: { fontSize: 14, fontWeight: 500 },
  trackRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    paddingLeft: 20, marginBottom: 2,
  },
  trackBtn: {
    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
    padding: 0, display: 'flex', flexDirection: 'column',
  },
  trackName: { fontSize: 13, color: '#333' },
  trackDate: { fontSize: 11, color: '#888' },
  count: { fontSize: 11, color: '#999', marginLeft: 'auto' },
  sourceBtn: {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '6px 8px', marginBottom: 2,
    background: 'none', border: '1px solid #e0e0e0',
    borderRadius: 4, cursor: 'pointer', fontSize: 13,
  },
  sourceBtnActive: { background: '#e8f0fe', borderColor: '#1a73e8', color: '#1a73e8', fontWeight: 500 },
  meta: { fontSize: 12, color: '#666', marginBottom: 8 },
  progress: { fontSize: 12, color: '#666', fontStyle: 'italic' },
  rebuildBtn: {
    padding: '6px 12px', background: '#1a73e8', color: '#fff',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  },
  empty: { fontSize: 13, color: '#999', fontStyle: 'italic' },
}
