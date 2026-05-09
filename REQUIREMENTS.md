# Hiking Map PWA — Requirements & Design Document

*Living document. Updated as the project evolves.*

---

## 1. Overview

A Progressive Web App (PWA) that displays a personal archive of hiking and coastal walk GPS tracks against an OpenStreetMap vector tile backdrop. Tracks are sourced from a Google Drive folder populated by Garmin exports. A separate Drive folder holds GPX waypoint files for notable peaks (Munros, Munro-tops, Grahams, Corbetts, etc.).

The app is a **viewer and archive** — no GPS recording. It runs in Android Chrome and can be installed to the home screen. It works on any phone signed in to the user's Google account.

---

## 2. Functional Requirements

### 2.1 Authentication

- FR-AUTH-1: The app authenticates with Google via OAuth2 (PKCE flow in the browser).
- FR-AUTH-2: Scope required: `https://www.googleapis.com/auth/drive.readonly` — to read pre-existing Garmin GPX exports, and `https://www.googleapis.com/auth/drive.file` — to write and maintain the tracks index file and bagged peaks database.
- FR-AUTH-3: The sign-in state persists for the browser session. On reload, the user re-authenticates (tokens are not persisted to localStorage).
- FR-AUTH-4: The app works on any phone where the user signs in to their Google account.

### 2.2 Map Display

- FR-MAP-1: The map is rendered using MapLibre GL JS with vector tiles as the default source.
- FR-MAP-2: The user can switch between multiple tile sources (see §3: Tile Sources).
- FR-MAP-3: The selected tile source persists across sessions (stored in localStorage).
- FR-MAP-4: The map supports standard pan, pinch-zoom, and rotate gestures.
- FR-MAP-5: The initial map view centres on Scotland (approximately 57°N, 4°W), zoom level 7.

### 2.3 Track Display

- FR-TRACK-1: GPX track files are stored in a Google Drive folder named `tracks/`.
- FR-TRACK-2: Garmin exports tracks as `activity_NNNN.gpx`. Each file may contain an internal `<name>` or `<desc>` element (e.g. "Highlands walking"). The app uses the internal name as the display name; falls back to the filename if absent.
- FR-TRACK-3: Only tracks whose bounding box overlaps the current map viewport are loaded. Loading is triggered by map pan/zoom events (debounced 300ms). Loading is only active at zoom level ≥ 8.
- FR-TRACK-4: Loaded tracks are rendered as coloured LineStrings. Each track is assigned a distinct colour from a fixed palette.
- FR-TRACK-5: Tapping/clicking a track opens a popup showing its display name and the date of the activity (from GPX `<time>` element).
- FR-TRACK-6: The sidebar lists all tracks in the current index, with their display name and a colour swatch. Tapping a track in the sidebar flies the map to its bounding box.
- FR-TRACK-7: Individual tracks can be toggled visible/hidden from the sidebar.

### 2.4 Spatial Index

- FR-IDX-1: A spatial index file (`tracks-index.json`) is maintained in the `tracks/` Drive folder by the app itself.
- FR-IDX-2: On first load (index absent): the app scans all `.gpx` files in `tracks/`, parses each for bounding box and display name, and writes the index to Drive. A progress indicator is shown during this build.
- FR-IDX-3: On subsequent loads (index present): the app reads the index from Drive without scanning individual GPX files.
- FR-IDX-4: The sidebar provides a **Rebuild Index** button. This re-scans all GPX files and overwrites the index. The user triggers this after adding new tracks to Drive.
- FR-IDX-5: The index is held in memory during the session; it is a small JSON file and does not require client-side database storage.

### 2.5 Peaks Display

- FR-PEAKS-1: Peak waypoint files are stored in a Google Drive folder named `peaks/`, separate from tracks.
- FR-PEAKS-2: Separate GPX files are maintained per peak category: `munros.gpx`, `munro-tops.gpx`, `grahams.gpx`, `corbetts.gpx`, etc.
- FR-PEAKS-3: All peak files are loaded in full on sign-in (they are small reference datasets, not viewport-filtered).
- FR-PEAKS-4: Peaks are rendered as point markers, with a distinct icon or colour per category.
- FR-PEAKS-5: Tapping a peak marker opens a popup showing: name, elevation (metres), and category.
- FR-PEAKS-6: Each peak category can be independently toggled visible/hidden from the sidebar.

