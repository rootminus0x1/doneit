"""Core pipeline functions for the DoneIt build system.

All Drive interaction goes through GVFS (google-drive: FUSE mount).
No doit-specific code here — pure functions called by dodo.py task actions.
"""

import asyncio
import bisect
import configparser
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DRIVE_FOLDER = "DoneIt"

# Per-artifact tippecanoe configuration files.  Changing a config file causes doit to
# rebuild only that artifact; editing pipeline.py comments does not trigger any rebuild.
# Keys that every gpx-cache entry must have. Entries missing any of these are evicted and
# the track re-parsed. Add new keys here whenever parse_gpx_coords is extended to extract
# additional data — doit's config_changed hash on parse_gpx_coords ensures the task re-runs.
_REQUIRED_CACHE_ENTRY_KEYS: frozenset[str] = frozenset(
    {"md5", "mtime", "meta", "tracks", "durationS", "movingTimeS"}
)

# Peak bagging detection radius. Changing this triggers a full re-bag via doit config_changed.
BAG_DISTANCE_M: float = 500.0

# ROW property filtering. Changing these triggers reprocessing of cached authority files.
_ROW_KEEP_PROPS: frozenset[str] = frozenset({"Name", "row_type", "authority_name"})
_ROW_LENGTH_PRECISION: int = 2
DONEIT_LOCAL = Path(__file__).parent.parent.parent / DRIVE_FOLDER
GVFS_BASE = Path(f"/run/user/{os.getuid()}/gvfs")
PEAKS_INDEX_NAME = "peaks-index.json"

BUILD_DIR = Path(__file__).parent / "build"

GPX_CACHE_PATH        = BUILD_DIR / "gpx-cache.json"
OVERLAYS_CACHE_PATH   = BUILD_DIR / "overlays-cache.json"
ROW_GEOJSON_PATH      = BUILD_DIR / "row.geojson"
ROW_PMTILES_PATH      = DONEIT_LOCAL / "generated" / "row.pmtiles"
TRACKS_PMTILES_PATH   = DONEIT_LOCAL / "generated" / "tracks.pmtiles"
TRACKS_INDEX_PATH     = DONEIT_LOCAL / "generated" / "tracks-index.json"
OVERLAYS_PMTILES_PATH = DONEIT_LOCAL / "generated" / "overlays.pmtiles"
OVERLAYS_INDEX_PATH   = DONEIT_LOCAL / "generated" / "overlays-index.json"
PEAKS_PMTILES_PATH    = DONEIT_LOCAL / "generated" / "peaks.pmtiles"
PEAKS_INDEX_PATH      = DONEIT_LOCAL / "generated" / PEAKS_INDEX_NAME
TILE_SOURCES_PATH     = DONEIT_LOCAL / "config"    / "tile-sources.json"
_ROW_BASE_URL = "https://www.rowmaps.com/jsons"
_ROW_DATASETS_URL = "https://www.rowmaps.com/datasets/"
_ROW_ETAG_PATH = BUILD_DIR / "row-etags.json"
_ROW_CACHE_DIR = BUILD_DIR / "row-cache"
_ROW_TYPES = {1: "footpath", 2: "bridleway", 3: "restricted_byway", 4: "byway"}

# ---------------------------------------------------------------------------
# Timing helper
# ---------------------------------------------------------------------------

_phase_stack: list[str] = []

@contextmanager  # type: ignore[misc]
def phase(label: str):
    """Context manager that prints '<label> ...' on enter and '<label> done (took Ns)' on exit."""
    depth = len(_phase_stack)
    indent = "  " * depth
    print(f"{indent}{label} ...")
    t0 = time.perf_counter()
    _phase_stack.append(label)
    try:
        yield
    finally:
        _phase_stack.pop()
        print(f"{indent}{label} done (took {time.perf_counter() - t0:.1f}s)")


def log(msg: str) -> None:
    """Print msg indented to the current phase depth."""
    print("  " * len(_phase_stack) + msg)


# ---------------------------------------------------------------------------
# Startup helpers (called explicitly by dodo.py, never at import time)
# ---------------------------------------------------------------------------

def ensure_build_dirs() -> None:
    """Create local build/output directories. Must be called before any file I/O."""
    BUILD_DIR.mkdir(exist_ok=True)
    DONEIT_LOCAL.mkdir(exist_ok=True)
    (DONEIT_LOCAL / "config").mkdir(exist_ok=True)
    (DONEIT_LOCAL / "generated").mkdir(exist_ok=True)


def is_online(timeout: float = 3.0) -> bool:
    """Return True if the internet is reachable (TCP probe to Google DNS)."""
    import socket
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=timeout)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# GVFS utilities
# ---------------------------------------------------------------------------

def _activate_gdrive_mount() -> bool:
    """Read GOA config and run `gio mount` for the first Google account with Files enabled."""
    goa_conf = Path.home() / ".config" / "goa-1.0" / "accounts.conf"
    if not goa_conf.exists():
        return False
    cp = configparser.ConfigParser()
    cp.read(goa_conf)
    for section in cp.sections():
        if cp.get(section, "Provider", fallback="").lower() != "google":
            continue
        if cp.get(section, "FilesEnabled", fallback="false").lower() != "true":
            continue
        identity = cp.get(section, "Identity", fallback="")
        if not identity:
            continue
        log(f"activating Google Drive mount for {identity} ...")
        subprocess.run(
            ["gio", "mount", f"google-drive://{identity}/"],
            capture_output=True, timeout=15,
        )
        time.sleep(1)
        return True
    return False


def find_gdrive_root() -> Path:
    mounts = [p for p in GVFS_BASE.iterdir() if p.name.startswith("google-drive:")]
    if not mounts:
        if _activate_gdrive_mount():
            mounts = [p for p in GVFS_BASE.iterdir() if p.name.startswith("google-drive:")]
    if not mounts:
        sys.exit(
            "Google Drive not found in GVFS.\n"
            "Add your Google account in Settings → Online Accounts."
        )
    roots = [p for p in mounts[0].iterdir() if p.name != "GVfsSharedWithMe"]
    if not roots:
        sys.exit("Google Drive mount found but root folder is empty.")
    return roots[0]


def list_by_name(parent: Path) -> dict[str, Path]:
    """Return {display_name: gvfs_path} for all children of parent."""
    children = list(parent.iterdir())
    if not children:
        return {}
    result = subprocess.run(
        ["gio", "info", "-a", "standard::display-name", *[str(c) for c in children]],
        capture_output=True, text=True,
    )
    name_map: dict[str, Path] = {}
    current_path: Path | None = None
    for line in result.stdout.splitlines():
        if line.startswith("local path:"):
            current_path = Path(line.split(":", 1)[1].strip())
        elif "standard::display-name:" in line and current_path:
            name_map[line.split("standard::display-name:", 1)[1].strip()] = current_path
    return name_map


