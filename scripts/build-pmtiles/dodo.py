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

import hashlib
import json
import marshal
import os
import sys
from pathlib import Path
from typing import Any

import pipeline
from doit.reporter import ConsoleReporter
from doit.tools import config_changed


def _fn_hash(*fns) -> str:
    """Hash the bytecode of one or more functions. Changes when logic changes; immune to comments."""
    return hashlib.sha1(b"".join(marshal.dumps(f.__code__) for f in fns)).hexdigest()


class _PhaseReporter(ConsoleReporter):
    """Replace doit's '· task_name' lines with phase() timing from within each action."""

    def execute_task(self, task: Any) -> None:
        pass  # phase() inside the action prints start/end with timing

    def skip_uptodate(self, task: Any) -> None:
        pipeline.log(f"— {task.name}: up to date")

pipeline.ensure_build_dirs()

DOIT_CONFIG = {
    "verbosity": 2,
    "reporter": _PhaseReporter,
    "dep_file": str(pipeline.BUILD_DIR / ".doit.db"),
    "default_tasks": ["build_row_pmtiles", "build_tracks", "build_peaks_pmtiles", "build_overlays"],
}

# ---------------------------------------------------------------------------
# Config from environment (set by build.py before invoking doit)
# ---------------------------------------------------------------------------
_FOLDER = os.environ.get("DONEIT_FOLDER", pipeline.DRIVE_FOLDER)

# ---------------------------------------------------------------------------
# Local output paths — defined in pipeline.py alongside the source paths
# ---------------------------------------------------------------------------
_local_tracks_pmtiles   = pipeline.TRACKS_PMTILES_PATH
_local_tracks_index     = pipeline.TRACKS_INDEX_PATH
_local_overlays_pmtiles = pipeline.OVERLAYS_PMTILES_PATH
_local_overlays_index   = pipeline.OVERLAYS_INDEX_PATH
_local_peaks_pmtiles    = pipeline.PEAKS_PMTILES_PATH
_local_peaks_index      = pipeline.PEAKS_INDEX_PATH
_local_tile_sources     = pipeline.TILE_SOURCES_PATH

# ---------------------------------------------------------------------------
# Drive path discovery (GVFS) — needed for reading input GPX files and deploy
# ---------------------------------------------------------------------------
with pipeline.phase("Locating Drive via GVFS"):
    _drive_root = pipeline.find_gdrive_root()
    _doneit = pipeline.find_folder(_drive_root, _FOLDER)
    _tracks_folder = pipeline.find_folder(_doneit, "tracks")
    _track_names = pipeline.list_by_name(_tracks_folder)

    _config_folder: Path | None = pipeline.find_folder_optional(_doneit, "config")
    _config_names: dict[str, Path] = pipeline.list_by_name(_config_folder) if _config_folder else {}
    _generated_folder: Path | None = pipeline.find_folder_optional(_doneit, "generated")
    _generated_names: dict[str, Path] = pipeline.list_by_name(_generated_folder) if _generated_folder else {}

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

    # Collect all overlay files from DoneIt/overlays/{category}/ subfolders (optional folder)
    _overlays_folder: Path | None = pipeline.find_folder_optional(_doneit, "overlays")
    _all_overlays: list[tuple[str, str, Path]] = []
    _OVERLAY_EXTENSIONS = frozenset({".gpx", ".kml", ".geojson", ".json"})

    if _overlays_folder:
        _overlays_names: dict[str, Path] = pipeline.list_by_name(_overlays_folder)
        _overlay_category_folders: dict[str, Path] = {n: p for n, p in _overlays_names.items() if p.is_dir()}
        for _cat, _cat_path in sorted(_overlay_category_folders.items()):
            for _name, _path in pipeline.list_by_name(_cat_path).items():
                if Path(_name).suffix.lower() in _OVERLAY_EXTENSIONS:
                    _all_overlays.append((_cat, _name, _path))
        # Overlay files directly in overlays/ (no subcategory) → category "default"
        for _name, _path in _overlays_names.items():
            if Path(_name).suffix.lower() in _OVERLAY_EXTENSIONS:
                _all_overlays.append(("default", _name, _path))
    _overlays_cache_path: Path = pipeline.OVERLAYS_CACHE_PATH

    pipeline.log(f"{len(_all_gpx)} GPX tracks, {len(_peaks_gpx)} peak file(s), {len(_all_overlays)} overlay(s)")