### 2.6 Tile Caching to Drive

- FR-CACHE-1: For any selected tile source, the user can trigger "Cache tiles for this region".
- FR-CACHE-2: The app fetches raster or vector tiles at zoom levels z8–z14 for the current viewport bounding box and stores them in `cache/[source-name]/` on Drive, alongside a tile index file.
- FR-CACHE-3: When a cached source is selected and the app is offline (or Drive is unavailable), cached tiles are served from the Drive cache folder via HTTP range requests.
- FR-CACHE-4: The sidebar shows cache status per source (cached / not cached / partial).

---

## 3. Tile Sources

### 3.1 Built-in online sources (Phase 1)

| ID | Display Name | Type | URL / Notes |
|---|---|---|---|
| `stadia-osm` | OpenStreetMap (Stadia) | Vector MVT | Default. Free, no API key. |
| `opencyclemap` | OpenCycleMap | Raster PNG | Thunderforest. Free tier requires API key. |
| `opentopomap` | OpenTopoMap | Raster PNG | Free, no key. |
| *(more TBD)* | | | |

### 3.2 Drive-hosted tiles (Phase 2)

- The user uploads a PMTiles file (single-file OSM vector archive) to their Drive.
- The app detects PMTiles files in a `tiles/` Drive folder and offers them as selectable sources.
- Tiles are served via Drive's HTTP range request support + the `pmtiles` MapLibre protocol plugin.
- No server is required.

### 3.3 Source switching

- `src/lib/tileConfig.ts` exports the list of source definitions and a function to build a MapLibre style object for a given source.
- Switching sources re-initialises the MapLibre style but preserves the current viewport and all overlaid track/peak layers.

---

## 4. Data Model

### 4.1 Drive folder structure

```
My Drive/
  tracks/
    tracks-index.json      ← maintained by the app
    activity_1234.gpx
    activity_5678.gpx
    ...
  peaks/
    munros.gpx
    munro-tops.gpx
    grahams.gpx
    corbetts.gpx
    ...
  cache/
    stadia-osm/
      tiles-index.json
      [z]/[x]/[y].mvt      ← cached vector tiles
    opentopomap/
      tiles-index.json
      [z]/[x]/[y].png
  tiles/                   ← (Phase 2) user-uploaded PMTiles files
    scotland.pmtiles
    ...
```

### 4.2 Tracks index schema (`tracks-index.json`)

```json
{
  "version": 1,
  "generated": "2026-05-09T12:00:00Z",
  "tracks": [
    {
      "fileId": "1abc...",
      "filename": "activity_1234.gpx",
      "displayName": "Highlands walking",
      "date": "2024-08-15",
      "bbox": {
        "west": -5.1,
        "east": -4.9,
        "south": 56.8,
        "north": 57.0
      }
    }
  ]
}
```

### 4.3 GPX structure used

From each track GPX:
- `<trk><name>` — display name (optional)
- `<trk><trkseg><trkpt lat lon>` — track points
- `<metadata><time>` or first `<trkpt><time>` — activity date

From each peaks GPX:
- `<wpt lat lon>` — waypoint position
- `<wpt><name>` — peak name
- `<wpt><ele>` — elevation in metres

### 4.4 Bagged peaks database (`peaks/bagged.json`) — future

```json
{
  "version": 1,
  "bagged": [
    {
      "peakName": "Ben Nevis",
      "category": "munro",
      "lat": 56.7969,
      "lon": -5.0035,
      "elevation": 1345,
      "date": "2024-08-15",
      "evidenceTrackFileId": "1abc..."
    }
  ]
}
```

---

## 5. UI / UX Design

### 5.1 Layout

```
┌─────────────────────────────────────────┐
│  [☰ Menu]   Hiking Map         [Sign in]│  ← Top bar
├──────────┬──────────────────────────────┤
│          │                              │
│ Sidebar  │                              │
│          │         Map                  │
│ Tracks   │                              │
│ Peaks    │                              │
│ Sources  │                              │
│ Index    │                              │
│          │                              │
└──────────┴──────────────────────────────┘
```

- On mobile, the sidebar is a slide-over drawer (hidden by default, toggled by the hamburger button).
- The map fills the full viewport.

### 5.2 Sidebar sections

