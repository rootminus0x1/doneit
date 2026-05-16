"""
doit build pipeline for DoneIt GPX → PMTiles.

Tasks:
  parse_and_bag_tracks — parse new/changed GPX files → gpx-cache.json + peaks-index.json
  build_tracks         — gpx-cache.json → tracks.pmtiles + tracks-index.json
  build_peaks_pmtiles  — peaks/*.gpx + peaks-index.json → peaks.pmtiles

Run:  uv run doit                         (build_tracks + build_peaks_pmtiles)
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
    "dep_file": str(Path(__file__).parent / ".doit.db"),
    "default_tasks": ["build_tracks", "build_peaks_pmtiles"],
}

# ---------------------------------------------------------------------------
# Config from environment (set by build.py before invoking doit)
# ---------------------------------------------------------------------------
_FOLDER = os.environ.get("DONEIT_FOLDER", "DoneIt")
_BAG_DISTANCE = float(os.environ.get("DONEIT_BAG_DISTANCE", "500"))
_BAG_CONFIG_PATH = Path(__file__).parent / ".bag-config.json"

# ---------------------------------------------------------------------------
# Drive path discovery (runs every time doit loads this file)
# ---------------------------------------------------------------------------
print("Locating Drive via GVFS ...", file=sys.stderr)
_drive_root = pipeline.find_gdrive_root()
_doneit = pipeline.find_folder(_drive_root, _FOLDER)
_tracks_folder = pipeline.find_folder(_doneit, "tracks")
_track_names = pipeline.list_by_name(_tracks_folder)

_cache_path: Path = _track_names.get(pipeline.GPX_CACHE_NAME, _tracks_folder / pipeline.GPX_CACHE_NAME)

_peaks_folder: Path | None = pipeline.find_folder_optional(_doneit, "peaks")
_peaks_names: dict[str, Path] = pipeline.list_by_name(_peaks_folder) if _peaks_folder else {}
_peaks_gpx: dict[str, Path] = {n: p for n, p in _peaks_names.items() if n.lower().endswith(".gpx")}
_peaks_index_path: Path | None = (
    _peaks_names.get(pipeline.PEAKS_INDEX_NAME, _peaks_folder / pipeline.PEAKS_INDEX_NAME)
    if _peaks_folder else None
)
_peaks_pmtiles_path: Path | None = (
    _peaks_names.get("peaks.pmtiles", _peaks_folder / "peaks.pmtiles")
    if _peaks_folder else None
)

# Collect all track GPX files from category subfolders
_category_folders: dict[str, Path] = {n: p for n, p in _track_names.items() if p.is_dir()}
_all_gpx: list[tuple[str, str, Path]] = []
for _cat, _cat_path in sorted(_category_folders.items()):
    for _name, _path in pipeline.list_by_name(_cat_path).items():
        if _name.lower().endswith(".gpx"):
            _all_gpx.append((_cat, _name, _path))

# Filename → Drive file ID from existing index (avoids re-deriving IDs)
_filename_to_file_id: dict[str, str] = {}
if "tracks-index.json" in _track_names:
    try:
        _idx = json.loads(_track_names["tracks-index.json"].read_text())
        _filename_to_file_id = {e["filename"]: e["fileId"] for e in _idx.get("tracks", [])}
    except Exception:
        pass

# Target paths for tracks outputs
_tracks_pmtiles_dest: Path = _track_names.get("tracks.pmtiles", _tracks_folder / "tracks.pmtiles")
_tracks_index_dest: Path = _track_names.get("tracks-index.json", _tracks_folder / "tracks-index.json")

_gdf, _sindex = None, None


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

def task_parse_and_bag_tracks() -> dict[str, Any]:
    """Parse new/changed GPX tracks; detect baggings for newly parsed ones."""
    gpx_paths = [str(p) for _, _, p in _all_gpx]
    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()] if _peaks_gpx else []

    def action():
        cache = pipeline.run_parse_and_bag_tracks(
            _all_gpx, _cache_path,
            _peaks_gpx if _peaks_folder else None,
            _peaks_index_path,
            _BAG_DISTANCE,
        )
        pipeline.save_gpx_cache(_cache_path, cache)

    targets = [str(_cache_path)]
    if _peaks_index_path is not None:
        targets.append(str(_peaks_index_path))

    # .bag-config.json records the last-used bag_distance; changes trigger re-bag via doit dep
    bag_config_dep = [str(_BAG_CONFIG_PATH)] if _BAG_CONFIG_PATH.exists() else []

    return {
        "file_dep": gpx_paths + peak_gpx_paths + bag_config_dep,
        "targets": targets,
        "actions": [action],
    }


def task_build_tracks() -> dict[str, Any]:
    """Build tracks.pmtiles and tracks-index.json from gpx-cache.json."""
    def action():
        cache = pipeline.load_gpx_cache(_cache_path)
        pipeline.run_build_tracks(
            cache, _all_gpx, _filename_to_file_id,
            _tracks_pmtiles_dest, _tracks_index_dest,
            _gdf, _sindex,
        )

    return {
        "file_dep": [str(_cache_path)],
        "targets": [str(_tracks_pmtiles_dest), str(_tracks_index_dest)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }


def task_build_peaks_pmtiles() -> dict[str, Any]:
    """Build peaks.pmtiles from peak GPX files and peaks-index.json."""
    if not _peaks_folder or not _peaks_gpx or _peaks_pmtiles_path is None or _peaks_index_path is None:
        return {"actions": [], "uptodate": [True]}

    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()]

    def action():
        pipeline.run_build_peaks_pmtiles(_peaks_gpx, _peaks_pmtiles_path)

    return {
        "file_dep": peak_gpx_paths + [str(_peaks_index_path)],
        "targets": [str(_peaks_pmtiles_path)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }
