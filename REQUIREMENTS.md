# Hiking Map PWA — Requirements & Design Document

*Living document. Updated as the project evolves.*

---

## 1. Overview

A Progressive Web App (PWA) that displays a personal archive of hiking and coastal walk GPS tracks against an OpenStreetMap vector tile backdrop. Tracks are sourced from a Google Drive folder populated by Garmin exports. A separate Drive folder holds GPX waypoint files for notable peaks (Munros, Munro-tops, Corbetts, and any future categories).

The app is a **viewer and archive** — no GPS recording. It runs in Android Chrome and can be installed to the home screen. It works on any phone signed in to the user's Google account.

**Core design principle: file-driven configuration.** The app discovers what data is available by reading Drive at startup and configures its UI (layers, toggles, tile sources) accordingly. No category names, file lists, or layer configurations are hardcoded in the app.

---

## 2. Functional Requirements

### 2.1 Authentication

- FR-AUTH-1: The app authenticates with Google via OAuth2 (PKCE flow in the browser).
- FR-AUTH-2: Scopes required:
  - `https://www.googleapis.com/auth/drive.readonly` — read GPX track and peaks files
  - `https://www.googleapis.com/auth/drive.file` — write and maintain `tracks-index.json` and the bagged peaks database
- FR-AUTH-3: The sign-in state persists for the browser session. On reload, the user re-authenticates (tokens are not persisted to localStorage).
- FR-AUTH-4: The app works on any phone where the user signs in to their Google account.

### 2.2 Map Display

- FR-MAP-1: The map is rendered using MapLibre GL JS. The UI is minimal in the style of Google Maps: the map fills the full viewport with no chrome. Controls float over the map.
- FR-MAP-2: Floating map controls (always visible):
  - Zoom in / zoom out buttons
  - Compass rose (rotates to match map bearing; tap resets to north-up)
  - **Centre on current location** button — uses the browser Geolocation API to obtain the device's GPS position and flies the map to that location. A location accuracy circle is shown. The button shows a loading state while the position is being obtained and an error state if permission is denied or the device has no fix.
- FR-MAP-3: A floating hamburger/menu button opens the sidebar drawer.
- FR-MAP-4: The user can switch between multiple tile sources (see §3: Tile Sources). The source selector is in the sidebar.
- FR-MAP-5: The selected tile source persists across sessions (stored in localStorage).
- FR-MAP-6: The map supports standard pan, pinch-zoom, and rotate gestures.
- FR-MAP-7: The initial map view centres on Scotland (approximately 57°N, 4°W), zoom level 7.

### 2.3 Track Display — File-Driven Categories

Tracks are organised into **categories** (e.g. hiking, canoeing, coastal walking). Each category is a subfolder of `tracks/` on Drive. The app discovers categories by listing subfolders at startup — no category names are hardcoded.

- FR-TRACK-1: GPX track files live in category subfolders of a Google Drive folder named `tracks/`. Example structure:
  ```
  tracks/
    hiking/
      display.json
      activity_1234.gpx
    canoeing/
      display.json
      activity_5678.gpx
    coastal-walking/
      display.json
      activity_9012.gpx
  ```
- FR-TRACK-2: Each category folder contains a `display.json` file defining how tracks in that category are rendered. If absent, defaults are used. Schema:
  ```json
  {
    "label": "Coastal Walking",
    "color": "#0077cc",
    "width": 3,
    "opacity": 0.8,
    "dashArray": null
  }
  ```
  Fields:
  - `label` — display name for the category (falls back to folder name with title-case conversion if absent)
  - `color` — line colour (hex)
  - `width` — line width in pixels
  - `opacity` — line opacity (0–1)
  - `dashArray` — optional MapLibre dash array for dashed lines (e.g. `[4, 2]` for canoeing)

