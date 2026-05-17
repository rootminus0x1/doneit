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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DRIVE_FOLDER = "DoneIt"
DONEIT_LOCAL = Path(__file__).parent.parent.parent / DRIVE_FOLDER
GVFS_BASE = Path(f"/run/user/{os.getuid()}/gvfs")
PEAKS_INDEX_NAME = "peaks-index.json"

BUILD_DIR = Path(__file__).parent / "build"

GPX_CACHE_PATH = BUILD_DIR / "gpx-cache.json"
ROW_GEOJSON_PATH = BUILD_DIR / "row.geojson"
ROW_PMTILES_PATH = DONEIT_LOCAL / "row.pmtiles"
_ROW_BASE_URL = "https://www.rowmaps.com/jsons"
_ROW_ETAG_PATH = BUILD_DIR / "row-etags.json"
_ROW_CACHE_DIR = BUILD_DIR / "row-cache"
_ROW_TYPES = {1: "footpath", 2: "bridleway", 3: "restricted_byway", 4: "byway"}
_ROW_AUTHORITIES = {
    "B1": "Brecon Beacons National Park",
    "B2": "Bournemouth, Christchurch and Poole",
    "BA": "Bradford",
    "BB": "Blackburn with Darwen",
    "BC": "Bracknell Forest",
    "BD": "Barking and Dagenham",
    "BE": "Bridgend",
    "BF": "Bedford",
    "BG": "Blaenau Gwent",
    "BH": "City of Brighton and Hove",
    "BI": "Birmingham",
    "BL": "Barnsley",
    "BM": "Buckinghamshire",
    "BO": "Bolton",
    "BP": "Blackpool",
    "BR": "Bromley",
    "BS": "Bath and North East Somerset",
    "BX": "Bexley",
    "BY": "Bury",
    "BZ": "City of Bristol",
    "CA": "Calderdale",
    "CB": "Cambridgeshire",
    "CC": "Cheshire West and Chester",
    "CD": "Cardiff",
    "CE": "Ceredigion",
    "CF": "Caerphilly",
    "CH": "Cheshire East",
    "CN": "Cornwall",
    "CT": "Carmarthenshire",
    "CU": "Cumbria",
    "CV": "Coventry",
    "CW": "Conwy",
    "DB": "City of Derby",
    "DE": "Denbighshire",
    "DL": "Darlington",
    "DN": "Devon",
    "DR": "Doncaster",
    "DT": "Dorset",
    "DU": "Durham",
    "DY": "Derbyshire",
    "DZ": "Dudley",
    "EG": "Ealing",
    "ES": "East Sussex",
    "EX": "Essex",
    "EY": "East Riding of Yorkshire",
    "FL": "Flintshire",
    "GH": "Gateshead",
    "GR": "Gloucestershire",
    "GY": "Gwynedd",
    "HA": "Halton",
    "HD": "Hertfordshire",
    "HE": "Herefordshire",
    "HG": "Haringey",
    "HI": "Hillingdon",
    "HP": "Hampshire",
    "HS": "Hounslow",
    "IA": "Isle of Anglesey",
    "IW": "Isle of Wight",
    "KG": "Kingston upon Thames",
    "KH": "City of Kingston upon Hull",
    "KL": "Kirklees",
    "KT": "Kent",
    "L1": "Lake District National Park",
    "LA": "Lancashire",
    "LC": "City of Leicester",
    "LD": "Leeds",
    "LL": "Lincolnshire",
    "LP": "Liverpool",
    "LT": "Leicestershire",
    "MA": "Manchester",
    "MB": "Middlesbrough",
    "ME": "Medway",
    "MK": "Milton Keynes",
    "MM": "Monmouthshire",
    "MT": "Merthyr Tydfil",
    "N2": "North Northamptonshire",
    "N3": "West Northamptonshire",
    "NC": "North East Lincolnshire",
    "ND": "Northumberland",
    "NE": "Newport",
    "NG": "City of Nottingham",
    "NI": "North Lincolnshire",
    "NK": "Norfolk",
    "NP": "Neath Port Talbot",
    "NS": "North Somerset",
    "NT": "Nottinghamshire",
    "NW": "Newcastle upon Tyne",
    "NY": "North Yorkshire",
    "OH": "Oldham",
    "ON": "Oxfordshire",
    "PB": "Pembrokeshire",
    "PE": "City of Peterborough",
    "PO": "City of Portsmouth",
    "PW": "Powys",
    "PY": "City of Plymouth",
    "RB": "Redbridge",
    "RC": "Redcar and Cleveland",
    "RD": "Rochdale",
    "RG": "Reading",
    "RH": "Rhondda Cynon Taff",
    "RL": "Rutland",
    "SA": "Sandwell",
    "SC": "Salford",
    "SD": "Swindon",
    "SE": "Sefton",
    "SF": "Staffordshire",
    "SG": "South Gloucestershire",
    "SH": "Shropshire",
    "SK": "Suffolk",
    "SM": "Stockton on Tees",
    "SN": "St Helens",
    "SO": "City of Southampton",
    "SP": "Sheffield",
    "SQ": "Solihull",
    "SS": "Swansea",
    "ST": "Somerset",
    "SU": "Surrey",
    "SV": "Sunderland",
    "SY": "South Tyneside",
    "SZ": "Sutton",
    "TB": "Torbay",
    "TF": "Torfaen",
    "TS": "Tameside",
    "TU": "Thurrock",
    "VG": "Vale of Glamorgan",
    "WA": "Walsall",
    "WB": "West Berkshire",
    "WC": "Windsor and Maidenhead",
    "WE": "Wakefield",
    "WF": "Waltham Forest",
    "WG": "Warrington",
    "WH": "City of Wolverhampton",
    "WJ": "Wokingham",
    "WK": "Warwickshire",
    "WN": "Wigan",
    "WO": "Worcestershire",
    "WP": "Telford and Wrekin",
    "WR": "Wirral",
    "WS": "West Sussex",
    "WX": "Wrexham",
    "YK": "York",
    "YT": "Slough",
    "YY": "Stockport",
}


