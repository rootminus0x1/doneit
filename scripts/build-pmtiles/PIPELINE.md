# Build Pipeline

## Dependency graph

```mermaid
flowchart TD
    TRK["tracks/&lt;cat&gt;/*.gpx\n(Drive)"]
    PKS["peaks/*.gpx\n(Drive)"]
    MANUAL(["manual edit\npeaks-index.json"])

    CACHE["gpx-cache.json\n{md5, meta, coords}"]
    TIDX["tracks-index.json"]
    TPMT["tracks.pmtiles"]
    PIDX["peaks-index.json\n{categories, bagged[]}"]
    PPMT["peaks.pmtiles"]

    TRK -->|"md5 check — new/changed only"| P1["parse GPX\nupdate cache"]
    P1 --> CACHE

    CACHE --> P2["build tracks index"]
    P2 --> TIDX

    CACHE -->|"coords + meta"| P3["tippecanoe"]
    P3 --> TPMT

    CACHE -->|"new tracks only"| P4["detect baggings"]
    PKS --> P4
    P4 -->|"append new entries"| PIDX

    MANUAL --> PIDX

    PKS --> P5["tippecanoe"]
    PIDX --> P5
    P5 --> PPMT
```

## Tasks

| Task | Inputs | Output | Reruns when |
|---|---|---|---|
| `parse_gpx` | `tracks/**/*.gpx` | `gpx-cache.json` | any track file md5 changes |
| `build_tracks_index` | `gpx-cache.json` | `tracks-index.json` | cache changes |
| `build_tracks_pmtiles` | `gpx-cache.json` | `tracks.pmtiles` | cache changes |
| `detect_baggings` | `gpx-cache.json`, `peaks/*.gpx` | `peaks-index.json` | cache or peak files change |
| `build_peaks_pmtiles` | `peaks/*.gpx`, `peaks-index.json` | `peaks.pmtiles` | peak files or index change |

## Notes

- `gpx-cache.json` and `peaks-index.json` are a matched pair — if you delete the cache to force
  a full reparse, also clear the `bagged` array in `peaks-index.json` to avoid duplicate entries.
- Manual edits to `peaks-index.json` trigger `build_peaks_pmtiles` but not `detect_baggings`
  (correct — detection only runs for new tracks).
- `peaks-index.json` is read and written by `detect_baggings`. doit sees it only as a target;
  the existing content is read inside the action rather than declared as a file dependency.
```
