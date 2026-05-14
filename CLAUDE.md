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

### Local testing mode
Set `VITE_LOCAL_MODE=true` in `.env.local` to use the local `data/` directory instead of Google Drive. No sign-in required. The data directory structure must mirror the Drive layout:
```
data/
  tracks/
    <category>/
      display.json   (optional)
      activity_*.gpx
  peaks/
    <category>.gpx
```
