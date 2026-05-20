"""Core pipeline functions for the DoneIt build system.

All Drive interaction goes through GVFS (google-drive: FUSE mount).
No doit-specific code here — pure functions called by dodo.py task actions.
"""

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
ROW_PMTILES_CONFIG    = Path(__file__).parent / "row-pmtiles.json"
TRACKS_PMTILES_CONFIG = Path(__file__).parent / "tracks-pmtiles.json"
PEAKS_PMTILES_CONFIG  = Path(__file__).parent / "peaks-pmtiles.json"
BAG_CONFIG            = Path(__file__).parent / "bag-config.json"
ROW_CONFIG            = Path(__file__).parent / "row-config.json"
TRACKS_CONFIG         = Path(__file__).parent / "tracks-config.json"


def _load_pmtiles_config(path: Path) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)  # type: ignore[no-any-return]
DONEIT_LOCAL = Path(__file__).parent.parent.parent / DRIVE_FOLDER
GVFS_BASE = Path(f"/run/user/{os.getuid()}/gvfs")
PEAKS_INDEX_NAME = "peaks-index.json"

BUILD_DIR = Path(__file__).parent / "build"

GPX_CACHE_PATH    = BUILD_DIR / "gpx-cache.json"
ROW_GEOJSON_PATH  = BUILD_DIR / "row.geojson"
ROW_PMTILES_PATH      = DONEIT_LOCAL / "generated" / "row.pmtiles"
TRACKS_PMTILES_PATH   = DONEIT_LOCAL / "generated" / "tracks.pmtiles"
TRACKS_INDEX_PATH     = DONEIT_LOCAL / "generated" / "tracks-index.json"
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

def find_gdrive_root() -> Path:
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


_PEAKS_INDEX_KEYS = {"version", "generated", "categories", "bagged", "peak_hash", "bag_distance", "bag_config_hash"}

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


def parse_gpx_coords(gpx_path: Path, filename: str) -> list[list[list[float]]]:
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
        [[p.longitude, p.latitude, p.elevation or 0.0] for seg in track.segments for p in seg.points]
        for track in parsed.tracks
    ]


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
            if dst.exists() and md5(src) == md5(dst):
                log(f"unchanged: {src.name}")
                continue
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