def find_folder(parent: Path, name: str) -> Path:
    names = list_by_name(parent)
    if name not in names:
        sys.exit(f"Folder '{name}' not found. Available: {sorted(names)}")
    return names[name]


def find_folder_optional(parent: Path, name: str) -> Path | None:
    return list_by_name(parent).get(name)


def get_drive_id(gvfs_path: Path) -> str:
    return gvfs_path.name


# ---------------------------------------------------------------------------
# GPX cache  {version, generated, entries: {"cat/file.gpx": {md5, meta, tracks}}}
# ---------------------------------------------------------------------------

def compute_file_md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def load_gpx_cache(cache_path: Path) -> dict[str, Any]:
    if not cache_path.exists():
        return {}
    try:
        with phase("Loading GPX cache"):
            data = json.loads(cache_path.read_text())
            if data.get("version") == 2:
                entries: dict[str, Any] = data.get("entries", {})
                log(f"{len(entries)} entries")
                return entries
    except Exception as e:
        print(f"Warning: could not read {cache_path.name}: {e}", file=sys.stderr)
    return {}


def save_gpx_cache(cache_path: Path, entries: dict[str, Any]) -> None:
    data = {
        "version": 2,
        "generated": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }
    cache_path.write_text(json.dumps(data))


# ---------------------------------------------------------------------------
# Peaks index  (version 2 format)
# {version, generated, categories: [{name, count}], bagged: [{track, date, peaks: [{category, names}]}]}
# ---------------------------------------------------------------------------

def load_peaks_index(peaks_index_path: Path) -> dict[str, Any]:
    if not peaks_index_path.exists():
        return {"version": 2, "generated": "", "categories": [], "bagged": []}
    try:
        return json.loads(peaks_index_path.read_text())
    except Exception as e:
        print(f"Warning: could not read {peaks_index_path.name}: {e}", file=sys.stderr)
        return {"version": 2, "generated": "", "categories": [], "bagged": []}


_PEAKS_INDEX_KEYS = {"version", "generated", "categories", "bagged", "peak_hash", "bag_distance"}

def save_peaks_index(peaks_index_path: Path, index: dict[str, Any]) -> None:
    out = {k: v for k, v in index.items() if k in _PEAKS_INDEX_KEYS}
    out["version"] = 2
    out["generated"] = datetime.now(timezone.utc).isoformat()
    # Deduplicate by track filename; entries without "track" (manual baggings) are always kept.
    seen: set[str] = set()
    deduped = []
    for entry in out.get("bagged", []):
        track = entry.get("track")
        if track is None or track not in seen:
            if track is not None:
                seen.add(track)
            deduped.append(entry)
    out["bagged"] = deduped
    peaks_index_path.write_text(json.dumps(out, indent=2))


# ---------------------------------------------------------------------------
# GPX parsing
# ---------------------------------------------------------------------------

def extract_gpx_metadata_batch(gvfs_paths: list[Path]) -> list[dict[str, str | None]]:
    if not gvfs_paths:
        return []
    repo_root = Path(__file__).parent.parent.parent
    tsx_bin = repo_root / "node_modules" / ".bin" / "tsx"
    cli_script = repo_root / "scripts" / "gpx-meta-cli.ts"
    if not tsx_bin.exists():
        sys.exit(f"tsx not found at {tsx_bin}\n  Install it: yarn add -D tsx")
    result = subprocess.run(
        [str(tsx_bin), str(cli_script), *[str(p) for p in gvfs_paths]],
        capture_output=True, text=True, cwd=str(repo_root),
    )
    if result.returncode != 0:
        sys.exit(f"Metadata extraction failed:\n{result.stderr}")
    return json.loads(result.stdout)


def parse_gpx_coords(
    gpx_path: Path, filename: str
) -> tuple[list[list[list[float]]], float | None, float | None]:
    try:
        import gpxpy  # type: ignore[import]
    except ImportError:
        sys.exit("gpxpy missing — run via: uv run python build.py")
    with gpx_path.open(encoding="utf-8", errors="replace") as f:
        try:
            parsed = gpxpy.parse(f)
        except Exception as e:
            print(f"  skip {filename}: {e}", file=sys.stderr)
            return [], None, None
    coords = [
        [[p.longitude, p.latitude, p.elevation or 0.0] for seg in track.segments for p in seg.points]
        for track in parsed.tracks
    ]
    all_pts = [p for track in parsed.tracks for seg in track.segments for p in seg.points]
    duration_s: float | None = None
    if len(all_pts) >= 2 and all_pts[0].time and all_pts[-1].time:
        duration_s = (all_pts[-1].time - all_pts[0].time).total_seconds()
    moving_s: float | None = None
    try:
        md = parsed.get_moving_data()
        if md:
            moving_s = md.moving_time
    except Exception as e:
        print(f"  warning: could not compute moving time for {filename}: {e}", file=sys.stderr)
    return coords, duration_s, moving_s


def parse_gpx_waypoints(gpx_path: Path, filename: str) -> list[dict[str, Any]]:
    try:
        import gpxpy  # type: ignore[import]
    except ImportError:
        sys.exit("gpxpy missing — run via: uv run python build.py")
    with gpx_path.open(encoding="utf-8", errors="replace") as f:
        try:
            parsed = gpxpy.parse(f)
        except Exception as e:
            print(f"  skip {filename}: {e}", file=sys.stderr)
            return []
    return [
        {
            "name": wpt.name or "",
            "ele": float(wpt.elevation or 0),
            "lat": wpt.latitude,
            "lng": wpt.longitude,
        }
        for wpt in parsed.waypoints
        if wpt.latitude is not None and wpt.longitude is not None
    ]


def parse_kml_coords(kml_path: Path, filename: str) -> tuple[list[list[list[float]]], str | None]:
    """Extract LineString tracks and document name from a KML file.

    Returns (tracks, display_name). Uses stdlib xml.etree — no extra deps.
    """
    import xml.etree.ElementTree as ET

    try:
        tree = ET.parse(kml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"  skip {filename}: KML parse error: {e}", file=sys.stderr)
        return [], None

    # KML namespace varies between versions; detect from root tag
    ns_prefix = ""
    if root.tag.startswith("{"):
        ns_prefix = root.tag.split("}")[0] + "}"

    def find_name() -> str | None:
        for tag in (f"{ns_prefix}name",):
            el = root.find(f".//{ns_prefix}Document/{tag}") or root.find(f".//{tag}")
            if el is not None and el.text and el.text.strip():
                return el.text.strip()
        return None

    tracks: list[list[list[float]]] = []
    for coord_el in root.findall(f".//{ns_prefix}LineString/{ns_prefix}coordinates"):
        if not coord_el.text:
            continue
        coords: list[list[float]] = []
        for token in coord_el.text.strip().split():
            parts = token.split(",")
            if len(parts) >= 2:
                try:
                    coords.append([float(parts[0]), float(parts[1]),
                                   float(parts[2]) if len(parts) >= 3 else 0.0])
                except ValueError:
                    pass
        if coords:
            tracks.append(coords)

    if not tracks:
        print(f"  skip {filename}: no LineString features found", file=sys.stderr)

    return tracks, find_name()


