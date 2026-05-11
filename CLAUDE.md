# Done It — Claude Code Guidelines

## Design Principles

### Single code path for default and non-default cases
Do not write separate initialisation code for a default value and separate change-handling code for switching to a different value. Both should use the same code path. If a component needs to react to a changing value (e.g. tile source, theme, config), write one effect or handler that runs for all values including the initial one.

Example: MapView recreates the MapLibre map instance whenever `source` changes — this handles both the first load and subsequent switches identically, via the same `useEffect([source])`.

### File-driven configuration
No category names, source lists, or layer counts are hardcoded. The app discovers all configuration by reading the data source (Drive or local files) at startup.

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