# Filename → Drive file ID — read from local index first, fall back to GVFS copy.
# Errors are non-fatal: run_build_tracks falls back to get_drive_id(gvfs_path).
_filename_to_file_id: dict[str, str] = {}
_idx_source = _local_tracks_index if _local_tracks_index.exists() else _generated_names.get("tracks-index.json")
if _idx_source:
    try:
        _idx = json.loads(Path(_idx_source).read_text())
        _filename_to_file_id = {e["filename"]: e["fileId"] for e in _idx.get("tracks", [])}
    except Exception as _e:
        pipeline.log(f"Warning: could not read tracks-index.json for file ID lookup: {_e}")

_overlay_filename_to_file_id: dict[str, str] = {}
_oidx_source = _local_overlays_index if _local_overlays_index.exists() else _generated_names.get("overlays-index.json")
if _oidx_source:
    try:
        _oidx = json.loads(Path(_oidx_source).read_text())
        _overlay_filename_to_file_id = {e["filename"]: e["fileId"] for e in _oidx.get("overlays", [])}
    except Exception as _e:
        pipeline.log(f"Warning: could not read overlays-index.json for file ID lookup: {_e}")

_gdf, _sindex = None, None


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

def task_fetch_row() -> dict[str, Any]:
    """Download Rights of Way GeoJSON from rowmaps.com (ETag-aware, always runs)."""
    def action():
        with pipeline.phase("fetch_row"):
            pipeline.fetch_row_geojson(pipeline.ROW_GEOJSON_PATH)

    return {
        "actions": [action],
        "targets": [str(pipeline.ROW_GEOJSON_PATH)],
        "uptodate": [False],
    }


def task_build_row_pmtiles() -> dict[str, Any]:
    """Build DoneIt/row.pmtiles from row.geojson."""
    def action():
        with pipeline.phase("build_row_pmtiles"):
            pipeline.run_build_row_pmtiles(pipeline.ROW_GEOJSON_PATH, pipeline.ROW_PMTILES_PATH)

    return {
        "file_dep": [str(pipeline.ROW_GEOJSON_PATH)],
        "uptodate": [config_changed({"build_fn": _fn_hash(pipeline.run_build_row_pmtiles)})],
        "targets": [str(pipeline.ROW_PMTILES_PATH)],
        "actions": [action],
        "task_dep": ["fetch_row"],
    }


def task_parse_and_bag_tracks() -> dict[str, Any]:
    """Parse new/changed GPX tracks; detect baggings for newly parsed ones."""
    gpx_paths = [str(p) for _, _, p in _all_gpx]
    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()] if _peaks_gpx else []

    def action():
        with pipeline.phase("parse_and_bag_tracks"):
            cache = pipeline.run_parse_and_bag_tracks(
                _all_gpx, _cache_path,
                _peaks_gpx if _peaks_folder else None,
                _local_peaks_index if _peaks_folder else None,
                pipeline.BAG_DISTANCE_M,
            )
            pipeline.save_gpx_cache(_cache_path, cache)

    targets = [str(_cache_path)]
    if _peaks_folder:
        targets.append(str(_local_peaks_index))

    return {
        "file_dep": gpx_paths + peak_gpx_paths,
        "uptodate": [config_changed({
            "parse_fn": _fn_hash(pipeline.parse_gpx_coords),
            "required_keys": sorted(pipeline._REQUIRED_CACHE_ENTRY_KEYS),
            "bag_distance": pipeline.BAG_DISTANCE_M,
        })],
        "targets": targets,
        "actions": [action],
    }


