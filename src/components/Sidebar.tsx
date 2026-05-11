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
  hiddenCategories: Set<string>
  hiddenTrackIds: Set<string>
  onToggleCategory: (name: string) => void
  onToggleTrack: (fileId: string) => void
  onFlyToTrack: (bbox: TrackBbox) => void
  // peaks
  peakSets: ParsedPeaks[]
  hiddenPeakCategories: Set<string>
  onTogglePeakCategory: (cat: string) => void
  // index
  indexGenerated: string | null
  indexTrackCount: number
  building: boolean
  progress: string | null
  onRebuild: () => void
}

export function Sidebar({
  open, onClose,
  categories, visibleTracks, hiddenCategories, hiddenTrackIds,
  onToggleCategory, onToggleTrack, onFlyToTrack,
  peakSets, hiddenPeakCategories, onTogglePeakCategory,
  indexGenerated, indexTrackCount, building, progress, onRebuild,
}: Props) {
  return (
    <>
      {open && <div style={styles.backdrop} />}
      <div style={{ ...styles.drawer, transform: open ? 'translateX(0)' : 'translateX(-100%)' }}>
        <div style={styles.header}>
          <span style={styles.title}>Done It</span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Tracks by category */}
          <Section label="Tracks">
            {categories.map(cat => (
              <div key={cat.name}>
                <div style={styles.categoryRow}>
                  <span style={{ ...styles.swatch, background: cat.color }} />
                  <button
                    style={styles.toggleBtn}
                    onClick={() => onToggleCategory(cat.name)}
                  >
                    {hiddenCategories.has(cat.name) ? '○' : '●'}
                  </button>
                  <span style={styles.categoryLabel}>{cat.label}</span>
                </div>
                {visibleTracks
                  .filter(t => t.category === cat.name)
                  .map(t => (
                    <div key={t.fileId} style={styles.trackRow}>
                      <button
                        style={styles.toggleBtn}
                        onClick={() => onToggleTrack(t.fileId)}
                        title={hiddenTrackIds.has(t.fileId) ? 'Show' : 'Hide'}
                      >
                        {hiddenTrackIds.has(t.fileId) ? '○' : '●'}
                      </button>
                      <button
                        style={styles.trackBtn}
                        onClick={() => onFlyToTrack(t.bbox)}
                      >
                        <span style={styles.trackName}>{t.displayName}</span>
                        {t.date && <span style={styles.trackDate}>{t.date}</span>}
                      </button>
                    </div>
                  ))}
              </div>
            ))}
            {categories.length === 0 && (
              <p style={styles.empty}>No track categories found in Drive</p>
            )}
          </Section>

          {/* Peaks */}
          {peakSets.length > 0 && (
            <Section label="Peaks">
              {peakSets.map(ps => (
                <div key={ps.category} style={styles.categoryRow}>
                  <button
                    style={styles.toggleBtn}
                    onClick={() => onTogglePeakCategory(ps.category)}
                  >
                    {hiddenPeakCategories.has(ps.category) ? '○' : '●'}
                  </button>
                  <span style={styles.categoryLabel}>{ps.category}</span>
                  <span style={styles.count}>
                    {ps.geojson.features.length}
                  </span>
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
  categoryRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, marginTop: 4,
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
  toggleBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 14, color: '#1a73e8', flexShrink: 0, padding: 0, lineHeight: 1,
  },
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