# ---------------------------------------------------------------------------
# Startup helpers (called explicitly by dodo.py, never at import time)
# ---------------------------------------------------------------------------

def ensure_build_dirs() -> None:
    """Create local build/output directories. Must be called before any file I/O."""
    BUILD_DIR.mkdir(exist_ok=True)
    DONEIT_LOCAL.mkdir(exist_ok=True)
    (DONEIT_LOCAL / "tracks").mkdir(exist_ok=True)
    (DONEIT_LOCAL / "peaks").mkdir(exist_ok=True)


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
        data = json.loads(cache_path.read_text())
        if data.get("version") == 1:
            entries: dict[str, Any] = data.get("entries", {})
            print(f"  Loaded {len(entries)} cached GPX entries")
            return entries
    except Exception as e:
        print(f"Warning: could not read {cache_path.name}: {e}", file=sys.stderr)
    return {}


def save_gpx_cache(cache_path: Path, entries: dict[str, Any]) -> None:
    data = {
        "version": 1,
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
        [[p.longitude, p.latitude] for seg in track.segments for p in seg.points]
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

    for src, dst in pairs:
        if not src.exists():
            continue
        if dst.exists() and md5(src) == md5(dst):
            print(f"  unchanged: {src.name}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(src), str(dst))
        print(f"  deployed:  {src.name}")


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
        length_km = round(
            sum(haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0])
                for i in range(1, len(coords))) / 1000, 2
        ) if len(coords) > 1 else 0.0
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "category": category, "filename": filename, "file_id": file_id,
                "display_name": display_name, "date": date, "datetime": dt,
                "track_type": meta.get("trackType"), "link_text": meta.get("linkText"),
                "length_km": length_km,
            },
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
            print(f"  {filename}: {total} peak(s) matched")
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
    print(f"  {len(to_parse)} of {len(all_gpx)} track(s) changed"
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
        print(f"  peaks loaded ({time.perf_counter() - t1:.1f}s)")

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
            print("  peaks content changed — triggering full re-bag")
            full_rebag = True
        elif peaks_index.get("bag_distance") != bag_distance_m:
            print(f"  bag distance changed to {bag_distance_m} m — triggering full re-bag")
            full_rebag = True
        peaks_index["peak_hash"] = peak_hash
        peaks_index["bag_distance"] = bag_distance_m

    if not to_parse and not full_rebag:
        print(f"  nothing to do")
        return cache

    # --- Phase 3: parse new/changed tracks ---
    if to_parse:
        t2 = time.perf_counter()
        print(f"Parsing {len(to_parse)} new/changed track(s) ...")
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
            print(f"  cached {key}")
        print(f"  parsed in {time.perf_counter() - t2:.1f}s")

    # --- Phase 4: bagging ---
    if peaks_gpx_files and peaks_index_path and peaks_index is not None:
        if full_rebag:
            print(f"Re-running bagging detection for all {len(cache)} cached tracks ...")
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
            print(f"Checking {len(new_tracks)} track(s) against all peaks ...")
            new_bagged = detect_baggings_for_new_tracks(new_tracks, all_peaks, bag_distance_m)
            if new_bagged:
                total = sum(sum(len(p["names"]) for p in e["peaks"]) for e in new_bagged)
                print(f"  {total} peak(s) bagged across {len(new_bagged)} track(s)")
                peaks_index.setdefault("bagged", []).extend(new_bagged)
            print(f"  bagging detection in {time.perf_counter() - t3:.1f}s")

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
        print(f"Running tippecanoe for {total} track(s) ...")
        subprocess.run(
            [
                "tippecanoe", "-o", str(pmtiles_tmp), "-l", "tracks",
                "-Z0", "-z14", "--no-feature-limit", "--no-tile-size-limit",
                "--simplification=4", "--coalesce-densest-as-needed", "--force",
                str(geojsonseq),
            ],
            check=True,
        )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        print(f"  Tracks PMTiles: {size_mb:.1f} MB")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))

    index_data: dict[str, Any] = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(),
        "tracks": index_entries,
    }
    index_dest.write_text(json.dumps(index_data, indent=2, default=str))
    print(f"  tracks-index.json: {len(index_entries)} tracks")