- FR-TRACK-3: Garmin exports tracks as `activity_NNNN.gpx`. Each file may contain an internal `<name>` or `<desc>` element. The app uses the internal name as the display name; falls back to the filename if absent.
- FR-TRACK-4: Only tracks whose bounding box overlaps the current map viewport are loaded. Loading is triggered by map pan/zoom events (debounced 300ms). Loading is only active at zoom level ≥ 8.
- FR-TRACK-5: Each track is rendered using the display style defined in its category's `display.json`.
- FR-TRACK-6: Tapping/clicking a track opens a popup showing its display name, category, and the date of the activity.
- FR-TRACK-7: The sidebar groups tracks by category. Each category has a visibility toggle (show/hide all tracks in the category). Individual tracks can also be toggled.
- FR-TRACK-8: **A visibility toggle and the category label are generated automatically for each discovered category subfolder.** Dropping a new subfolder with a `display.json` into `tracks/` on Drive makes it appear in the app on next load (after index rebuild).

### 2.4 Spatial Index

- FR-IDX-1: A spatial index file (`tracks-index.json`) is maintained in the root `tracks/` Drive folder by the app. It covers all track categories.
- FR-IDX-2: On first load (index absent): the app discovers all category subfolders, scans all `.gpx` files within them, parses each for bounding box, display name, and category, then writes the index. A progress indicator is shown.
- FR-IDX-3: On subsequent loads (index present): the index is read directly; individual GPX files are not scanned.
- FR-IDX-4: The sidebar provides a **Rebuild Index** button, triggered after adding new tracks or categories to Drive.
- FR-IDX-5: The index is held in memory during the session.

### 2.5 Peaks Display — File-Driven Configuration

- FR-PEAKS-1: Peak waypoint files are stored in a Google Drive folder named `peaks/`, separate from tracks.
- FR-PEAKS-2: **The app discovers peak categories dynamically by listing all `.gpx` files in `peaks/` at startup.** There are no hardcoded category names. Dropping a new file (e.g. `donalds.gpx`) into the Drive folder automatically creates a new layer and toggle in the app on next load.
- FR-PEAKS-3: The display name for each category is derived from the filename: `munro-tops.gpx` → "Munro Tops", `corbetts.gpx` → "Corbetts". Each category is assigned a distinct colour from a palette.
- FR-PEAKS-4: All peak files are loaded in full on sign-in (they are small reference datasets, not viewport-filtered).
- FR-PEAKS-5: Peaks are rendered as point markers, with a distinct icon colour per category.
- FR-PEAKS-6: Tapping a peak marker opens a popup showing: name, elevation (metres), and category.
- FR-PEAKS-7: **A visibility toggle is generated automatically for each discovered category** and shown in the sidebar. No UI changes are required when new peak category files are added to Drive.

### 2.6 Tile Caching

- FR-CACHE-1: For any selected tile source, the user can trigger "Cache tiles for this region".
- FR-CACHE-2: Tiles at zoom levels z8–z14 for the current viewport bounding box are fetched and stored in **browser IndexedDB** (fast, no Drive API quota impact, survives app reload).
- FR-CACHE-3: When the device is offline, cached tiles are served from IndexedDB transparently.
- FR-CACHE-4: The sidebar shows cache status per source (cached region summary, clear cache option).
- FR-CACHE-5: (Phase 2) Drive-hosted PMTiles files act as a separately managed tile archive distinct from the IndexedDB cache — they are explicitly selected sources, not a fallback cache.

---

## 3. Tile Sources

### 3.1 Built-in online sources

All built-in sources are available without any server-side component. The list below is the initial set; the architecture supports adding further sources without structural changes.

| ID | Display Name | Type | Key needed | Notes |
|---|---|---|---|---|
| `stadia-osm` | OpenStreetMap | Vector MVT | No | Default. OSM data, Stadia Maps CDN. |
| `esri-satellite` | Satellite Imagery | Raster PNG | No | Esri World Imagery. Free with attribution. Excellent global coverage. |
| `opentopomap` | Topo Map | Raster PNG | No | OpenTopoMap. Contour detail. |
| `opencyclemap` | Cycle Map | Raster PNG | Yes (free tier) | Thunderforest. Highlights cycle routes. |

