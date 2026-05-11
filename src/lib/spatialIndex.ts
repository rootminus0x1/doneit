import type { TrackBbox } from './gpxParser'

export interface IndexEntry {
  fileId: string
  filename: string
  category: string
  displayName: string
  date: string | null
  bbox: TrackBbox
}

export interface TrackIndex {
  version: number
  generated: string
  tracks: IndexEntry[]
}

export function bboxOverlaps(a: TrackBbox, b: TrackBbox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}

export function queryByBbox(index: TrackIndex, viewport: TrackBbox): IndexEntry[] {
  return index.tracks.filter(entry => bboxOverlaps(entry.bbox, viewport))
}