1. **Tracks** — list of all indexed tracks with colour swatch, display name, date. Tap to fly to. Toggle visibility.
2. **Peaks** — per-category toggle (Munros, Munro-tops, Grahams, Corbetts).
3. **Map Source** — dropdown/list of available tile sources.
4. **Index** — index status (last built date, track count), Rebuild button, Cache Region button.

### 5.3 Popups

**Track popup** (tap on a track line):
```
Ben Nevis Circuit
15 August 2024
```

**Peak popup** (tap on a peak marker):
```
Ben Nevis
Munro  ·  1,345 m
[✓ Bagged]   ← future
```

---

## 6. Non-Functional Requirements

- NFR-1: **Performance.** Viewport track loading must complete within 3 seconds for typical track files (<1 MB) on a 4G connection.
- NFR-2: **Offline.** The app shell (HTML, JS, CSS) is cached by the service worker and loads without a network connection. Tile caching (§2.6) provides optional offline map data.
- NFR-3: **Auth model.** OAuth tokens are held in memory only, never written to localStorage or IndexedDB.
- NFR-4: **Drive quota.** The app minimises Drive API calls: the index is read once per session; individual GPX files are fetched only when their bounding box intersects the viewport and they have not been fetched this session.
- NFR-5: **Installability.** The app meets PWA installability criteria (manifest, HTTPS, service worker) so it can be added to the Android home screen via Chrome.

---

## 7. Technical Stack

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Package manager | Yarn Classic (v1) |
| Mapping | MapLibre GL JS |
| Vector tiles (Phase 1) | Stadia Maps (MVT) |
| Vector tiles (Phase 2) | PMTiles via `pmtiles` protocol plugin |
| GPX parsing | `@tmcw/togeojson` |
| Google auth | `@react-oauth/google` |
| Drive access | Google Drive REST API v3 (fetch-based) |
| PWA | `vite-plugin-pwa` |
| Hosting | GitHub Pages |

---

## 8. Google Cloud Setup Requirements

- Google Cloud project with Google Drive API enabled.
- OAuth 2.0 Web client with authorised JavaScript origins:
  - `http://localhost:5173` (development)
  - `https://[username].github.io` (production)
- Scopes:
  - `https://www.googleapis.com/auth/drive.readonly` — read GPX files and peaks files
  - `https://www.googleapis.com/auth/drive.file` — write/update `tracks-index.json` and `peaks/bagged.json`

---

## 9. Future Requirements

### 9.1 Peak-based track naming

When a track is added to the index (during build or rebuild), detect which peaks from the peaks GPX files fall within a configurable distance (default: 100 m) of any point along the track. Generate an enriched display name listing those peaks (e.g. "Ben Nevis, Carn Mor Dearg"). Store this enriched name in the index alongside the raw GPX name.

Design notes:
- Distance check: Haversine formula between each peak waypoint and each track point. Optimise by first checking whether the peak falls within the track's bbox.
- Configurable threshold stored in app settings.
- Enriched name is shown in the sidebar and popup; raw GPX name is preserved in the index for reference.

### 9.2 Munro bagging database

Automatically detect track/peak coincidences (same algorithm as §9.1) and maintain a `peaks/bagged.json` database on Drive. Each entry records: peak name, category, coordinates, elevation, date bagged, and the Drive fileId of the evidencing track.

Design notes:
- Run coincidence detection during index build/rebuild.
- The peaks layer visually distinguishes bagged vs unbagged peaks (e.g. filled vs hollow icon).
- A "bagged" count per category is shown in the sidebar (e.g. "Munros: 47 / 282").
- The bagged database can be manually edited (for peaks bagged before app use).

### 9.3 Custom map layer generation

A future separate project will generate custom raster or vector map layers (e.g. from Ordnance Survey data, contours, custom styling). These will be served as additional MapLibre sources, potentially hosted on Drive alongside the PMTiles files. The tile source infrastructure built in Phase 2 (§3.2) is designed to accommodate this.

---

## 10. Open Questions

- Which additional tile sources beyond Stadia/OpenCycleMap/OpenTopoMap should be included? (OpenStreetMap.org raster, Esri World Topo, etc.)
- Should the tile cache use individual tile files on Drive, or a single PMTiles-format archive for efficiency?
- Are there peak categories beyond Munros, Munro-tops, Grahams, and Corbetts to include from the start? (Donalds, Hewitts, Wainwrights?)