def parse_geojson_coords(geojson_path: Path, filename: str) -> tuple[list[list[list[float]]], str | None]:
    """Extract LineString tracks and name from a GeoJSON file.

    Returns (tracks, display_name). Accepts FeatureCollection, Feature, LineString,
    and MultiLineString at the top level.
    """
    try:
        data: Any = json.loads(geojson_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        print(f"  skip {filename}: GeoJSON parse error: {e}", file=sys.stderr)
        return [], None

    display_name: str | None = None
    tracks: list[list[list[float]]] = []

    def _line_coords(coords_raw: list[Any]) -> list[list[float]]:
        return [[c[0], c[1], c[2] if len(c) > 2 else 0.0] for c in coords_raw if len(c) >= 2]

    def _extract(geom: dict[str, Any], props: dict[str, Any]) -> None:
        nonlocal display_name
        if not display_name:
            for key in ("name", "Name", "title"):
                v = props.get(key)
                if v and isinstance(v, str):
                    display_name = v
                    break
        t = geom.get("type")
        if t == "LineString":
            pts = _line_coords(geom.get("coordinates") or [])
            if pts:
                tracks.append(pts)
        elif t == "MultiLineString":
            for line in geom.get("coordinates") or []:
                pts = _line_coords(line)
                if pts:
                    tracks.append(pts)

    top = data.get("type")
    if top == "FeatureCollection":
        for feat in data.get("features") or []:
            _extract(feat.get("geometry") or {}, feat.get("properties") or {})
    elif top == "Feature":
        _extract(data.get("geometry") or {}, data.get("properties") or {})
    elif top in ("LineString", "MultiLineString"):
        _extract(data, {})

    if not tracks:
        print(f"  skip {filename}: no LineString/MultiLineString features found", file=sys.stderr)

    return tracks, display_name


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlam = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

def deploy_to_drive(pairs: list[tuple[Path, Path]]) -> None:
    """Copy local DoneIt/ files to GVFS, skipping any whose MD5 already matches."""
    import hashlib

    def md5(p: Path) -> str:
        return hashlib.md5(p.read_bytes()).hexdigest()

    with phase("Deploying to Drive"):
        for src, dst in pairs:
            if not src.exists():
                continue
            if dst.exists():
                try:
                    if md5(src) == md5(dst):
                        log(f"unchanged: {src.name}")
                        continue
                except OSError:
                    pass  # GVFS I/O error reading dst — deploy anyway
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(src), str(dst))
            log(f"deployed:  {src.name}")


def _lookup_country(gdf: Any, sindex: Any, lng: float, lat: float) -> str | None:
    from shapely.geometry import Point  # type: ignore[import]
    pt = Point(lng, lat)
    for idx in sindex.query(pt):
        row: Any = gdf.iloc[idx]
        if row.geometry.contains(pt):
            geonunit: Any = row.get("geonunit")
            admin: Any = row.get("admin")
            return str(geonunit) if (geonunit and geonunit != admin) else (str(admin) if admin else None)
    return None


def _lookup_country_nearest(gdf: Any, sindex: Any, lng: float, lat: float, max_dist: float = 0.05) -> str | None:
    from shapely.geometry import Point  # type: ignore[import]
    pt = Point(lng, lat)
    candidates = list(sindex.query(pt.buffer(max_dist)))
    if not candidates:
        return None
    best_dist, best_row = float("inf"), None
    for idx in candidates:
        row: Any = gdf.iloc[idx]
        d: float = row.geometry.distance(pt)
        if d < best_dist:
            best_dist, best_row = d, row
    if best_row is not None and best_dist <= max_dist:
        geonunit: Any = best_row.get("geonunit")
        admin: Any = best_row.get("admin")
        return str(geonunit) if (geonunit and geonunit != admin) else (str(admin) if admin else None)
    return None


def find_country(gdf: Any, sindex: Any, all_coords: list[list[float]]) -> str | None:
    n = len(all_coords)
    sample_count = min(20, n)
    step = (n - 1) / (sample_count - 1) if sample_count > 1 else 0
    indices = list(dict.fromkeys(int(round(i * step)) for i in range(sample_count)))
    for idx in indices:
        c = _lookup_country(gdf, sindex, all_coords[idx][0], all_coords[idx][1])
        if c:
            return c
    mid = all_coords[n // 2]
    return _lookup_country_nearest(gdf, sindex, mid[0], mid[1])


# ---------------------------------------------------------------------------
# Track feature building
# ---------------------------------------------------------------------------

def _smooth_elevation_by_distance(coords: list[list[float]], window_m: float) -> list[float]:
    """Average elevation over a centred horizontal-distance window.

    Using a distance window (not a point-count window) makes the smoothing
    independent of the GPS recording rate, which varies between devices and
    activities. This is analogous to what Garmin/Strava do before computing
    ascent when they cannot use DEM correction.
    """
    n = len(coords)
    eles = [c[2] for c in coords]
    cum: list[float] = [0.0]
    for i in range(1, n):
        cum.append(cum[-1] + haversine_m(coords[i - 1][1], coords[i - 1][0],
                                          coords[i][1], coords[i][0]))
    hw = window_m / 2
    smoothed: list[float] = []
    for i in range(n):
        lo = bisect.bisect_left(cum, cum[i] - hw)
        hi = bisect.bisect_right(cum, cum[i] + hw)
        smoothed.append(sum(eles[lo:hi]) / (hi - lo))
    return smoothed


def build_track_features(
    entry: dict[str, Any],
    category: str,
    file_id: str | None,
    filename: str,
    unnamed_out: list[str],
) -> list[dict[str, Any]]:
    meta: dict[str, Any] = entry["meta"]
    dt = meta.get("datetime")
    date = dt[:10] if dt else None
    display_name = meta.get("displayName")
    if not display_name:
        display_name = f"{date} · {category}" if date else Path(filename).stem
        unnamed_out.append(f"  {category}/{filename}  →  \"{display_name}\"")
    features = []
    for coords in entry["tracks"]:
        if not coords:
            continue
        props: dict[str, Any] = {
            "category": category, "filename": filename, "file_id": file_id,
            "display_name": display_name, "date": date, "datetime": dt,
            "track_type": meta.get("trackType"), "link_text": meta.get("linkText"),
            "duration_s": entry.get("durationS"), "moving_time_s": entry.get("movingTimeS"),
            "length_km": round(
                sum(haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                    for i in range(1, len(coords))) / 1000, 2
            ) if len(coords) > 1 else 0.0,
        }
        ascent = 0.0
        if len(coords) > 1:
            smoothed = _smooth_elevation_by_distance(coords, 200.0)
            ref = smoothed[0]
            for e in smoothed[1:]:
                if e < ref:
                    ref = e
                elif e - ref >= 8.0:
                    ascent += e - ref
                    ref = e
        props["ascent_m"] = round(ascent)
        coords_2d = [[c[0], c[1]] for c in coords]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords_2d},
            "properties": props,
        })
    return features