def task_build_tracks() -> dict[str, Any]:
    """Build DoneIt/tracks/tracks.pmtiles and tracks-index.json."""
    def action():
        with pipeline.phase("build_tracks"):
            cache = pipeline.load_gpx_cache(_cache_path)
            pipeline.run_build_tracks(
                cache, _all_gpx, _filename_to_file_id,
                _local_tracks_pmtiles, _local_tracks_index,
                _gdf, _sindex,
            )

    return {
        "file_dep": [str(_cache_path)],
        "uptodate": [config_changed({"build_fn": _fn_hash(
            pipeline.build_track_features,
            pipeline._smooth_elevation_by_distance,
        )})],
        "targets": [str(_local_tracks_pmtiles), str(_local_tracks_index)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }


def task_parse_overlays() -> dict[str, Any]:
    """Parse new/changed overlay files into overlays-cache.json."""
    if not _overlays_folder:
        return {"actions": [], "uptodate": [True]}

    overlay_paths = [str(p) for _, _, p in _all_overlays]

    def action():
        with pipeline.phase("parse_overlays"):
            cache = pipeline.run_parse_overlays(_all_overlays, _overlays_cache_path)
            pipeline.save_gpx_cache(_overlays_cache_path, cache)

    return {
        "file_dep": overlay_paths,
        "uptodate": [config_changed({
            "parse_fn": _fn_hash(
                pipeline.parse_gpx_coords,
                pipeline.parse_kml_coords,
                pipeline.parse_geojson_coords,
            ),
            "required_keys": sorted(pipeline._REQUIRED_CACHE_ENTRY_KEYS),
        })],
        "targets": [str(_overlays_cache_path)],
        "actions": [action],
    }


def task_build_overlays() -> dict[str, Any]:
    """Build DoneIt/generated/overlays.pmtiles and overlays-index.json."""
    if not _overlays_folder:
        return {"actions": [], "uptodate": [True]}

    def action():
        with pipeline.phase("build_overlays"):
            cache = pipeline.load_gpx_cache(_overlays_cache_path)
            pipeline.run_build_overlays(
                cache, _all_overlays, _overlay_filename_to_file_id,
                _local_overlays_pmtiles, _local_overlays_index,
            )

    return {
        "file_dep": [str(_overlays_cache_path)],
        "uptodate": [config_changed({"build_fn": _fn_hash(
            pipeline.build_overlay_features,
            pipeline._smooth_elevation_by_distance,
            pipeline.run_build_overlays,
        )})],
        "targets": [str(_local_overlays_pmtiles), str(_local_overlays_index)],
        "actions": [action],
        "task_dep": ["parse_overlays"],
    }


def task_build_peaks_pmtiles() -> dict[str, Any]:
    """Build DoneIt/peaks/peaks.pmtiles from peak GPX files and peaks-index.json."""
    if not _peaks_folder or not _peaks_gpx:
        return {"actions": [], "uptodate": [True]}

    peak_gpx_paths = [str(p) for p in _peaks_gpx.values()]

    def action():
        with pipeline.phase("build_peaks_pmtiles"):
            pipeline.run_build_peaks_pmtiles(_peaks_gpx, _local_peaks_pmtiles)

    return {
        "file_dep": peak_gpx_paths + [str(_local_peaks_index)],
        "uptodate": [config_changed({"build_fn": _fn_hash(pipeline.run_build_peaks_pmtiles)})],
        "targets": [str(_local_peaks_pmtiles)],
        "actions": [action],
        "task_dep": ["parse_and_bag_tracks"],
    }


def task_deploy() -> dict[str, Any]:
    """Copy changed files from DoneIt/ to Google Drive via GVFS (MD5-checked)."""
    def _cfg(name: str) -> Path:
        return _config_names.get(name, _config_folder / name) if _config_folder else _doneit / "config" / name

    def _gen(name: str) -> Path:
        return _generated_names.get(name, _generated_folder / name) if _generated_folder else _doneit / "generated" / name

    pairs: list[tuple[Path, Path]] = [
        (_local_tile_sources,       _cfg("tile-sources.json")),
        (pipeline.ROW_PMTILES_PATH, _gen("row.pmtiles")),
        (_local_tracks_pmtiles,     _gen("tracks.pmtiles")),
        (_local_tracks_index,       _gen("tracks-index.json")),
    ]
    if _overlays_folder:
        pairs += [
            (_local_overlays_pmtiles, _gen("overlays.pmtiles")),
            (_local_overlays_index,   _gen("overlays-index.json")),
        ]
    if _peaks_folder:
        pairs += [
            (_local_peaks_pmtiles, _gen("peaks.pmtiles")),
            (_local_peaks_index,   _gen(pipeline.PEAKS_INDEX_NAME)),
        ]

    _stamp = pipeline.BUILD_DIR / ".deploy.stamp"

    def _is_current():
        if not _stamp.exists():
            return False
        stamp_mtime = _stamp.stat().st_mtime
        return all(
            not src.exists() or src.stat().st_mtime <= stamp_mtime
            for src, _ in pairs
        )

    def action():
        with pipeline.phase("deploy"):
            pipeline.deploy_to_drive(pairs)
        _stamp.touch()

    return {
        "uptodate": [_is_current],
        "targets": [str(_stamp)],
        "actions": [action],
        "task_dep": ["build_row_pmtiles", "build_tracks", "build_peaks_pmtiles", "build_overlays"],
    }
