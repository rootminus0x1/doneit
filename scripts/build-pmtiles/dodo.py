"""
doit build pipeline for DoneIt GPX → PMTiles.

Tasks:
  fetch_row            — download ROW GeoJSON from rowmaps.com → row.geojson (ETag-aware, always runs)
  build_row_pmtiles    — row.geojson → DoneIt/row.pmtiles via tippecanoe
  parse_and_bag_tracks — parse new/changed GPX tracks → gpx-cache.json + DoneIt/peaks/peaks-index.json
  build_tracks         — gpx-cache.json → DoneIt/tracks/tracks.pmtiles + tracks-index.json
  build_peaks_pmtiles  — peaks/*.gpx + peaks-index.json → DoneIt/peaks/peaks.pmtiles
  deploy               — copy changed files from DoneIt/ to Google Drive via GVFS (MD5-checked)

Run:  uv run doit                         (default: build_row_pmtiles build_tracks build_peaks_pmtiles)
      uv run doit deploy                  (build + deploy to Drive)
      uv run doit fetch_row
      uv run doit build_row_pmtiles
      uv run doit parse_and_bag_tracks
      uv run doit build_tracks
      uv run doit build_peaks_pmtiles
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

import pipeline

DOIT_CONFIG = {
    "verbosity": 2,
    "dep_file": str(pipeline.BUILD_DIR / ".doit.db"),
    "default_tasks": ["build_row_pmtiles", "build_tracks", "build_peaks_pmtiles"],
}

# ---------------------------------------------------------------------------
# Config from environment (set by build.py before invoking doit)
# ---------------------------------------------------------------------------
_FOLDER = os.environ.get("DONEIT_FOLDER", pipeline.DRIVE_FOLDER)
_BAG_DISTANCE = float(os.environ.get("DONEIT_BAG_DISTANCE", "500"))
_BAG_CONFIG_PATH = pipeline.BUILD_DIR / ".bag-config.json"

# ---------------------------------------------------------------------------
# Local output paths (all artifacts land in DoneIt/ before deploy)
# ---------------------------------------------------------------------------
_local = pipeline.DONEIT_LOCAL
_local_tracks_pmtiles = _local / "tracks" / "tracks.pmtiles"
_local_tracks_index   = _local / "tracks" / "tracks-index.json"
_local_peaks_pmtiles  = _local / "peaks"  / "peaks.pmtiles"
_local_peaks_index    = _local / "peaks"  / pipeline.PEAKS_INDEX_NAME
_local_tile_sources   = _local / "tile-sources.json"

# ---------------------------------------------------------------------------
# Drive path discovery (GVFS) — needed for reading input GPX files and deploy
# ---------------------------------------------------------------------------
print("Locating Drive via GVFS ...", file=sys.stderr)
_drive_root = pipeline.find_gdrive_root()
_doneit = pipeline.find_folder(_drive_root, _FOLDER)
_doneit_names = pipeline.list_by_name(_doneit)
_tracks_folder = pipeline.find_folder(_doneit, "tracks")
_track_names = pipeline.list_by_name(_tracks_folder)

_cache_path: Path = pipeline.GPX_CACHE_PATH

_peaks_folder: Path | None = pipeline.find_folder_optional(_doneit, "peaks")
_peaks_names: dict[str, Path] = pipeline.list_by_name(_peaks_folder) if _peaks_folder else {}
_peaks_gpx: dict[str, Path] = {n: p for n, p in _peaks_names.items() if n.lower().endswith(".gpx")}

# Collect all track GPX files from category subfolders (read from Drive via GVFS)
_category_folders: dict[str, Path] = {n: p for n, p in _track_names.items() if p.is_dir()}
_all_gpx: list[tuple[str, str, Path]] = []
for _cat, _cat_path in sorted(_category_folders.items()):
    for _name, _path in pipeline.list_by_name(_cat_path).items():
        if _name.lower().endswith(".gpx"):
            _all_gpx.append((_cat, _name, _path))

# Filename → Drive file ID — read from local index first, fall back to GVFS copy
_filename_to_file_id: dict[str, str] = {}
_idx_source = _local_tracks_index if _local_tracks_index.exists() else _track_names.get("tracks-index.json")
if _idx_source:
    try:
        _idx = json.loads(Path(_idx_source).read_text())
        _filename_to_file_id = {e["filename"]: e["fileId"] for e in _idx.get("tracks", [])}
    except Exception:
        pass

_gdf, _sindex = None, None


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

def task_fetch_row() -> dict[str, Any]:
    """Download Rights of Way GeoJSON from rowmaps.com (ETag-aware, always runs)."""
    def action():
        pipeline.fetch_row_geojson(pipeline.ROW_GEOJSON_PATH)

    return {
        "actions": [action],
        "targets": [str(pipeline.ROW_GEOJSON_PATH)],
        "uptodate": [False],
    }


def task_build_row_pmtiles() -> dict[str, Any]:
    """Build DoneIt/row.pmtiles from row.geojson."""
    def action():
        pipeline.run_build_row_pmtiles(pipeline.ROW_GEOJSON_PATH, pipeline.ROW_PMTILES_PATH)

    return {
        "file_dep": [str(pipeline.ROW_GEOJSON_PATH)],
        "targets": [str(pipeline.ROW_PMTILES_PATH)],
        "actions": [action],
        "task_dep": ["fetch_row"],
    }


def task_parse_and_bag_tracks() -> dict[str, Any]:
    """Parse new/changed GPX tracks; detect baggings for newly parsed ones."""
    gpx_paths = [str(p) for _, _, p in _all_gpx]
    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()] if _peaks_gpx else []

    def action():
        cache = pipeline.run_parse_and_bag_tracks(
            _all_gpx, _cache_path,
            _peaks_gpx if _peaks_folder else None,
            _local_peaks_index if _peaks_folder else None,
            _BAG_DISTANCE,
        )
        pipeline.save_gpx_cache(_cache_path, cache)

    targets = [str(_cache_path)]
    if _peaks_folder:
        targets.append(str(_local_peaks_index))

    bag_config_dep = [str(_BAG_CONFIG_PATH)] if _BAG_CONFIG_PATH.exists() else []

    return {
        "file_dep": gpx_paths + peak_gpx_paths + bag_config_dep,
        "targets": targets,
        "actions": [action],
    }


def task_build_tracks() -> dict[str, Any]:
    """Build DoneIt/tracks/tracks.pmtiles and tracks-index.json."""
    def action():
        cache = pipeline.load_gpx_cache(_cache_path)
        pipeline.run_build_tracks(
            cache, _all_gpx, _filename_to_file_id,
            _local_tracks_pmtiles, _local_tracks_index,
            _gdf, _sindex,
        )

    return {
        "file_dep": [str(_cache_path)],
        "targets": [str(_local_tracks_pmtiles), str(_local_tracks_index)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }


def task_build_peaks_pmtiles() -> dict[str, Any]:
    """Build DoneIt/peaks/peaks.pmtiles from peak GPX files and peaks-index.json."""
    if not _peaks_folder or not _peaks_gpx:
        return {"actions": [], "uptodate": [True]}

    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()]

    def action():
        pipeline.run_build_peaks_pmtiles(_peaks_gpx, _local_peaks_pmtiles)

    return {
        "file_dep": peak_gpx_paths + [str(_local_peaks_index)],
        "targets": [str(_local_peaks_pmtiles)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }


def task_deploy() -> dict[str, Any]:
    """Copy changed files from DoneIt/ to Google Drive via GVFS (MD5-checked)."""
    pairs: list[tuple[Path, Path]] = [
        (_local_tile_sources, _doneit_names.get("tile-sources.json", _doneit / "tile-sources.json")),
        (pipeline.ROW_PMTILES_PATH,  _doneit_names.get("row.pmtiles",  _doneit / "row.pmtiles")),
        (_local_tracks_pmtiles, _track_names.get("tracks.pmtiles", _tracks_folder / "tracks.pmtiles")),
        (_local_tracks_index,   _track_names.get("tracks-index.json", _tracks_folder / "tracks-index.json")),
    ]
    if _peaks_folder:
        pairs += [
            (_local_peaks_pmtiles, _peaks_names.get("peaks.pmtiles", _peaks_folder / "peaks.pmtiles")),
            (_local_peaks_index,   _peaks_names.get(pipeline.PEAKS_INDEX_NAME, _peaks_folder / pipeline.PEAKS_INDEX_NAME)),
        ]

    _stamp = pipeline.BUILD_DIR / ".deploy.stamp"
    local_files = [str(p) for p, _ in pairs if p.exists()]

    def action():
        pipeline.deploy_to_drive(pairs)
        _stamp.touch()

    return {
        "file_dep": local_files,
        "targets": [str(_stamp)],
        "actions": [action],
        "task_dep": ["build_row_pmtiles", "build_tracks", "build_peaks_pmtiles"],
    }