def bbox_from_features(features: list[dict[str, Any]]) -> dict[str, float] | None:
    lngs = [c[0] for f in features for c in f["geometry"]["coordinates"]]
    lats = [c[1] for f in features for c in f["geometry"]["coordinates"]]
    if not lngs:
        return None
    return {"west": min(lngs), "east": max(lngs), "south": min(lats), "north": max(lats)}


# ---------------------------------------------------------------------------
# Bagging detection
# New track = in GPX cache but not in bagging log.
# Every new track is checked against ALL peaks — no peak-level filter.
# ---------------------------------------------------------------------------

def detect_baggings_for_new_tracks(
    new_tracks: list[tuple[str, str | None, list[list[float]]]],
    all_peaks: dict[str, list[dict[str, Any]]],
    threshold_m: float,
) -> list[dict[str, Any]]:
    """
    Check each new track against ALL peaks with no peak-level filtering.
    Returns list of {track, date, peaks: [{category, names}]} for tracks that matched anything.
    """
    lat_buf = threshold_m / 111_000
    lng_buf = threshold_m / (111_000 * math.cos(math.radians(57.0)))

    results = []
    for filename, date, coords in new_tracks:
        if not coords:
            continue
        lngs = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        blat_min, blat_max = min(lats), max(lats)
        blng_min, blng_max = min(lngs), max(lngs)

        matched_by_category: dict[str, list[str]] = {}
        for category, waypoints in all_peaks.items():
            for wpt in waypoints:
                wlat, wlng = float(wpt["lat"]), float(wpt["lng"])
                if wlat < blat_min - lat_buf or wlat > blat_max + lat_buf:
                    continue
                if wlng < blng_min - lng_buf or wlng > blng_max + lng_buf:
                    continue
                if any(haversine_m(wlat, wlng, c[1], c[0]) <= threshold_m for c in coords):
                    matched_by_category.setdefault(category, []).append(wpt["name"])

        if matched_by_category:
            total = sum(len(v) for v in matched_by_category.values())
            log(f"{filename}: {total} peak(s) matched")
            results.append({
                "track": filename,
                "date": date,
                "peaks": [
                    {"category": cat, "names": sorted(names)}
                    for cat, names in sorted(matched_by_category.items())
                ],
            })

    return results


# ---------------------------------------------------------------------------
# Build action: parse GPX tracks + detect baggings for newly parsed tracks
# New track = absent from cache or MD5 changed.
# Every new track is checked against ALL peaks — no peak-level filter.
# ---------------------------------------------------------------------------

def run_parse_and_bag_tracks(
    all_gpx: list[tuple[str, str, Path]],
    cache_path: Path,
    peaks_gpx_files: dict[str, Path] | None,
    peaks_index_path: Path | None,
    bag_distance_m: float,
) -> dict[str, Any]:
    """Parse new/changed GPX files, detect baggings, return updated cache.

    Caller is responsible for saving the returned cache dict.
    If peaks_gpx_files and peaks_index_path are provided, peaks-index.json
    is updated in place with newly detected baggings.

    Full re-bag is triggered automatically when peaks content or bag_distance changes.
    """
    cache = load_gpx_cache(cache_path)

    # Evict cache entries that are missing fields required by the current version of
    # parse_gpx_coords. Stale entries are re-parsed automatically; no --force needed.
    stale = [k for k, v in cache.items() if not _REQUIRED_CACHE_ENTRY_KEYS.issubset(v)]
    if stale:
        missing = sorted({f for k in stale for f in _REQUIRED_CACHE_ENTRY_KEYS if f not in cache[k]})
        log(f"evicting {len(stale)} stale cache entry/entries (missing field(s): {missing})")
        for k in stale:
            del cache[k]

    # --- Phase 1: check which tracks need re-parsing ---
    # Fast path: use cached mtime; only read the file for MD5 if mtime changed.
    to_parse: list[tuple[str, str, Path, str]] = []
    md5_reads = 0
    with phase(f"Checking {len(all_gpx)} track(s) for changes"):
        for category, filename, gvfs_path in all_gpx:
            key = f"{category}/{filename}"
            entry = cache.get(key)
            if entry and "mtime" in entry:
                try:
                    if gvfs_path.stat().st_mtime == entry["mtime"]:
                        continue
                except OSError:
                    pass
            md5_reads += 1
            current_md5 = compute_file_md5(gvfs_path)
            if entry is None or entry.get("md5") != current_md5:
                to_parse.append((category, filename, gvfs_path, current_md5))
            elif entry:
                try:
                    entry["mtime"] = gvfs_path.stat().st_mtime
                except OSError:
                    pass
            if md5_reads % 10 == 0:
                log(f"{md5_reads} MD5s read, {len(to_parse)} changed so far ...")
    skipped = len(all_gpx) - md5_reads
    log(f"{len(to_parse)} of {len(all_gpx)} changed — {skipped} skipped by mtime, {md5_reads} MD5 reads")

    # --- Phase 2: load peaks (before early-return so a peaks-only change triggers re-bag) ---
    all_peaks: dict[str, list[dict[str, Any]]] = {}
    peaks_index: dict[str, Any] | None = None
    full_rebag = False
    if peaks_gpx_files and peaks_index_path:
        with phase("Loading peaks"):
            for peak_filename, gvfs_path in sorted(peaks_gpx_files.items()):
                category = peak_filename[:-4].lower()
                all_peaks[category] = parse_gpx_waypoints(gvfs_path, peak_filename)

        for category, waypoints in sorted(all_peaks.items()):
            seen: dict[str, int] = {}
            for wpt in waypoints:
                seen[wpt["name"]] = seen.get(wpt["name"], 0) + 1
            dupes = sorted(name for name, count in seen.items() if count > 1)
            if dupes:
                print(f"  ⚠ duplicate names in {category}: {', '.join(dupes)}", file=sys.stderr)

        peak_hash = hashlib.md5(
            json.dumps(
                {cat: sorted(w["name"] for w in wpts) for cat, wpts in sorted(all_peaks.items())}
            ).encode()
        ).hexdigest()
        peaks_index = load_peaks_index(peaks_index_path)
        peaks_index["categories"] = [
            {"name": cat, "count": len(wpts)} for cat, wpts in sorted(all_peaks.items())
        ]
        full_rebag = False
        if peaks_index.get("peak_hash") != peak_hash:
            log("peaks content changed — triggering full re-bag")
            full_rebag = True
        elif peaks_index.get("bag_distance") != bag_distance_m:
            log("bag distance changed — triggering full re-bag")
            full_rebag = True
        peaks_index["peak_hash"] = peak_hash
        peaks_index["bag_distance"] = bag_distance_m

    if not to_parse and not full_rebag:
        log("nothing to do")
        return cache

    # --- Phase 3: parse new/changed tracks ---
    if to_parse:
        with phase(f"Extracting metadata for {len(to_parse)} track(s)"):
            new_metas = extract_gpx_metadata_batch([p for _, _, p, _ in to_parse])
        with phase(f"Parsing coords for {len(to_parse)} track(s)"):
            for (cat, fn, path, md5), meta in zip(to_parse, new_metas):
                key = f"{cat}/{fn}"
                tracks_coords, duration_s, moving_s = parse_gpx_coords(path, fn)
                mtime: float | None = None
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    pass
                cache[key] = {
                    "md5": md5, "mtime": mtime, "meta": meta, "tracks": tracks_coords,
                    "durationS": duration_s, "movingTimeS": moving_s,
                }
                log(f"cached {key}")

    # --- Phase 4: bagging ---
    if peaks_gpx_files and peaks_index_path and peaks_index is not None:
        if full_rebag:
            log(f"Re-running bagging detection for all {len(cache)} cached tracks ...")
            peaks_index["bagged"] = []
            new_tracks: list[tuple[str, str | None, list[list[float]]]] = []
            for key, entry in sorted(cache.items()):
                fn = key.split("/", 1)[1]
                meta = entry.get("meta", {})
                dt = meta.get("datetime")
                date = dt[:10] if dt else None
                coords = [c for seg in entry["tracks"] for c in seg]
                if coords:
                    new_tracks.append((fn, date, coords))
        else:
            reprocessed_filenames = {fn for _, fn, _, _ in to_parse}
            peaks_index["bagged"] = [
                e for e in peaks_index.get("bagged", [])
                if e.get("track") not in reprocessed_filenames
            ]
            new_tracks = []
            for cat, fn, _, _ in to_parse:
                entry = cache[f"{cat}/{fn}"]
                meta = entry.get("meta", {})
                dt = meta.get("datetime")
                date = dt[:10] if dt else None
                coords = [c for seg in entry["tracks"] for c in seg]
                if coords:
                    new_tracks.append((fn, date, coords))

        if new_tracks:
            t3 = time.perf_counter()
            log(f"Checking {len(new_tracks)} track(s) against all peaks ...")
            new_bagged = detect_baggings_for_new_tracks(new_tracks, all_peaks, bag_distance_m)
            if new_bagged:
                total = sum(sum(len(p["names"]) for p in e["peaks"]) for e in new_bagged)
                log(f"{total} peak(s) bagged across {len(new_bagged)} track(s)")
                peaks_index.setdefault("bagged", []).extend(new_bagged)
            log(f"bagging detection in {time.perf_counter() - t3:.1f}s")

        save_peaks_index(peaks_index_path, peaks_index)

    return cache