def build_track_features(
    entry: dict[str, Any],
    category: str,
    file_id: str | None,
    filename: str,
    unnamed_out: list[str],
    tracks_cfg: dict[str, Any],
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
        }
        if tracks_cfg.get("compute_length_km", True):
            props["length_km"] = round(
                sum(haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                    for i in range(1, len(coords))) / 1000, 2
            ) if len(coords) > 1 else 0.0
        if tracks_cfg.get("compute_ascent_m", False):
            ascent = 0.0
            for i in range(1, len(coords)):
                if len(coords[i]) > 2 and len(coords[i - 1]) > 2:
                    dz = coords[i][2] - coords[i - 1][2]
                    if dz > 0:
                        ascent += dz
            props["ascent_m"] = round(ascent)
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
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

    # --- Phase 1: check which tracks need re-parsing ---
    # Fast path: use cached mtime; only read the file for MD5 if mtime changed.
    t0 = time.perf_counter()
    to_parse: list[tuple[str, str, Path, str]] = []
    md5_reads = 0
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
    skipped = len(all_gpx) - md5_reads
    log(f"{len(to_parse)} of {len(all_gpx)} track(s) changed"
        f" — {skipped} skipped by mtime, {md5_reads} read ({time.perf_counter() - t0:.1f}s)")

    # --- Phase 2: load peaks (before early-return so a peaks-only change triggers re-bag) ---
    all_peaks: dict[str, list[dict[str, Any]]] = {}
    peaks_index: dict[str, Any] | None = None
    full_rebag = False
    if peaks_gpx_files and peaks_index_path:
        t1 = time.perf_counter()
        for peak_filename, gvfs_path in sorted(peaks_gpx_files.items()):
            category = peak_filename[:-4].lower()
            all_peaks[category] = parse_gpx_waypoints(gvfs_path, peak_filename)
        log(f"peaks loaded ({time.perf_counter() - t1:.1f}s)")

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
        bag_config_hash = hashlib.md5(BAG_CONFIG.read_bytes()).hexdigest()
        full_rebag = False
        if peaks_index.get("peak_hash") != peak_hash:
            log("peaks content changed — triggering full re-bag")
            full_rebag = True
        elif peaks_index.get("bag_config_hash") != bag_config_hash:
            log("bag config changed — triggering full re-bag")
            full_rebag = True
        peaks_index["peak_hash"] = peak_hash
        peaks_index["bag_config_hash"] = bag_config_hash
        peaks_index["bag_distance"] = bag_distance_m

    if not to_parse and not full_rebag:
        log("nothing to do")
        return cache

    # --- Phase 3: parse new/changed tracks ---
    if to_parse:
        t2 = time.perf_counter()
        log(f"Parsing {len(to_parse)} new/changed track(s) ...")
        new_metas = extract_gpx_metadata_batch([p for _, _, p, _ in to_parse])
        for (cat, fn, path, md5), meta in zip(to_parse, new_metas):
            key = f"{cat}/{fn}"
            tracks_coords = parse_gpx_coords(path, fn)
            mtime: float | None = None
            try:
                mtime = path.stat().st_mtime
            except OSError:
                pass
            cache[key] = {"md5": md5, "mtime": mtime, "meta": meta, "tracks": tracks_coords}
            log(f"cached {key}")
        log(f"parsed in {time.perf_counter() - t2:.1f}s")

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
    tracks_cfg = json.loads(TRACKS_CONFIG.read_text())
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
                features = build_track_features(entry, category, file_id, filename, unnamed_tracks, tracks_cfg)
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
        cfg = _load_pmtiles_config(TRACKS_PMTILES_CONFIG)
        with phase(f"Running tippecanoe for {total} track(s)"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(pmtiles_tmp),
                    "-l", cfg["layer"],
                    f"-Z{cfg['min_zoom']}", f"-z{cfg['max_zoom']}",
                    *cfg["extra_args"],
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
# Build action: build peaks PMTiles
# PMTiles features carry only name/category/ele — done status is derived
# at runtime from peaks-index.json loaded by the app.
# ---------------------------------------------------------------------------

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
    import urllib.error
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor, as_completed

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

    _row_cfg_bytes = ROW_CONFIG.read_bytes()
    _row_cfg = json.loads(_row_cfg_bytes)
    _row_config_hash = hashlib.md5(_row_cfg_bytes).hexdigest()
    _keep_props: frozenset[str] = frozenset(_row_cfg.get("keep_properties", ["Name", "row_type", "authority_name"]))
    _compute_length = bool(_row_cfg.get("compute_length_km", True))
    _length_precision = int(_row_cfg.get("length_km_precision", 3))

    authorities = _scrape_row_authorities()

    # Load saved ETags: {"CODE/type_num": {"etag": "...", "last_modified": "..."}}
    etags: dict[str, dict[str, str]] = {}
    if _ROW_ETAG_PATH.exists():
        try:
            etags = json.loads(_ROW_ETAG_PATH.read_text())
        except Exception:
            pass

    # Detect authority-set changes (additions or deletions) by comparing the
    # current scraped codes against what the ETag cache was built from.
    cached_codes = {key.split("/")[0] for key in etags}
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

    def _fetch_one(code: str, name: str, type_num: int) -> tuple[str, int, str, list[dict[str, Any]], dict[str, str] | None]:
        """Returns (code, type_num, status, features, new_etag_entry).
        status is 'changed', 'unchanged', 'notfound', or 'error'.
        """
        url = f"{_ROW_BASE_URL}/{code}/mutated{type_num}.json"
        key = f"{code}/{type_num}"
        cached = etags.get(key, {})
        row_type = _ROW_TYPES[type_num]

        headers: dict[str, str] = {"User-Agent": "doneit-build/1.0"}
        if cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        if cached.get("last_modified"):
            headers["If-Modified-Since"] = cached["last_modified"]

        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    new_etag: dict[str, str] = {}
                    if resp.headers.get("ETag"):
                        new_etag["etag"] = resp.headers["ETag"]
                    if resp.headers.get("Last-Modified"):
                        new_etag["last_modified"] = resp.headers["Last-Modified"]
                    data = json.loads(resp.read())
                features = data.get("features", [])
                for f in features:
                    p = f.get("properties") or {}
                    keep: dict[str, object] = {"row_type": row_type, "authority_name": name}
                    if "Name" in p:
                        keep["Name"] = p["Name"]
                    if _compute_length:
                        coords = (f.get("geometry") or {}).get("coordinates") or []
                        length_m = sum(
                            haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                            for i in range(1, len(coords))
                        ) if len(coords) > 1 else 0.0
                        keep["length_km"] = round(length_m / 1000, _length_precision)
                    f["properties"] = keep
                return code, type_num, "changed", features, new_etag or None
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return code, type_num, "unchanged", [], None
                if e.code == 404:
                    return code, type_num, "notfound", [], None
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                print(f"  warning: {code} {row_type}: HTTP {e.code}", file=sys.stderr)
                return code, type_num, "error", [], None
            except Exception as exc:
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                print(f"  warning: {code} {row_type}: {exc}", file=sys.stderr)
                return code, type_num, "error", [], None
        return code, type_num, "error", [], None

    tasks = [
        (code, name, t)
        for code, name in sorted(authorities.items())
        for t in _ROW_TYPES
    ]
    total = len(tasks)

    # Accumulate new features per authority; track which ones changed
    new_features: dict[str, list[dict[str, Any]]] = {}   # code -> features from this run
    changed_authorities: set[str] = set()
    new_etags: dict[str, Any] = dict(etags)  # start from existing, update in place
    new_etags["config_hash"] = _row_config_hash
    completed = 0
    unchanged = errors = 0

    with phase(f"Fetching ROW data ({len(authorities)} authorities × {len(_ROW_TYPES)} types)"):
        with ThreadPoolExecutor(max_workers=16) as pool:
            futures = {pool.submit(_fetch_one, code, name, t): None for code, name, t in tasks}
            for future in as_completed(futures):
                code, type_num, status, features, etag_entry = future.result()
                completed += 1
                if status == "changed":
                    new_features.setdefault(code, []).extend(features)
                    changed_authorities.add(code)
                    if etag_entry:
                        new_etags[f"{code}/{type_num}"] = etag_entry
                elif status == "unchanged":
                    unchanged += 1
                elif status == "error":
                    errors += 1
                if completed % 100 == 0 or completed == total:
                    log(f"{completed}/{total}: {len(changed_authorities)} changed, {unchanged} unchanged, {errors} errors")

    # When row-config.json changes, reprocess all cached authority files with the new config.
    # This updates property filtering and recomputes derived fields (e.g. length_km from geometry)
    # without re-downloading anything.
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
                    new_p: dict[str, object] = {k: v for k, v in p.items() if k in _keep_props}
                    if _compute_length:
                        coords = (f.get("geometry") or {}).get("coordinates") or []
                        length_m = sum(
                            haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                            for i in range(1, len(coords))
                        ) if len(coords) > 1 else 0.0
                        new_p["length_km"] = round(length_m / 1000, _length_precision)
                    f["properties"] = new_p
                cache_file.write_text(json.dumps(cached, separators=(",", ":")))
                config_reprocessed.add(code)
            except Exception:
                pass
        if config_reprocessed:
            log(f"Config changed — reprocessed {len(config_reprocessed)} cached authority file(s)")
            changed_authorities.update(config_reprocessed)

    if not changed_authorities and not added_codes and not removed_codes:
        log(f"All {total} files unchanged — skipping output write")
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
            except Exception:
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
    cfg = _load_pmtiles_config(ROW_PMTILES_CONFIG)
    with tempfile.TemporaryDirectory(prefix="doneit-row-") as tmpdir:
        tmp = Path(tmpdir) / "row.pmtiles"
        with phase("Running tippecanoe for ROW"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(tmp),
                    "-l", cfg["layer"],
                    f"-Z{cfg['min_zoom']}", f"-z{cfg['max_zoom']}",
                    *cfg["extra_args"],
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
        cfg = _load_pmtiles_config(PEAKS_PMTILES_CONFIG)
        with phase(f"Running tippecanoe for {total} peaks"):
            subprocess.run(
                [
                    "tippecanoe", "-o", str(pmtiles_tmp),
                    "-l", cfg["layer"],
                    f"-Z{cfg['min_zoom']}", f"-z{cfg['max_zoom']}",
                    *cfg["extra_args"],
                    str(geojsonseq),
                ],
                check=True,
            )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        log(f"Peaks PMTiles: {size_mb:.1f} MB, {total} waypoints")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))