# ---------------------------------------------------------------------------
# Build action: build peaks PMTiles
# PMTiles features carry only name/category/ele — done status is derived
# at runtime from peaks-index.json loaded by the app.
# ---------------------------------------------------------------------------

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

    # Load saved ETags: {"CODE/type_num": {"etag": "...", "last_modified": "..."}}
    etags: dict[str, dict[str, str]] = {}
    if _ROW_ETAG_PATH.exists():
        try:
            etags = json.loads(_ROW_ETAG_PATH.read_text())
        except Exception:
            pass

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
                    p = f.setdefault("properties", {})
                    p["row_type"] = row_type
                    p["authority_code"] = code
                    p["authority_name"] = name
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
        for code, name in sorted(_ROW_AUTHORITIES.items())
        for t in _ROW_TYPES
    ]
    total = len(tasks)

    # Accumulate new features per authority; track which ones changed
    new_features: dict[str, list[dict[str, Any]]] = {}   # code -> features from this run
    changed_authorities: set[str] = set()
    new_etags = dict(etags)  # start from existing, update in place
    completed = 0
    unchanged = errors = 0

    print(f"Checking ROW data: {len(_ROW_AUTHORITIES)} authorities × {len(_ROW_TYPES)} types ...")
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
                print(f"  {completed}/{total}: {len(changed_authorities)} changed, {unchanged} unchanged, {errors} errors")

    if not changed_authorities:
        print(f"  All {total} files unchanged — skipping output write")
        _ROW_ETAG_PATH.write_text(json.dumps(new_etags))
        return

    # Load cached features for unchanged authorities, merge with newly downloaded ones
    print(f"  {len(changed_authorities)} authorit(ies) changed — rebuilding ...")
    all_features: list[dict[str, Any]] = []
    for code in sorted(_ROW_AUTHORITIES):
        cache_file = _ROW_CACHE_DIR / f"{code}.json"
        if code in changed_authorities:
            features = new_features.get(code, [])
            cache_file.write_text(json.dumps(features, separators=(",", ":")))
        elif cache_file.exists():
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
    print(f"  Wrote {len(all_features)} ROW features to {output_path.name}")


def run_build_row_pmtiles(geojson_path: Path, pmtiles_path: Path) -> None:
    """Convert row.geojson → row.pmtiles using tippecanoe."""
    with tempfile.TemporaryDirectory(prefix="doneit-row-") as tmpdir:
        tmp = Path(tmpdir) / "row.pmtiles"
        subprocess.run(
            [
                "tippecanoe",
                "-o", str(tmp), "-l", "row",
                "-Z10", "-z16",
                "--no-feature-limit", "--no-tile-size-limit",
                "--simplification=2",
                "--force",
                str(geojson_path),
            ],
            check=True,
        )
        size_mb = tmp.stat().st_size / 1_048_576
        print(f"  ROW PMTiles: {size_mb:.1f} MB")
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
                print(f"  {category}: {len(waypoints)} waypoints")

        if total == 0:
            print("No waypoints found — skipping peaks PMTiles")
            return

        pmtiles_tmp = tmp / "peaks.pmtiles"
        subprocess.run(
            [
                "tippecanoe", "-o", str(pmtiles_tmp), "-l", "peaks",
                "-Z0", "-z14", "-r1", "--no-feature-limit", "--no-tile-size-limit", "--force",
                str(geojsonseq),
            ],
            check=True,
        )
        size_mb = pmtiles_tmp.stat().st_size / 1_048_576
        print(f"  Peaks PMTiles: {size_mb:.1f} MB, {total} waypoints")
        shutil.copyfile(str(pmtiles_tmp), str(pmtiles_dest))