# ---------------------------------------------------------------------------
# Build action: build tracks PMTiles + index
# ---------------------------------------------------------------------------

def run_build_tracks(
    cache: dict[str, Any],
    all_gpx: list[tuple[str, str, Path]],
    filename_to_file_id: dict[str, str],
    pmtiles_dest: Path,
    index_dest: Path,
    gdf: Any = None,
    sindex: Any = None,
) -> None:
    """Build tracks.pmtiles and tracks-index.json from the GPX cache."""
    index_entries: list[dict[str, Any]] = []
    unnamed_tracks: list[str] = []
    unknown_country_tracks: list[str] = []

    with tempfile.TemporaryDirectory(prefix="doneit-tracks-") as tmpdir:
        tmp = Path(tmpdir)
        geojsonseq = tmp / "tracks.geojsonseq"
        total = 0

        with geojsonseq.open("w") as out:
            for category, filename, gvfs_path in all_gpx:
                file_id = filename_to_file_id.get(filename, get_drive_id(gvfs_path))
                entry = cache.get(f"{category}/{filename}")
                if not entry:
                    continue
                features = build_track_features(entry, category, file_id, filename, unnamed_tracks)
                for feature in features:
                    out.write(json.dumps(feature) + "\n")
                    total += 1
                if features:
                    bbox = bbox_from_features(features)
                    country: str | None = None
                    if gdf is not None:
                        all_coords = [c for f in features for c in f["geometry"]["coordinates"]]
                        if all_coords:
                            country = find_country(gdf, sindex, all_coords)
                        if country is None:
                            unknown_country_tracks.append(f"  {category}/{filename}")
                    props: dict[str, Any] = features[0]["properties"]
                    index_entries.append({
                        "fileId": file_id, "filename": filename, "category": category,
                        "displayName": props["display_name"], "date": props["date"],
                        "trackType": props["track_type"], "country": country, "bbox": bbox,
                    })

        if total == 0:
            sys.exit("No tracks found in cache.")

        if unnamed_tracks:
            print(f"⚠  {len(unnamed_tracks)} track(s) have no name:", file=sys.stderr)
            for line in unnamed_tracks:
                print(line, file=sys.stderr)
        if unknown_country_tracks:
            print(f"⚠  {len(unknown_country_tracks)} track(s) have unknown country:", file=sys.stderr)
            for line in unknown_country_tracks:
                print(line, file=sys.stderr)

        pmtiles_tmp = tmp / "tracks.pmtiles"
        with phase(f"Running tippecanoe for {total} track(s)"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(pmtiles_tmp),
                    "-l", "tracks", "-Z0", "-z14",
                    "--no-feature-limit", "--no-tile-size-limit",
                    "--simplification=4", "--coalesce-densest-as-needed", "--force",
                    str(geojsonseq),
                ],
                check=True,
            )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        log(f"Tracks PMTiles: {size_mb:.1f} MB")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))

    index_data: dict[str, Any] = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(),
        "tracks": index_entries,
    }
    index_dest.write_text(json.dumps(index_data, indent=2, default=str))
    log(f"tracks-index.json: {len(index_entries)} tracks")


# ---------------------------------------------------------------------------
# Build actions: parse and build pipeline overlays
# Overlays live in DoneIt/overlays/{category}/*.{gpx,kml,geojson,json}.
# Separate cache (overlays-cache.json) so overlay changes don't trigger a track rebuild.
# ---------------------------------------------------------------------------

