import { useState, useEffect, useCallback } from 'react'
import { api, isReady } from '../lib/dataApi'
import { parseTrackGpx, parsePeaksGpx, filenameToCategoryLabel } from '../lib/gpxParser'
import type { TrackIndex, IndexEntry } from '../lib/spatialIndex'
import type { ParsedPeaks } from '../lib/gpxParser'

export interface TrackCategory {
  id: string        // Drive folder id
  name: string      // folder name e.g. "hiking"
  label: string     // display label e.g. "Hiking"
  color: string
  width: number
  opacity: number
  dashArray: number[] | null
  maxViewportSpan: number | null  // degrees east-west; null = show at all scales
}

export interface DriveDataState {
  ready: boolean
  building: boolean
  progress: string | null
  trackIndex: TrackIndex | null
  categories: TrackCategory[]
  peakSets: ParsedPeaks[]
  tracksFolderId: string | null
  rebuildIndex: () => Promise<void>
}

const CATEGORY_COLORS = [
  '#e53935', '#8e24aa', '#1e88e5', '#00897b',
  '#f4511e', '#6d4c41', '#039be5', '#43a047',
]

interface DisplayConfig {
  label?: string
  color: string
  width: number
  opacity: number
  dashArray: number[] | null
  maxViewportSpan: number | null
}

const DEFAULT_DISPLAY: DisplayConfig = {
  color: '',  // filled from palette
  width: 3,
  opacity: 0.8,
  dashArray: null,
  maxViewportSpan: null,
}

export function useDriveData(token: string | null): DriveDataState {
  const [ready, setReady] = useState(false)
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [trackIndex, setTrackIndex] = useState<TrackIndex | null>(null)
  const [categories, setCategories] = useState<TrackCategory[]>([])
  const [peakSets, setPeakSets] = useState<ParsedPeaks[]>([])
  const [tracksFolderId, setTracksFolderId] = useState<string | null>(null)

  const loadPeaks = useCallback(async (tok: string | null, rootId: string) => {
    const rootFolders = await api.listFolders(tok, rootId)
    const peaksFolder = rootFolders.find(f => f.name === 'peaks')
    if (!peaksFolder) return

    const gpxFiles = await api.listFiles(tok, peaksFolder.id, { nameContains: '.gpx' })
    const loaded: ParsedPeaks[] = []
    for (const f of gpxFiles) {
      try {
        const text = await api.readFileText(tok, f.id)
        const category = filenameToCategoryLabel(f.name)
        loaded.push(parsePeaksGpx(text, category))
      } catch {
        // skip unreadable peaks file
      }
    }
    setPeakSets(loaded)
  }, [])

  const buildIndex = useCallback(async (
    tok: string | null,
    tracksFolderId: string,
    cats: TrackCategory[]
  ): Promise<TrackIndex> => {
    setBuilding(true)
    const entries: IndexEntry[] = []

    for (const cat of cats) {
      const gpxFiles = await api.listFiles(tok, cat.id, { nameContains: '.gpx' })
      let i = 0
      for (const f of gpxFiles) {
        i++
        setProgress(`${cat.label}: ${i}/${gpxFiles.length} — ${f.name}`)
        try {
          const text = await api.readFileText(tok, f.id)
          const parsed = parseTrackGpx(text, f.name)
          entries.push({
            fileId: f.id,
            filename: f.name,
            category: cat.name,
            displayName: parsed.displayName,
            date: parsed.date,
            bbox: parsed.bbox,
          })
        } catch {
          // skip unreadable track
        }
      }
    }

    const index: TrackIndex = {
      version: 1,
      generated: new Date().toISOString(),
      tracks: entries,
    }
    await api.upsertJsonFile(tok, 'tracks-index.json', tracksFolderId, index)
    setBuilding(false)
    setProgress(null)
    return index
  }, [])

  const init = useCallback(async (tok: string | null) => {
    setReady(false)
    try {
      const rootId = await api.getRootFolderId(tok)
      await loadPeaks(tok, rootId)

      const tracksFId = await api.findOrCreateFolder(tok, 'tracks', rootId)
      setTracksFolderId(tracksFId)

      // Discover category subfolders
      const subfolders = await api.listFolders(tok, tracksFId)
      const cats: TrackCategory[] = await Promise.all(
        subfolders.map(async (f, i) => {
          let display: DisplayConfig = { ...DEFAULT_DISPLAY, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }
          let labelOverride: string | undefined
          try {
            const displayFile = await api.findFileByName(tok, 'display.json', f.id)
            if (displayFile) {
              const text = await api.readFileText(tok, displayFile.id)
              const overrides: Partial<DisplayConfig> = JSON.parse(text)
              labelOverride = overrides.label
              display = { ...display, ...overrides }
            }
          } catch { /* use defaults */ }

          return {
            id: f.id,
            name: f.name,
            label: labelOverride ?? filenameToCategoryLabel(f.name),
            color: display.color,
            width: display.width,
            opacity: display.opacity,
            dashArray: display.dashArray,
            maxViewportSpan: display.maxViewportSpan,
          }
        })
      )
      setCategories(cats)

      // Load or build index
      const indexFile = await api.findFileByName(tok, 'tracks-index.json', tracksFId)
      let index: TrackIndex
      if (indexFile) {
        const text = await api.readFileText(tok, indexFile.id)
        index = JSON.parse(text)
      } else {
        index = await buildIndex(tok, tracksFId, cats)
      }
      setTrackIndex(index)
    } finally {
      setReady(true)
    }
  }, [loadPeaks, buildIndex])

  const rebuildIndex = useCallback(async () => {
    if (!isReady(token) || !tracksFolderId || categories.length === 0) return
    const index = await buildIndex(token, tracksFolderId, categories)
    setTrackIndex(index)
  }, [token, tracksFolderId, categories, buildIndex])

  useEffect(() => {
    if (!isReady(token)) {
      setReady(false)
      setTrackIndex(null)
      setCategories([])
      setPeakSets([])
      setTracksFolderId(null)
      return
    }
    init(token)
  }, [token, init])

  return { ready, building, progress, trackIndex, categories, peakSets, tracksFolderId, rebuildIndex }
}