### 3.2 Drive-hosted tiles (Phase 2)

- The user uploads a PMTiles file (a single-file OSM vector tile archive) to a `tiles/` folder on their Drive.
- The app lists all `.pmtiles` files in that folder at startup and adds each as a selectable source.
- **This is file-driven configuration** — no app changes are needed when a new PMTiles file is added.
- Tiles are served via Drive's HTTP range request support and the `pmtiles` MapLibre protocol plugin. No server is required.
- See §3.4 for PMTiles trade-offs.

### 3.3 Source switching

- `src/lib/tileConfig.ts` exports the built-in source definitions and a function to build a MapLibre style for a given source.
- Drive-discovered PMTiles sources are merged with built-in sources at runtime.
- Switching sources re-initialises the MapLibre style but preserves the current viewport and all overlaid track/peak layers.

### 3.4 PMTiles — trade-offs

**Chosen for Phase 2 Drive-hosted tiles because:**
- Single file on Drive — easy to manage; one file upload, one Drive entry
- HTTP range requests (natively supported by Drive) serve individual tiles without downloading the full archive
- MapLibre has a mature `pmtiles` protocol plugin
- Self-contained and versioned: swap the file to update the map data

**Limitations to be aware of:**
- Generating a PMTiles file requires `planetiler` or `tippecanoe` tooling — not trivial; a Scotland z0–z14 file is roughly 2–4 GB
- Updating is all-or-nothing: individual tiles cannot be patched; the full file must be regenerated
- Per-tile Drive API range-request latency is higher than a CDN; acceptable for normal browsing, slower for rapid panning over uncached areas

**Not used for the tile caching feature** (§2.6): the browser IndexedDB cache is faster (no Drive API calls per tile) and simpler for that use case.

### 3.5 Google Maps — future consideration

Adding Google Maps as a tile source in MapLibre is **not viable**:
- Google's Maps Platform Terms of Service explicitly prohibit using their tile URLs (`maps.googleapis.com/maps/vt`) in third-party renderers.
- The Google Maps JavaScript API is a separate renderer with its own overlay model; integrating it would mean duplicating all track/peak layer logic.

If a Google Maps-like experience is wanted in future, the right approaches are: (a) Esri Satellite + OSM vector for the visual feel; or (b) a fully separate Google Maps view as a distinct app mode. This is noted as a future consideration if the need becomes concrete.

---

## 4. Data Model

### 4.1 Drive folder structure

```
My Drive/
  tracks/
    tracks-index.json      ← built and maintained by the app (covers all categories)
    hiking/
      display.json         ← rendering style for this category
      activity_1234.gpx
      activity_5678.gpx
    canoeing/
      display.json
      activity_9012.gpx
    coastal-walking/
      display.json
      activity_3456.gpx
    (any new subfolder with a display.json is auto-discovered)
  peaks/
    munros.gpx             ← discovered dynamically; any .gpx here becomes a layer
    munro-tops.gpx
    corbetts.gpx
    (drop in any new .gpx to add a category)
  tiles/                   ← (Phase 2) user-uploaded PMTiles files; discovered dynamically
    scotland.pmtiles
    ...
```

### 4.2 Track category display config (`display.json`)

```json
{
  "label": "Coastal Walking",
  "color": "#0077cc",
  "width": 3,
  "opacity": 0.8,
  "dashArray": null
}
```

All fields are optional. Defaults: label from folder name, color from palette, width 3, opacity 0.8, dashArray null.

### 4.3 Tracks index schema (`tracks-index.json`)