def build_overlay_features(
    entry: dict[str, Any],
    category: str,
    file_id: str | None,
    filename: str,
    unnamed_out: list[str],
) -> list[dict[str, Any]]:
    meta: dict[str, Any] = entry["meta"]
    dt = meta.get("datetime")
    date = dt[:10] if dt else None
    display_name = meta.get("displayName")
    if not display_name:
        display_name = f"{date} · {category}" if date else Path(filename).stem
        unnamed_out.append(f"  {category}/{filename}  →  \"{display_name}\"")
    features = []
    for coords in entry["tracks"]:
        if not coords:
            continue
        props: dict[str, Any] = {
            "category": category, "filename": filename, "file_id": file_id,
            "display_name": display_name, "date": date,
            "length_km": round(
                sum(haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                    for i in range(1, len(coords))) / 1000, 2
            ) if len(coords) > 1 else 0.0,
        }
        ascent = 0.0
        if len(coords) > 1:
            smoothed = _smooth_elevation_by_distance(coords, 200.0)
            ref = smoothed[0]
            for e in smoothed[1:]:
                if e < ref:
                    ref = e
                elif e - ref >= 8.0:
                    ascent += e - ref
                    ref = e
        props["ascent_m"] = round(ascent)
        coords_2d = [[c[0], c[1]] for c in coords]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords_2d},
            "properties": props,
        })
    return features


def run_parse_overlays(
    all_overlays: list[tuple[str, str, Path]],
    cache_path: Path,
) -> dict[str, Any]:
    """Parse new/changed overlay files (GPX, KML, GeoJSON), return updated cache."""
    cache = load_gpx_cache(cache_path)

    stale = [k for k, v in cache.items() if not _REQUIRED_CACHE_ENTRY_KEYS.issubset(v)]
    if stale:
        missing = sorted({f for k in stale for f in _REQUIRED_CACHE_ENTRY_KEYS if f not in cache[k]})
        log(f"evicting {len(stale)} stale overlay cache entry/entries (missing field(s): {missing})")
        for k in stale:
            del cache[k]

    to_parse: list[tuple[str, str, Path, str]] = []
    md5_reads = 0
    with phase(f"Checking {len(all_overlays)} overlay(s) for changes"):
        for category, filename, gvfs_path in all_overlays:
            key = f"{category}/{filename}"
            entry = cache.get(key)
            if entry and "mtime" in entry:
                try:
                    if gvfs_path.stat().st_mtime == entry["mtime"]:
                        continue
                except OSError:
                    pass
            md5_reads += 1
            current_md5 = compute_file_md5(gvfs_path)
            if entry is None or entry.get("md5") != current_md5:
                to_parse.append((category, filename, gvfs_path, current_md5))
            elif entry:
                try:
                    entry["mtime"] = gvfs_path.stat().st_mtime
                except OSError:
                    pass
            if md5_reads % 10 == 0:
                log(f"{md5_reads} MD5s read, {len(to_parse)} changed so far ...")
    skipped = len(all_overlays) - md5_reads
    log(f"{len(to_parse)} of {len(all_overlays)} changed — {skipped} skipped by mtime, {md5_reads} MD5 reads")

    if not to_parse:
        log("nothing to do")
        return cache

    gpx_to_parse = [(cat, fn, p, md5) for cat, fn, p, md5 in to_parse if fn.lower().endswith(".gpx")]
    other_to_parse = [(cat, fn, p, md5) for cat, fn, p, md5 in to_parse if not fn.lower().endswith(".gpx")]

    if gpx_to_parse:
        with phase(f"Extracting metadata for {len(gpx_to_parse)} GPX overlay(s)"):
            new_metas = extract_gpx_metadata_batch([p for _, _, p, _ in gpx_to_parse])
        with phase(f"Parsing coords for {len(gpx_to_parse)} GPX overlay(s)"):
            for (cat, fn, path, md5), meta in zip(gpx_to_parse, new_metas):
                key = f"{cat}/{fn}"
                tracks_coords, duration_s, moving_s = parse_gpx_coords(path, fn)
                mtime: float | None = None
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    pass
                cache[key] = {
                    "md5": md5, "mtime": mtime, "meta": meta, "tracks": tracks_coords,
                    "durationS": duration_s, "movingTimeS": moving_s,
                }
                log(f"cached {key}")

    if other_to_parse:
        with phase(f"Parsing {len(other_to_parse)} KML/GeoJSON overlay(s)"):
            for cat, fn, path, md5 in other_to_parse:
                fn_lower = fn.lower()
                if fn_lower.endswith(".kml"):
                    tracks_coords, display_name = parse_kml_coords(path, fn)
                elif fn_lower.endswith(".geojson") or fn_lower.endswith(".json"):
                    tracks_coords, display_name = parse_geojson_coords(path, fn)
                else:
                    log(f"  skip {fn}: unsupported format (expected .gpx, .kml, .geojson, .json)")
                    continue
                meta_native: dict[str, Any] = {
                    "displayName": display_name, "datetime": None,
                    "trackType": None, "linkText": None,
                }
                mtime_n: float | None = None
                try:
                    mtime_n = path.stat().st_mtime
                except OSError:
                    pass
                cache[f"{cat}/{fn}"] = {
                    "md5": md5, "mtime": mtime_n, "meta": meta_native, "tracks": tracks_coords,
                    "durationS": None, "movingTimeS": None,
                }
                log(f"cached {cat}/{fn}")

    return cache


def run_build_overlays(
    cache: dict[str, Any],
    all_overlays: list[tuple[str, str, Path]],
    filename_to_file_id: dict[str, str],
    pmtiles_dest: Path,
    index_dest: Path,
) -> None:
    """Build overlays.pmtiles and overlays-index.json from the overlays cache."""
    index_entries: list[dict[str, Any]] = []
    unnamed_overlays: list[str] = []

    with tempfile.TemporaryDirectory(prefix="doneit-overlays-") as tmpdir:
        tmp = Path(tmpdir)
        geojsonseq = tmp / "overlays.geojsonseq"
        total = 0

        with geojsonseq.open("w") as out:
            for category, filename, gvfs_path in all_overlays:
                file_id = filename_to_file_id.get(filename, get_drive_id(gvfs_path))
                entry = cache.get(f"{category}/{filename}")
                if not entry:
                    continue
                features = build_overlay_features(entry, category, file_id, filename, unnamed_overlays)
                for feature in features:
                    out.write(json.dumps(feature) + "\n")
                    total += 1
                if features:
                    bbox = bbox_from_features(features)
                    props: dict[str, Any] = features[0]["properties"]
                    index_entries.append({
                        "fileId": file_id, "filename": filename, "category": category,
                        "displayName": props["display_name"], "date": props["date"],
                        "lengthKm": props["length_km"], "ascentM": props["ascent_m"],
                        "bbox": bbox,
                    })

        if total == 0:
            log("No overlays found in cache — skipping PMTiles build")
            index_data: dict[str, Any] = {
                "version": 1,
                "generated": datetime.now(timezone.utc).isoformat(),
                "overlays": [],
            }
            index_dest.write_text(json.dumps(index_data, indent=2, default=str))
            return

        if unnamed_overlays:
            print(f"⚠  {len(unnamed_overlays)} overlay(s) have no name:", file=sys.stderr)
            for line in unnamed_overlays:
                print(line, file=sys.stderr)

        pmtiles_tmp = tmp / "overlays.pmtiles"
        with phase(f"Running tippecanoe for {total} overlay(s)"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(pmtiles_tmp),
                    "-l", "overlays", "-Z0", "-z14",
                    "--no-feature-limit", "--no-tile-size-limit",
                    "--simplification=4", "--coalesce-densest-as-needed", "--force",
                    str(geojsonseq),
                ],
                check=True,
            )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        log(f"Overlays PMTiles: {size_mb:.1f} MB")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))

    index_data = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(),
        "overlays": index_entries,
    }
    index_dest.write_text(json.dumps(index_data, indent=2, default=str))
    log(f"overlays-index.json: {len(index_entries)} overlays")


