# Done It — Claude Code Guidelines

## Design Principles

### Single code path for default and non-default cases
Do not write separate initialisation code for a default value and separate change-handling code for switching to a different value. Both should use the same code path. If a component needs to react to a changing value (e.g. tile source, theme, config), write one effect or handler that runs for all values including the initial one.

Example: MapView keeps the same MapLibre instance alive across style switches and calls `map.setStyle()` with a `transformStyle` callback that copies custom track/peak sources and layers into the incoming style spec. A separate `useEffect([source])` handles style updates while `useEffect([])` handles map creation and teardown.

### File-driven configuration
No category names, source lists, or layer counts are hardcoded. The app discovers all configuration by reading the data source (Drive or local files) at startup.

### No silent fallbacks
Do not swallow errors or substitute placeholder data when something fails to load. Silent fallbacks mask real problems — the user sees a working-looking app when it is actually broken. Instead, propagate errors and surface them visibly (error banner, thrown exception). The only acceptable silent behaviour is skipping a single malformed item in a list (e.g. one unreadable GPX file) when others can still be shown.

### GPX/GeoJSON display vs PMTiles display are separate concerns
GPX files (loaded as GeoJSON) are always displayed as-is — no visibility toggling, no filtering, no done overlays, no category controls. They are a raw fallback for data not yet in the PMTiles build. PMTiles layers are the only layers that support toggling (category visibility, done-peak overlay, activity-type filter). Never add PMTiles-style controls or behaviour to GeoJSON layers, and never try to make the two display paths behave the same.

### Questions vs instructions
When a message ends with "?", it is a question to be answered in the reply — not an instruction to act on. Answer it before doing anything else, and do not treat it as a directive to change code or behaviour.

### App code and data are strictly separated

`public/` contains only the PWA app shell: HTML, compiled JS/CSS bundles, icons, and the service worker manifest. No data files of any kind belong in `public/`. The service worker caches the app shell so the app installs and loads on Android without a network round-trip.

All data lives on Google Drive: `tile-sources.json`, PMTiles files, track index, peaks index, GPX source files. The app always reads data through the Drive REST API. This is intentional — it means the data is user-owned, updateable without redeploying the app, and the same mechanism works whether the app is running in a browser tab or as an installed PWA.

Never put data files (JSON configs, PMTiles, GeoJSON, GPX) in `public/`. Never hardcode data that should live on Drive.

### Build and deploy pipeline

The Drive folder is always named `DoneIt` — hardcoded in `src/lib/driveApi.ts`. No env var is needed for this.

The build pipeline (`scripts/build-pmtiles/`) produces data artifacts locally and then deploys them to Drive. The local staging area is a top-level `DoneIt/` folder that mirrors the Drive folder structure exactly:

```
DoneIt/                       ← gitignored; local mirror of the DoneIt Google Drive folder
  tile-sources.json
  row.pmtiles
  tracks/
    tracks.pmtiles
    tracks-index.json
  peaks/
    peaks.pmtiles
    peaks-index.json
```

`yarn data:local` — builds artifacts into `DoneIt/` only (no network write).  
`yarn data` — builds then deploys: copies changed files from `DoneIt/` to Google Drive via GVFS. Deploy is MD5-checked by doit so only changed files are copied.

No `.env` files of any kind are committed. Locally, all env vars (just `VITE_GOOGLE_CLIENT_ID`) go in `.env.local` (gitignored). In GitHub Actions, `VITE_GOOGLE_CLIENT_ID` is passed via `secrets.*`. See `.github/workflows/deploy.yml`.

### Local development mode

`yarn dev:local` runs Vite with `--mode localdata`. In this mode the app reads data from the local `drive/` folder (served as static files by the Vite dev server) instead of the Drive API. No sign-in required. The `drive/` folder must be populated first by running `yarn data:local`.

`yarn dev` runs Vite in the default mode and reads all data from Google Drive (sign-in required).

The switch between modes is controlled entirely by the yarn script via Vite's `--mode` flag — no manual `.env.local` edits. `VITE_LOCAL_MODE` no longer exists. The mode is a build-time Vite concept; no env file is needed to express it.