```json
{
  "version": 1,
  "generated": "2026-05-10T12:00:00Z",
  "tracks": [
    {
      "fileId": "1abc...",
      "filename": "activity_1234.gpx",
      "category": "hiking",
      "displayName": "Highlands Walking",
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

**Track files** (Garmin Connect export, `activity_<id>.gpx`):

```xml
<gpx creator="Garmin Connect" version="1.1" xmlns:ns3="…TrackPointExtension/v1" …>
  <metadata>
    <time>2025-08-30T16:57:03.000Z</time>   ← activity start time (preferred date source)
  </metadata>
  <trk>
    <name>Highlands Walking</name>            ← display name (may be absent → fall back to filename)
    <type>walking</type>                      ← activity type (future: filtering)
    <trkseg>
      <trkpt lat="56.932…" lon="-5.864…">
        <ele>4.4</ele>
        <time>2025-08-30T16:57:03.000Z</time>
        <extensions>
          <ns3:TrackPointExtension>
            <ns3:hr>82</ns3:hr>               ← heart rate (future: display in popup)
          </ns3:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
```

Fields extracted by the app:
- **Display name:** `<trk><name>` — fall back to filename (`activity_<id>.gpx`) if absent
- **Date:** `<metadata><time>` — fall back to first `<trkpt><time>` if metadata absent
- **Track points:** `<trkpt lat lon>` — used to build GeoJSON LineString and compute bbox
- *Available for future use:* `<trk><type>` (activity type), `<ns3:hr>` (heart rate)

**Peaks files** (from haroldstreet.org.uk, one file per category):

```xml
<gpx version="1.1" creator="Phils GPX generator www.haroldstreet.org.uk" …>
  <wpt lat="56.870342" lon="-4.199001">
    <ele>936.00</ele>
    <name><![CDATA[A' Bhuidheanach Bheag]]></name>   ← CDATA required for Gaelic characters
    <cmt><![CDATA[A' Bhuidheanach Bheag]]></cmt>
    <desc><![CDATA[A' Bhuidheanach Bheag]]></desc>
    <sym>filled circle</sym>                          ← same for all peaks; category comes from filename
  </wpt>
</gpx>
```

Fields extracted by the app:
- **Position:** `<wpt lat lon>`
- **Name:** `<wpt><name>` CDATA content — must handle Gaelic special characters
- **Elevation:** `<wpt><ele>` in metres
- **Category:** derived from filename (e.g. `munros.gpx` → "Munros"), not from `<sym>`

### 4.4 Bagged peaks database (`peaks/bagged.json`) — future

```json
{
  "version": 1,
  "bagged": [
    {
      "peakName": "Ben Nevis",
      "category": "munros",
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

### 5.1 Layout — Google Maps style

The UI is map-first. There is no persistent chrome. All controls float over the map.

```
┌─────────────────────────────────────────┐
│[☰]                                 [●] │  ← hamburger (drawer), sign-in avatar
│                                         │
│                  MAP                    │
│                                    [+]  │  ← zoom in
│                                    [-]  │  ← zoom out
│                                    [↑]  │  ← compass (rotates with map)
│                                    [◎]  │  ← centre on current location
│                                         │
└─────────────────────────────────────────┘
```

- The map fills 100% of the viewport (no top bar, no footer).
- The hamburger (☰) opens the sidebar drawer from the left.
- The sign-in avatar/button floats top-right.
- Map controls float bottom-right (standard Google Maps convention).

### 5.2 Sidebar drawer

Slides in from the left. Sections:

1. **Tracks** — list of indexed tracks: colour swatch, display name, date. Tap → fly to. Toggle visibility.
2. **Peaks** — one toggle per discovered category (dynamically generated from `peaks/` folder contents).
3. **Map Source** — list of available tile sources (built-in + Drive-discovered PMTiles). Tap to switch.
4. **Index** — last built date, track count, **Rebuild Index** button, **Cache Region** button.

### 5.3 Popups

**Track popup** (tap on a track line):
```
Ben Nevis Circuit
15 August 2024
```

**Peak popup** (tap on a peak marker):
```
Ben Nevis
Munros  ·  1,345 m
[✓ Bagged]   ← future
```

---

## 6. Non-Functional Requirements

- NFR-1: **Performance.** Viewport track loading completes within 3 seconds for typical GPX files (<1 MB) on a 4G connection.
- NFR-2: **Offline.** The app shell (HTML, JS, CSS) is cached by the service worker and loads offline. The IndexedDB tile cache provides optional offline map data.
- NFR-3: **Auth model.** OAuth tokens are held in memory only — never written to localStorage or IndexedDB.
- NFR-4: **Drive quota.** The index is read once per session. Individual GPX files are fetched only when their bbox intersects the viewport and they have not yet been fetched this session. Peak files (small) are fetched once on sign-in.
- NFR-5: **Installability.** The app meets PWA installability criteria (manifest, HTTPS, service worker) for Android Chrome home-screen installation.
- NFR-6: **File-driven configuration.** No category names, source lists, or layer counts are hardcoded. The app derives all configuration from what it discovers in Drive.

---

## 7. Technical Stack

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Package manager | Yarn Classic (v1) |
| Mapping | MapLibre GL JS |
| Vector tiles (Phase 1) | Stadia Maps (MVT) |
| Satellite imagery | Esri World Imagery (raster, no key) |
| Drive-hosted tiles (Phase 2) | PMTiles via `pmtiles` protocol plugin |
| Tile cache | Browser IndexedDB |
| GPX parsing | `@tmcw/togeojson` |
| Google auth | `@react-oauth/google` |
| Drive access | Google Drive REST API v3 (fetch-based) |
| PWA | `vite-plugin-pwa` |
| Hosting | GitHub Pages (`https://rootminus0x1.github.io/doneit`) |

---

## 8. Google Cloud Setup Requirements

- Google Cloud project with Google Drive API enabled.
- OAuth 2.0 Web client with authorised JavaScript origins:
  - `http://localhost:5173` (development)
  - `https://rootminus0x1.github.io` (production)
- Scopes:
  - `https://www.googleapis.com/auth/drive.readonly` — read GPX and peaks files
  - `https://www.googleapis.com/auth/drive.file` — write `tracks-index.json` and `peaks/bagged.json`

---

## 9. Future Requirements

### 9.1 Peak-based track naming

When a track is added to the index (during build or rebuild), detect which peaks from the peaks GPX files fall within a configurable distance (default: 100 m) of any point along the track. Generate an enriched display name listing those peaks (e.g. "Ben Nevis, Carn Mor Dearg"). Store this enriched name in the index alongside the raw GPX name.

Design notes:
- Distance check: Haversine formula between each peak waypoint and each track point. Optimise by first checking whether the peak falls within the track's bbox.
- Configurable threshold stored in app settings.
- Enriched name shown in the sidebar and popup; raw GPX name preserved in the index.

### 9.2 Munro bagging database

Automatically detect track/peak coincidences (same algorithm as §9.1) and maintain a `peaks/bagged.json` database on Drive. Each entry records: peak name, category, coordinates, elevation, date bagged, and the Drive fileId of the evidencing track.

Design notes:
- Run coincidence detection during index build/rebuild.
- The peaks layer visually distinguishes bagged vs unbagged peaks (filled vs hollow icon).
- A "bagged" count per category shown in the sidebar (e.g. "Munros: 47 / 282").
- The bagged database can be manually edited for peaks bagged before app use.
- Because peak categories are file-driven, bagging tracking automatically extends to any new category added.

### 9.3 Custom map layer generation

A future separate project will generate custom raster or vector map layers (e.g. from Ordnance Survey data, contours, custom styling). These will be served as additional MapLibre sources hosted on Drive as PMTiles files, discovered by the existing file-driven tile source mechanism (§3.2).

### 9.4 Google Maps integration

Integrating Google Maps as a tile source in MapLibre violates Google's ToS. If a Google Maps experience is required in future, options are: (a) a fully separate embedded Google Maps view as an app mode, with track/peak overlays implemented using the Google Maps JS API overlay model; or (b) continued use of Esri Satellite + OSM vector which provides comparable visual quality. To be revisited if a concrete need arises.