# ---------------------------------------------------------------------------
# Build action: build peaks PMTiles
# PMTiles features carry only name/category/ele — done status is derived
# at runtime from peaks-index.json loaded by the app.
# ---------------------------------------------------------------------------

async def _fetch_row_async(
    tasks: list[tuple[str, str, int]],
    etags: dict[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], set[str], dict[str, Any], int, int]:
    """Fetch all ROW data concurrently over HTTP/2.

    Returns (new_features_by_code, changed_codes, etag_updates, unchanged_count, error_count).
    """
    try:
        import httpx  # type: ignore[import]
    except ImportError:
        sys.exit("httpx missing — install with: uv add 'httpx[http2]'")

    total = len(tasks)
    new_features: dict[str, list[dict[str, Any]]] = {}
    changed: set[str] = set()
    etag_updates: dict[str, Any] = {}
    unchanged = errors = completed = 0

    async with httpx.AsyncClient(http2=True, timeout=30.0) as client:

        async def _one(code: str, name: str, type_num: int) -> tuple[str, int, str, list[dict[str, Any]], dict[str, str] | None]:
            url = f"{_ROW_BASE_URL}/{code}/mutated{type_num}.json"
            cached = etags.get(f"{code}/{type_num}", {})
            row_type = _ROW_TYPES[type_num]
            headers: dict[str, str] = {"User-Agent": "doneit-build/1.0"}
            if cached.get("etag"):
                headers["If-None-Match"] = cached["etag"]
            if cached.get("last_modified"):
                headers["If-Modified-Since"] = cached["last_modified"]

            for attempt in range(3):
                try:
                    resp = await client.get(url, headers=headers)
                    if resp.status_code == 304:
                        return code, type_num, "unchanged", [], None
                    if resp.status_code == 404:
                        return code, type_num, "notfound", [], None
                    resp.raise_for_status()
                    new_etag: dict[str, str] = {}
                    if resp.headers.get("etag"):
                        new_etag["etag"] = resp.headers["etag"]
                    if resp.headers.get("last-modified"):
                        new_etag["last_modified"] = resp.headers["last-modified"]
                    data = resp.json()
                    features = data.get("features", [])
                    for f in features:
                        p = f.get("properties") or {}
                        keep: dict[str, object] = {"row_type": row_type, "authority_name": name}
                        if "Name" in p:
                            keep["Name"] = p["Name"]
                        coords = (f.get("geometry") or {}).get("coordinates") or []
                        length_m = sum(
                            haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                            for i in range(1, len(coords))
                        ) if len(coords) > 1 else 0.0
                        keep["length_km"] = round(length_m / 1000, _ROW_LENGTH_PRECISION)
                        f["properties"] = keep
                    return code, type_num, "changed", features, new_etag or None
                except httpx.HTTPStatusError as e:
                    sc = e.response.status_code
                    if sc == 304:
                        return code, type_num, "unchanged", [], None
                    if sc == 404:
                        return code, type_num, "notfound", [], None
                    if attempt < 2:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    print(f"  warning: {code} {row_type}: HTTP {sc}", file=sys.stderr)
                    return code, type_num, "error", [], None
                except Exception as exc:
                    if attempt < 2:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    print(f"  warning: {code} {row_type}: {exc}", file=sys.stderr)
                    return code, type_num, "error", [], None
            return code, type_num, "error", [], None

        # asyncio is single-threaded so counter updates between awaits are safe without a lock
        for fut in asyncio.as_completed([_one(c, n, t) for c, n, t in tasks]):
            code, type_num, status, features, etag_entry = await fut
            completed += 1
            if status == "changed":
                new_features.setdefault(code, []).extend(features)
                changed.add(code)
                if etag_entry:
                    etag_updates[f"{code}/{type_num}"] = etag_entry
            elif status == "unchanged":
                unchanged += 1
            elif status == "error":
                errors += 1
            if completed % 100 == 0 or completed == total:
                log(f"{completed}/{total}: {len(changed)} changed, {unchanged} unchanged, {errors} errors")

    return new_features, changed, etag_updates, unchanged, errors


