import { useState, useCallback } from 'react'
import { BUILT_IN_SOURCES, type TileSource } from '../lib/tileConfig'

const STORAGE_KEY = 'doneit-tile-source'

function getInitialSourceId(): string {
  return localStorage.getItem(STORAGE_KEY) ?? BUILT_IN_SOURCES[0].id
}

export function useTileSource(driveSources: TileSource[] = []) {
  const allSources = [...BUILT_IN_SOURCES, ...driveSources]
  const [activeId, setActiveId] = useState<string>(getInitialSourceId)

  const activeSource = allSources.find(s => s.id === activeId) ?? allSources[0]

  const setSource = useCallback((id: string) => {
    setActiveId(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  return { allSources, activeSource, setSource }
}
