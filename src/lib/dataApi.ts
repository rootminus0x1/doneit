import * as driveApi from './driveApi'
import * as localApi from './localDataApi'

const IS_LOCAL = import.meta.env.VITE_LOCAL_MODE === 'true'

export const api = IS_LOCAL ? localApi : driveApi

// True when the data layer can serve requests.
// Drive mode requires a non-null auth token; local mode is always ready.
export function isReady(token: string | null): boolean {
  return IS_LOCAL || token !== null
}