def _scrape_row_authorities() -> dict[str, str]:
    """Fetch the authority code→name mapping from the rowmaps.com datasets page."""
    import re
    import urllib.request
    req = urllib.request.Request(_ROW_DATASETS_URL, headers={"User-Agent": "doneit-build/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    matches = re.findall(r'href="([A-Z][A-Z0-9]+)/"[^>]*>(.*?)</a>', html)
    if not matches:
        sys.exit(f"Could not parse authority list from {_ROW_DATASETS_URL} — page layout may have changed")
    return {code: name.replace("&nbsp;", " ").strip() for code, name in matches}


def fetch_row_geojson(output_path: Path) -> None:
    """Download Rights of Way GeoJSON from rowmaps.com.

    Uses ETags and per-authority cache files to avoid re-downloading unchanged data.
    Only rewrites output_path when content actually changes, so doit skips build_row_pmtiles
    when nothing upstream has changed.

    Skips downloading (uses existing file) when DONEIT_OFFLINE=1 or no internet is detected.
    Exits with an error if the output file does not exist and downloading is not possible.
    """

    offline = os.environ.get("DONEIT_OFFLINE") == "1"
    if offline:
        if output_path.exists():
            print("  Offline mode — skipping ROW fetch, using existing file", file=sys.stderr)
            return
        sys.exit("--offline set but row.geojson does not exist; run without --offline first to fetch it")

    if not is_online():
        if output_path.exists():
            print("  No internet connection — skipping ROW fetch, using existing file", file=sys.stderr)
            return
        sys.exit("No internet connection and row.geojson does not exist; connect to the internet and retry")

    _ROW_CACHE_DIR.mkdir(exist_ok=True)

    _row_config_hash = hashlib.md5(
        json.dumps(sorted(_ROW_KEEP_PROPS) + [_ROW_LENGTH_PRECISION]).encode()
    ).hexdigest()

    authorities = _scrape_row_authorities()

    # Load saved ETags: {"CODE/type_num": {"etag": "...", "last_modified": "..."}}
    etags: dict[str, dict[str, str]] = {}
    if _ROW_ETAG_PATH.exists():
        try:
            etags = json.loads(_ROW_ETAG_PATH.read_text())
        except Exception as e:
            print(f"  warning: could not read ROW ETag cache — all authorities will be re-fetched: {e}", file=sys.stderr)

    # Detect authority-set changes (additions or deletions) by comparing the
    # current scraped codes against what the ETag cache was built from.
    cached_codes = {key.split("/")[0] for key in etags if "/" in key}
    added_codes = set(authorities) - cached_codes
    removed_codes = cached_codes - set(authorities)
    if added_codes:
        log(f"New authorit(ies) since last fetch: {', '.join(sorted(added_codes))}")
    if removed_codes:
        log(f"Removed authorit(ies) since last fetch: {', '.join(sorted(removed_codes))}")
        # Drop stale ETag entries so they don't accumulate
        for key in list(etags):
            if key.split("/")[0] in removed_codes:
                del etags[key]

    tasks = [
        (code, name, t)
        for code, name in sorted(authorities.items())
        for t in _ROW_TYPES
    ]
    new_etags: dict[str, Any] = dict(etags)
    new_etags["config_hash"] = _row_config_hash

    with phase(f"Fetching ROW data ({len(authorities)} authorities × {len(_ROW_TYPES)} types)"):
        new_features, changed_authorities, etag_updates, _unchanged, _errors = asyncio.run(
            _fetch_row_async(tasks, etags)
        )
    new_etags.update(etag_updates)

    # When ROW constants change, reprocess all cached authority files without re-downloading.
    config_reprocessed: set[str] = set()
    if etags.get("config_hash") != _row_config_hash:
        for code in sorted(authorities):
            if code in changed_authorities:
                continue  # fresh download already processed with current config
            cache_file = _ROW_CACHE_DIR / f"{code}.json"
            if not cache_file.exists():
                continue
            try:
                cached = json.loads(cache_file.read_text())
                for f in cached:
                    p = f.get("properties") or {}
                    new_p: dict[str, object] = {k: v for k, v in p.items() if k in _ROW_KEEP_PROPS}
                    coords = (f.get("geometry") or {}).get("coordinates") or []
                    length_m = sum(
                        haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                        for i in range(1, len(coords))
                    ) if len(coords) > 1 else 0.0
                    new_p["length_km"] = round(length_m / 1000, _ROW_LENGTH_PRECISION)
                    f["properties"] = new_p
                cache_file.write_text(json.dumps(cached, separators=(",", ":")))
                config_reprocessed.add(code)
            except Exception as e:
                print(f"  warning: could not reprocess cached ROW data for {code}: {e}", file=sys.stderr)
        if config_reprocessed:
            log(f"Config changed — reprocessed {len(config_reprocessed)} cached authority file(s)")
            changed_authorities.update(config_reprocessed)

    if not changed_authorities and not added_codes and not removed_codes:
        log(f"All {len(tasks)} files unchanged — skipping output write")
        _ROW_ETAG_PATH.write_text(json.dumps(new_etags))
        return

    # Merge newly downloaded and cached features into row.geojson
    reasons: list[str] = []
    server_changed = changed_authorities - config_reprocessed
    if server_changed:
        reasons.append(f"{len(server_changed)} changed")
    if config_reprocessed:
        reasons.append(f"{len(config_reprocessed)} config-reprocessed")
    if added_codes:
        reasons.append(f"{len(added_codes)} added")
    if removed_codes:
        reasons.append(f"{len(removed_codes)} removed")
    log(f"Rebuilding ({', '.join(reasons)}) ...")
    all_features: list[dict[str, Any]] = []
    for code in sorted(authorities):
        cache_file = _ROW_CACHE_DIR / f"{code}.json"
        if code in new_features:
            # Fresh download — write processed features to cache
            features = new_features[code]
            cache_file.write_text(json.dumps(features, separators=(",", ":")))
        elif cache_file.exists():
            # Either just stripped above, or genuinely unchanged — read from cache
            try:
                features = json.loads(cache_file.read_text())
            except Exception as e:
                print(f"  warning: could not read ROW cache for {cache_file.name} — skipping: {e}", file=sys.stderr)
                features = []
        else:
            features = []
        all_features.extend(features)

    geojson = {"type": "FeatureCollection", "features": all_features}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(geojson, separators=(",", ":")))
    _ROW_ETAG_PATH.write_text(json.dumps(new_etags))
    log(f"Wrote {len(all_features)} ROW features to {output_path.name}")


def run_build_row_pmtiles(geojson_path: Path, pmtiles_path: Path) -> None:
    """Convert row.geojson → row.pmtiles using tippecanoe."""
    with tempfile.TemporaryDirectory(prefix="doneit-row-") as tmpdir:
        tmp = Path(tmpdir) / "row.pmtiles"
        with phase("Running tippecanoe for ROW"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(tmp),
                    "-l", "row", "-Z0", "-z14",
                    "--drop-densest-as-needed", "--simplification=4", "--force",
                    str(geojson_path),
                ],
                check=True,
            )
        size_mb = tmp.stat().st_size / 1_048_576
        log(f"ROW PMTiles: {size_mb:.1f} MB")
        shutil.copyfile(str(tmp), str(pmtiles_path))


def run_build_peaks_pmtiles(
    peaks_gpx_files: dict[str, Path],
    pmtiles_dest: Path,
) -> None:
    all_peaks: dict[str, list[dict[str, Any]]] = {}
    for filename, gvfs_path in sorted(peaks_gpx_files.items()):
        category = filename[:-4].lower()
        all_peaks[category] = parse_gpx_waypoints(gvfs_path, filename)

    with tempfile.TemporaryDirectory(prefix="doneit-peaks-") as tmpdir:
        tmp = Path(tmpdir)
        geojsonseq = tmp / "peaks.geojsonseq"
        total = 0

        with geojsonseq.open("w") as out:
            for category, waypoints in sorted(all_peaks.items()):
                for wpt in waypoints:
                    out.write(json.dumps({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [wpt["lng"], wpt["lat"]]},
                        "properties": {
                            "name": wpt["name"], "ele": wpt["ele"], "category": category,
                        },
                    }) + "\n")
                    total += 1
                log(f"{category}: {len(waypoints)} waypoints")

        if total == 0:
            log("No waypoints found — skipping peaks PMTiles")
            return

        pmtiles_tmp = tmp / "peaks.pmtiles"
        with phase(f"Running tippecanoe for {total} peaks"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(pmtiles_tmp),
                    "-l", "peaks", "-Z0", "-z14",
                    "-r1", "--no-feature-limit", "--no-tile-size-limit", "--force",
                    str(geojsonseq),
                ],
                check=True,
            )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        log(f"Peaks PMTiles: {size_mb:.1f} MB, {total} waypoints")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))
