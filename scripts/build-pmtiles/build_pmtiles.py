#!/usr/bin/env python3
"""
Build tracks.pmtiles from GPX files via the GVFS Google Drive mount.

Prerequisites:
  - Google Drive mounted in GNOME (Settings → Online Accounts → Google)
    The same account that the file manager shows is used — no extra auth needed.
  - tippecanoe installed:
      sudo apt install tippecanoe
      or build from: https://github.com/felt/tippecanoe

Usage:
  uv run build_pmtiles.py [--folder DRIVE_FOLDER] [--country]

The script:
  1. Locates the Google Drive GVFS mount (used by the file manager)
  2. Navigates to <folder>/tracks/ by display name
  3. Converts all category/*.gpx files to a GeoJSONSeq with category/file_id properties
     (uses gpx-cache.json on Drive to skip unchanged files)
  4. Runs tippecanoe to generate tracks.pmtiles (zoom 0-14, single 'tracks' layer)
  5. Writes tracks.pmtiles, tracks-index.json, and gpx-cache.json back to Drive
  6. Prints the Drive file ID -- add it to tile-sources.json on first run

Pass --country to also download Natural Earth boundaries and look up the country for
each track. This is slow and unreliable for coastal tracks so is off by default.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import gpxpy
    import geopandas as gpd
    from shapely.geometry import Point
except ImportError:
    sys.exit("Dependencies missing — run via: uv run build_pmtiles.py")

COUNTRIES_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"
COUNTRIES_PATH = Path(__file__).parent.parent.parent / "public" / "ne_110m_countries.geojson"
GPX_CACHE_NAME = "gpx-cache.json"
GVFS_BASE = Path(f"/run/user/{os.getuid()}/gvfs")


def check_tool(name: str) -> None:
    if subprocess.run(["which", name], capture_output=True).returncode != 0:
        sys.exit(
            f"Required tool not found: {name}\n"
            "  tippecanoe: sudo apt install tippecanoe\n"
            "              or build from https://github.com/felt/tippecanoe"
        )


def fetch_countries() -> None:
    """Download Natural Earth 10m admin-1 boundaries and write to public/."""
    print("Fetching country data from Natural Earth ...")
    gdf: Any = gpd.read_file(COUNTRIES_URL)  # type: ignore[no-untyped-call]
    gdf = gdf[["name", "geonunit", "admin", "geometry"]]
    gdf["geometry"] = gdf["geometry"].simplify(0.001, preserve_topology=True)
    COUNTRIES_PATH.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(COUNTRIES_PATH, driver="GeoJSON")
    print(f"  {len(gdf)} features written to {COUNTRIES_PATH.name}")


def find_gdrive_root() -> Path:
    """Return the top-level Drive root folder path from the GVFS mount."""
    mounts = [p for p in GVFS_BASE.iterdir() if p.name.startswith("google-drive:")]
    if not mounts:
        sys.exit(
            "Google Drive not found in GVFS.\n"
            "Add your Google account in Settings → Online Accounts."
        )
    mount = mounts[0]
    roots = [p for p in mount.iterdir() if p.name != "GVfsSharedWithMe"]
    if not roots:
        sys.exit("Google Drive mount found but root folder is empty.")
    return roots[0]


def list_by_name(parent: Path) -> dict[str, Path]:
    """
    Return {display_name: path} for all children of parent.
    Uses a single batch gio info call for efficiency.
    """
    children = list(parent.iterdir())
    if not children:
        return {}

    result = subprocess.run(
        ["gio", "info", "-a", "standard::display-name,standard::type", *[str(c) for c in children]],
        capture_output=True,
        text=True,
    )

    name_map: dict[str, Path] = {}
    current_path: Path | None = None

    for line in result.stdout.splitlines():
        if line.startswith("local path:"):
            current_path = Path(line.split(":", 1)[1].strip())
        elif "standard::display-name:" in line and current_path:
            display_name = line.split("standard::display-name:", 1)[1].strip()
            name_map[display_name] = current_path

    return name_map


def find_folder(parent: Path, name: str) -> Path:
    names = list_by_name(parent)
    if name not in names:
        sys.exit(f"Folder '{name}' not found in {parent.name}. Available: {sorted(names)}")
    return names[name]


def get_drive_id(gvfs_path: Path) -> str:
    """The last path component in GVFS is the Drive file ID."""
    return gvfs_path.name


def load_country_index() -> tuple[Any, Any]:
    if not COUNTRIES_PATH.exists():
        sys.exit(f"Countries file not found at {COUNTRIES_PATH}")
    gdf: Any = gpd.read_file(COUNTRIES_PATH)  # type: ignore[no-untyped-call]
    return gdf, gdf.sindex


def lookup_country(gdf: Any, sindex: Any, lng: float, lat: float) -> str | None:
    """Exact containment check."""
    pt = Point(lng, lat)
    for idx in sindex.query(pt):
        row: Any = gdf.iloc[idx]
        if row.geometry.contains(pt):
            # Prefer geonunit (e.g. "Scotland") over admin (e.g. "United Kingdom")
            geonunit: Any = row.get("geonunit")
            admin: Any = row.get("admin")
            return str(geonunit) if (geonunit and geonunit != admin) else (str(admin) if admin else None)
    return None


def lookup_country_nearest(gdf: Any, sindex: Any, lng: float, lat: float, max_dist: float = 0.05) -> str | None:
    """Nearest-polygon fallback for coastal tracks where GPS points land in the sea."""
    pt = Point(lng, lat)
    candidates = list(sindex.query(pt.buffer(max_dist)))
    if not candidates:
        return None
    best_dist = float("inf")
    best_row: Any = None
    for idx in candidates:
        row: Any = gdf.iloc[idx]
        d: float = row.geometry.distance(pt)
        if d < best_dist:
            best_dist = d
            best_row = row
    if best_row is not None and best_dist <= max_dist:
        geonunit: Any = best_row.get("geonunit")
        admin: Any = best_row.get("admin")
        return str(geonunit) if (geonunit and geonunit != admin) else (str(admin) if admin else None)
    return None


def find_country(gdf: Any, sindex: Any, all_coords: list[list[float]]) -> str | None:
    """Sample up to 20 evenly-spaced track points; fall back to nearest polygon for coastal tracks."""
    n = len(all_coords)
    sample_count = min(20, n)
    step = (n - 1) / (sample_count - 1) if sample_count > 1 else 0
    indices = list(dict.fromkeys(int(round(i * step)) for i in range(sample_count)))
    for idx in indices:
        country = lookup_country(gdf, sindex, all_coords[idx][0], all_coords[idx][1])
        if country:
            return country
    # Nearest-polygon fallback for coastal tracks where sampled points land in the sea
    mid = all_coords[n // 2]
    return lookup_country_nearest(gdf, sindex, mid[0], mid[1])


def extract_gpx_metadata_batch(gvfs_paths: list[Path]) -> list[dict[str, str | None]]:
    """Run gpx-meta-cli.ts via tsx for all files in one subprocess call."""
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
    """Parse coordinate lists from a GPX file — one list of [lng, lat] per track element."""
    with gpx_path.open(encoding="utf-8", errors="replace") as f:
        try:
            parsed = gpxpy.parse(f)  # type: ignore[no-untyped-call]
        except Exception as e:
            print(f"  skip {filename}: {e}", file=sys.stderr)
            return []
    return [
        [[p.longitude, p.latitude] for seg in track.segments for p in seg.points]  # type: ignore[union-attr]
        for track in parsed.tracks  # type: ignore[union-attr]
    ]


def load_gpx_cache(track_names: dict[str, Path]) -> dict[str, Any]:
    """Returns cached GPX entries dict."""
    if GPX_CACHE_NAME not in track_names:
        return {}
    try:
        data = json.loads(track_names[GPX_CACHE_NAME].read_text())
        if data.get("version") == 1:
            entries: dict[str, Any] = data.get("entries", {})
            print(f"  Loaded {len(entries)} cached GPX entries")
            return entries
    except Exception as e:
        print(f"Warning: could not read {GPX_CACHE_NAME}: {e}", file=sys.stderr)
    return {}


def save_gpx_cache(tracks_folder: Path, entries: dict[str, Any]) -> None:
    data: dict[str, object] = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }
    (tracks_folder / GPX_CACHE_NAME).write_text(json.dumps(data))


def build_features_from_cache(
    entry: dict[str, Any],
    category: str,
    file_id: str | None,
    filename: str,
    unnamed_out: list[str],
) -> list[dict[str, object]]:
    meta: dict[str, str | None] = entry["meta"]
    dt = meta.get("datetime")
    date: str | None = dt[:10] if dt else None

    display_name = meta.get("displayName")
    if not display_name:
        display_name = f"{date} · {category}" if date else Path(filename).stem
        unnamed_out.append(f"  {category}/{filename}  →  \"{display_name}\"")

    features: list[dict[str, object]] = []
    for coords in entry["tracks"]:
        if not coords:
            continue
        length_km = round(
            sum(haversine_m(coords[i][1], coords[i][0], coords[i - 1][1], coords[i - 1][0]) for i in range(1, len(coords))) / 1000,
            2,
        ) if len(coords) > 1 else 0.0
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "category": category,
                "filename": filename,
                "file_id": file_id,
                "display_name": display_name,
                "date": date,
                "datetime": dt,
                "track_type": meta.get("trackType"),
                "link_text": meta.get("linkText"),
                "length_km": length_km,
            },
        })
    return features


def find_folder_optional(parent: Path, name: str) -> Path | None:
    return list_by_name(parent).get(name)


def parse_gpx_waypoints(gpx_path: Path, filename: str) -> list[dict[str, object]]:
    """Parse waypoints from a GPX file — returns {name, ele, lat, lng} per waypoint."""
    with gpx_path.open(encoding="utf-8", errors="replace") as f:
        try:
            parsed = gpxpy.parse(f)  # type: ignore[no-untyped-call]
        except Exception as e:
            print(f"  skip {filename}: {e}", file=sys.stderr)
            return []
    return [
        {
            "name": wpt.name or "",  # type: ignore[union-attr]
            "ele": float(wpt.elevation) if wpt.elevation is not None else 0.0,  # type: ignore[union-attr,arg-type]
            "lat": wpt.latitude,  # type: ignore[union-attr]
            "lng": wpt.longitude,  # type: ignore[union-attr]
        }
        for wpt in parsed.waypoints  # type: ignore[union-attr]
        if wpt.latitude is not None and wpt.longitude is not None  # type: ignore[union-attr]
    ]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def auto_detect_bagged(
    tracks_by_file_id: dict[str, list[list[float]]],
    all_peaks: dict[str, list[dict[str, Any]]],
    existing_keys: set[str],
    reverted_keys: set[str],
    threshold_m: float,
) -> list[dict[str, Any]]:
    """Return new BaggedEntry dicts for peaks within threshold_m of any track point."""
    lat_buf = threshold_m / 111_000
    lng_buf = threshold_m / (111_000 * math.cos(math.radians(57.0)))

    track_bboxes: dict[str, tuple[float, float, float, float]] = {}
    for fid, coords in tracks_by_file_id.items():
        if coords:
            lngs = [c[0] for c in coords]
            lats = [c[1] for c in coords]
            track_bboxes[fid] = (min(lats), max(lats), min(lngs), max(lngs))

    now = datetime.now(timezone.utc).isoformat()
    new_entries: list[dict[str, Any]] = []

    for category, waypoints in all_peaks.items():
        for wpt in waypoints:
            key = f"{category}:{wpt['name']}"
            if key in existing_keys or key in reverted_keys:
                continue
            wlat = float(wpt["lat"])
            wlng = float(wpt["lng"])
            matched_fid: str | None = None
            for fid, coords in tracks_by_file_id.items():
                bbox = track_bboxes.get(fid)
                if not bbox:
                    continue
                blat_min, blat_max, blng_min, blng_max = bbox
                if wlat < blat_min - lat_buf or wlat > blat_max + lat_buf:
                    continue
                if wlng < blng_min - lng_buf or wlng > blng_max + lng_buf:
                    continue
                if any(haversine_m(wlat, wlng, c[1], c[0]) <= threshold_m for c in coords):
                    matched_fid = fid
                    break
            if matched_fid is not None:
                new_entries.append({
                    "category": category,
                    "name": wpt["name"],
                    "lat": wlat,
                    "lng": wlng,
                    "ele": float(wpt["ele"]),
                    "baggedOn": now,
                    "trackFileId": matched_fid,
                })
                existing_keys.add(key)

    return new_entries


PENDING_FILENAME = "bagged-pending.json"


def build_peaks(
    peaks_folder: Path,
    elapsed: Callable[[], str],
    tracks_by_file_id: dict[str, list[list[float]]],
    bag_distance_m: float,
) -> None:
    """Build peaks.pmtiles from .gpx waypoint files in the peaks folder.

    Reads bagged-pending.json, commits entries/reverts to PMTiles, then deletes the file.
    """
    peaks_names = list_by_name(peaks_folder)
    peak_files = {name: path for name, path in peaks_names.items() if name.lower().endswith(".gpx")}
    if not peak_files:
        print("No .gpx files in peaks/ — skipping peaks PMTiles")
        return

    # Use existing GVFS path if the pending file exists so we overwrite in place
    bagged_path: Path = peaks_names.get(PENDING_FILENAME, peaks_folder / PENDING_FILENAME)
    bagged_entries: list[dict[str, Any]] = []
    reverted_entries: list[dict[str, Any]] = []
    if PENDING_FILENAME in peaks_names:
        try:
            data = json.loads(bagged_path.read_text())
            if isinstance(data.get("entries"), list):
                bagged_entries = data["entries"]
                print(f"  Loaded {len(bagged_entries)} pending bagged entries")
            if isinstance(data.get("reverted"), list):
                reverted_entries = data["reverted"]
                if reverted_entries:
                    print(f"  {len(reverted_entries)} pending revert(s)")
        except Exception as e:
            print(f"Warning: could not read {PENDING_FILENAME}: {e}", file=sys.stderr)

    bagged_keys: set[str] = {f"{e['category']}:{e['name']}" for e in bagged_entries}
    reverted_keys: set[str] = {f"{e['category']}:{e['name']}" for e in reverted_entries}

    # Peaks in reverted are set done:false — remove from bagged_keys in case they overlap
    bagged_keys -= reverted_keys

    print(f"\nBuilding peaks.pmtiles from {len(peak_files)} file(s) ...")
    t_phase = time.monotonic()

    # Parse all waypoints first (needed for auto-detection)
    all_peaks: dict[str, list[dict[str, Any]]] = {}
    for filename, gvfs_path in sorted(peak_files.items()):
        category = filename[:-4].lower()
        all_peaks[category] = parse_gpx_waypoints(gvfs_path, filename)

    # Auto-detect newly bagged peaks from tracks (skip already bagged or reverted)
    if tracks_by_file_id:
        new_detections = auto_detect_bagged(tracks_by_file_id, all_peaks, bagged_keys, reverted_keys, bag_distance_m)
        if new_detections:
            print(f"  Auto-detected {len(new_detections)} newly bagged peak(s):")
            for e in new_detections:
                print(f"    {e['category']}/{e['name']}")
            bagged_entries.extend(new_detections)
            for e in new_detections:
                bagged_keys.add(f"{e['category']}:{e['name']}")
            bagged_path.write_text(json.dumps({"version": 1, "entries": bagged_entries, "reverted": reverted_entries}, indent=2))
            print(f"  Updated {PENDING_FILENAME} written to Drive")

    # Lookup for bagged metadata to embed in PMTiles features
    bagged_info: dict[str, dict[str, Any]] = {f"{e['category']}:{e['name']}": e for e in bagged_entries}

    with tempfile.TemporaryDirectory(prefix="doneit-peaks-") as tmpdir:
        tmp = Path(tmpdir)
        geojsonseq = tmp / "peaks.geojsonseq"
        index_categories: list[dict[str, object]] = []
        total = 0

        with geojsonseq.open("w") as out:
            for category, waypoints in sorted(all_peaks.items()):
                for wpt in waypoints:
                    key = f"{category}:{wpt['name']}"
                    info = bagged_info.get(key)
                    out.write(json.dumps({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [wpt["lng"], wpt["lat"]]},
                        "properties": {
                            "name": wpt["name"],
                            "ele": wpt["ele"],
                            "category": category,
                            "done": key in bagged_keys,
                            "baggedOn": info["baggedOn"] if info else None,
                            "trackFileId": info["trackFileId"] if info else None,
                        },
                    }) + "\n")
                    total += 1
                index_categories.append({"name": category, "count": len(waypoints)})
                print(f"  {category}: {len(waypoints)} waypoints")

        if total == 0:
            print("No waypoints found — skipping peaks PMTiles")
            return

        pmtiles_out = tmp / "peaks.pmtiles"
        subprocess.run(
            [
                "tippecanoe",
                "-o", str(pmtiles_out),
                "-l", "peaks",
                "-Z0", "-z14",
                "-r1",                   # keep all points at all zoom levels (no density dropping)
                "--no-feature-limit",
                "--no-tile-size-limit",
                "--force",
                str(geojsonseq),
            ],
            check=True,
        )
        size_mb = pmtiles_out.stat().st_size / 1_048_576
        print(f"  Peaks tippecanoe: {size_mb:.1f} MB [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        dest = peaks_folder / "peaks.pmtiles"
        shutil.copyfile(str(pmtiles_out), str(dest))

        index_data: dict[str, object] = {
            "version": 1,
            "generated": datetime.now(timezone.utc).isoformat(),
            "categories": index_categories,
            "committedBagged": list(bagged_keys),
        }
        (peaks_folder / "peaks-index.json").write_text(json.dumps(index_data, indent=2))

        # Pending file fully committed — delete so the next build starts clean
        if bagged_path.exists():
            bagged_path.unlink()
            print(f"  Deleted {PENDING_FILENAME} (committed to PMTiles)")

        print(f"Peaks done: {total} waypoints {elapsed()}")


def bbox_from_features(features: list[dict[str, object]]) -> dict[str, float] | None:
    lngs: list[float] = [c[0] for f in features for c in f["geometry"]["coordinates"]]  # type: ignore[index]
    lats: list[float] = [c[1] for f in features for c in f["geometry"]["coordinates"]]  # type: ignore[index]
    if not lngs:
        return None
    return {"west": min(lngs), "east": max(lngs), "south": min(lats), "north": max(lats)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--folder",
        default="DoneIt",
        help="Drive subfolder matching VITE_DRIVE_FOLDER (default: DoneIt)",
    )
    parser.add_argument(
        "--country",
        action="store_true",
        default=False,
        help="Look up country for each track (slow, unreliable for coastal tracks)",
    )
    parser.add_argument(
        "--bag-distance",
        type=float,
        default=500.0,
        metavar="METRES",
        help="Proximity threshold for auto-detecting bagged peaks (default: 500 m)",
    )
    args = parser.parse_args()

    t0 = time.monotonic()

    def elapsed() -> str:
        return f"[{time.monotonic() - t0:.1f}s]"

    check_tool("tippecanoe")

    # Fetch and load country boundaries only when requested
    gdf, sindex = None, None
    if args.country:
        t_phase = time.monotonic()
        fetch_countries()
        print(f"Country data fetched [{time.monotonic() - t_phase:.1f}s] {elapsed()}")
        print("Loading country index ...")
        t_phase = time.monotonic()
        gdf, sindex = load_country_index()
        print(f"Country index loaded [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

    # Navigate to the tracks folder via GVFS
    print("Locating Google Drive via GVFS ...")
    drive_root = find_gdrive_root()
    doneit_folder = find_folder(drive_root, args.folder)
    tracks_folder = find_folder(doneit_folder, "tracks")
    print(f"Found tracks folder: {get_drive_id(tracks_folder)} {elapsed()}")

    # List tracks folder: existing index + cache + category subfolders
    print("Listing tracks folder ...")
    t_phase = time.monotonic()
    track_names = list_by_name(tracks_folder)
    print(f"  {len(track_names)} items [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

    # Load filename→fileId mapping from existing index
    filename_to_file_id: dict[str, str] = {}
    if "tracks-index.json" in track_names:
        try:
            existing = json.loads(track_names["tracks-index.json"].read_text())
            filename_to_file_id = {e["filename"]: e["fileId"] for e in existing.get("tracks", [])}
            print(f"  {len(filename_to_file_id)} existing fileId mappings from index")
        except Exception as e:
            print(f"Warning: could not read tracks-index.json: {e}", file=sys.stderr)

    # Load GPX cache (metadata + coordinates, keyed by category/filename)
    cache_entries = load_gpx_cache(track_names)

    # Discover category subfolders
    category_folders: dict[str, Path] = {
        name: path for name, path in track_names.items() if path.is_dir()
    }
    if not category_folders:
        sys.exit("No category subfolders found in tracks/ — expected e.g. hiking/, coastal/")

    # Phase 1: collect all GPX file paths
    print("Phase 1: listing category folders ...")
    t_phase = time.monotonic()
    all_gpx: list[tuple[str, str, Path]] = []
    for category, cat_gvfs in sorted(category_folders.items()):
        gpx_files = {
            name: path
            for name, path in list_by_name(cat_gvfs).items()
            if name.lower().endswith(".gpx")
        }
        print(f"  {category}: {len(gpx_files)} tracks")
        for filename, gvfs_path in sorted(gpx_files.items()):
            all_gpx.append((category, filename, gvfs_path))
    print(f"Phase 1 done: {len(all_gpx)} GPX files found [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

    if not all_gpx:
        sys.exit("No GPX files found.")

    # Identify which files are not yet cached
    uncached_gpx = [(cat, fn, path) for cat, fn, path in all_gpx if f"{cat}/{fn}" not in cache_entries]

    if uncached_gpx:
        # Phase 2: batch metadata extraction for uncached files only
        print(f"Phase 2: extracting metadata for {len(uncached_gpx)} uncached track(s) via Node.js ...")
        t_phase = time.monotonic()
        new_metas = extract_gpx_metadata_batch([path for _, _, path in uncached_gpx])
        print(f"Phase 2 done [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        # Phase 3: parse GPX coordinates for uncached files
        print(f"Phase 3: parsing GPX coordinates for {len(uncached_gpx)} uncached track(s) ...")
        t_phase = time.monotonic()
        for (cat, fn, path), meta in zip(uncached_gpx, new_metas):
            tracks_coords = parse_gpx_coords(path, fn)
            cache_entries[f"{cat}/{fn}"] = {"meta": meta, "tracks": tracks_coords}
        print(f"Phase 3 done [{time.monotonic() - t_phase:.1f}s] {elapsed()}")
    else:
        print(f"All {len(all_gpx)} tracks found in cache — skipping metadata extraction and GPX parsing {elapsed()}")

    with tempfile.TemporaryDirectory(prefix="doneit-pmtiles-") as tmpdir:
        tmp = Path(tmpdir)

        # Phase 4: build GeoJSONSeq from cache
        print("Phase 4: building GeoJSONSeq ...")
        t_phase = time.monotonic()
        geojsonseq = tmp / "tracks.geojsonseq"
        total = 0
        index_entries: list[dict[str, object]] = []
        unnamed_tracks: list[str] = []
        unknown_country_tracks: list[str] = []

        with geojsonseq.open("w") as out:
            for category, filename, gvfs_path in all_gpx:
                file_id = filename_to_file_id.get(filename, get_drive_id(gvfs_path))
                features = build_features_from_cache(
                    cache_entries[f"{category}/{filename}"], category, file_id, filename, unnamed_tracks
                )
                for feature in features:
                    out.write(json.dumps(feature) + "\n")
                    total += 1
                if features:
                    bbox = bbox_from_features(features)
                    country: str | None = None
                    if gdf is not None:
                        all_coords: list[list[float]] = [
                            c for f in features for c in f["geometry"]["coordinates"]  # type: ignore[misc]
                        ]
                        if all_coords:
                            country = find_country(gdf, sindex, all_coords)
                    if gdf is not None and country is None:
                        unknown_country_tracks.append(f"  {category}/{filename}")
                    props: dict[str, object] = features[0]["properties"]  # type: ignore[assignment]
                    index_entries.append({
                        "fileId": file_id,
                        "filename": filename,
                        "category": category,
                        "displayName": props["display_name"],
                        "date": props["date"],
                        "trackType": props["track_type"],
                        "country": country,
                        "bbox": bbox,
                    })

        if total == 0:
            sys.exit("No tracks found.")

        print(f"Phase 4 done: {total} track(s) [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        if unnamed_tracks:
            print(f"\n⚠  {len(unnamed_tracks)} track(s) have no name in their GPX metadata:", file=sys.stderr)
            for line in unnamed_tracks:
                print(line, file=sys.stderr)
            print("   Add a <name> element inside <trk> in each GPX file to set a proper display name.\n", file=sys.stderr)

        if unknown_country_tracks:
            print(f"\n⚠  {len(unknown_country_tracks)} track(s) have an unknown country:", file=sys.stderr)
            for line in unknown_country_tracks:
                print(line, file=sys.stderr)
            print("   No sampled point on these tracks fell within any country polygon.\n", file=sys.stderr)

        # Run tippecanoe
        pmtiles_out = tmp / "tracks.pmtiles"
        print("Running tippecanoe ...")
        t_phase = time.monotonic()
        subprocess.run(
            [
                "tippecanoe",
                "-o", str(pmtiles_out),
                "-l", "tracks",
                "-Z0",
                "-z14",
                "--no-feature-limit",
                "--no-tile-size-limit",
                "--simplification=4",
                "--coalesce-densest-as-needed",
                "--force",
                str(geojsonseq),
            ],
            check=True,
        )
        size_mb = pmtiles_out.stat().st_size / 1_048_576
        print(f"Tippecanoe done: {size_mb:.1f} MB [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        # Write to GVFS tracks folder
        dest = tracks_folder / "tracks.pmtiles"
        print("Writing tracks.pmtiles to Google Drive ...")
        t_phase = time.monotonic()
        shutil.copyfile(str(pmtiles_out), str(dest))
        print(f"Upload done [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        # Write tracks-index.json to Google Drive
        index_data: dict[str, object] = {
            "version": 1,
            "generated": datetime.now(timezone.utc).isoformat(),
            "tracks": index_entries,
        }
        index_dest = tracks_folder / "tracks-index.json"
        print(f"Writing tracks-index.json ({len(index_entries)} tracks) to Google Drive ...")
        t_phase = time.monotonic()
        index_dest.write_text(json.dumps(index_data, indent=2, default=str))
        print(f"Index written [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        # Build tracks_by_file_id for peak auto-detection
        tracks_by_file_id: dict[str, list[list[float]]] = {}
        for category, filename, gvfs_path in all_gpx:
            file_id = filename_to_file_id.get(filename, get_drive_id(gvfs_path))
            entry = cache_entries.get(f"{category}/{filename}")
            if entry:
                coords = [c for seg in entry["tracks"] for c in seg]
                if coords:
                    tracks_by_file_id[file_id] = coords

        # Build peaks PMTiles if peaks/ folder exists
        peaks_folder = find_folder_optional(doneit_folder, "peaks")
        if peaks_folder is not None:
            build_peaks(peaks_folder, elapsed, tracks_by_file_id, args.bag_distance)
        else:
            print("No peaks/ folder — skipping peaks PMTiles")

        if uncached_gpx:
            print(f"Saving GPX cache ({len(cache_entries)} entries) to Google Drive ...")
            t_phase = time.monotonic()
            save_gpx_cache(tracks_folder, cache_entries)
            print(f"Cache saved [{time.monotonic() - t_phase:.1f}s] {elapsed()}")

        print(f"Done. {elapsed()}")


if __name__ == "__main__":
    main()
