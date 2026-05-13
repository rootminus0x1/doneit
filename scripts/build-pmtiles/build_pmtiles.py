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
  uv run build_pmtiles.py [--folder DRIVE_FOLDER]

The script:
  1. Locates the Google Drive GVFS mount (used by the file manager)
  2. Navigates to <folder>/tracks/ by display name
  3. Converts all category/*.gpx files to a GeoJSONSeq with category/file_id properties
  4. Runs tippecanoe to generate tracks.pmtiles (zoom 8–14, single 'tracks' layer)
  5. Writes tracks.pmtiles back to the GVFS mount (same as saving in the file manager)
  6. Prints the Drive file ID — add it to tile-sources.json on first run
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import gpxpy
    import geopandas as gpd
    from shapely.geometry import Point
except ImportError:
    sys.exit("Dependencies missing — run via: uv run build_pmtiles.py")

COUNTRIES_PATH = Path(__file__).parent.parent.parent / "public" / "ne_110m_countries.geojson"

GVFS_BASE = Path(f"/run/user/{os.getuid()}/gvfs")


def check_tool(name: str) -> None:
    if subprocess.run(["which", name], capture_output=True).returncode != 0:
        sys.exit(
            f"Required tool not found: {name}\n"
            "  tippecanoe: sudo apt install tippecanoe\n"
            "              or build from https://github.com/felt/tippecanoe"
        )


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
    current_name: str | None = None

    for line in result.stdout.splitlines():
        if line.startswith("local path:"):
            current_path = Path(line.split(":", 1)[1].strip())
            current_name = None
        elif "standard::display-name:" in line and current_path:
            current_name = line.split("standard::display-name:", 1)[1].strip()
            name_map[current_name] = current_path

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
        print(f"Warning: countries file not found at {COUNTRIES_PATH}", file=sys.stderr)
        return None, None
    gdf: Any = gpd.read_file(COUNTRIES_PATH)  # type: ignore[no-untyped-call]
    return gdf, gdf.sindex


def lookup_country(gdf: Any, sindex: Any, lng: float, lat: float) -> str | None:
    pt = Point(lng, lat)
    for idx in sindex.query(pt):
        row: Any = gdf.iloc[idx]
        if row.geometry.contains(pt):
            # Prefer geonunit (e.g. "Scotland") over admin (e.g. "United Kingdom")
            geonunit: Any = row.get("geonunit")
            admin: Any = row.get("admin")
            return str(geonunit) if (geonunit and geonunit != admin) else (str(admin) if admin else None)
    return None


def bbox_from_features(features: list[dict[str, object]]) -> dict[str, float] | None:
    lngs: list[float] = [c[0] for f in features for c in f["geometry"]["coordinates"]]  # type: ignore[index]
    lats: list[float] = [c[1] for f in features for c in f["geometry"]["coordinates"]]  # type: ignore[index]
    if not lngs:
        return None
    return {"west": min(lngs), "east": max(lngs), "south": min(lats), "north": max(lats)}


def gpx_to_features(gpx_path: Path, category: str, file_id: str | None) -> list[dict[str, object]]:
    with gpx_path.open(encoding="utf-8", errors="replace") as f:
        try:
            parsed = gpxpy.parse(f)
        except Exception as e:
            print(f"  skip {gpx_path.name}: {e}", file=sys.stderr)
            return []

    features: list[dict[str, object]] = []
    for track in parsed.tracks:
        coords = []
        for seg in track.segments:
            coords.extend([[p.longitude, p.latitude] for p in seg.points])
        if not coords:
            continue

        display_name = track.name or parsed.name or gpx_path.stem
        date = None
        if track.segments and track.segments[0].points:
            pt = track.segments[0].points[0]
            if pt.time:
                date = pt.time.date().isoformat()

        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "category": category,
                "filename": gpx_path.name,
                "file_id": file_id,
                "display_name": display_name,
                "date": date,
            },
        })
    return features


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--folder",
        default="DoneIt",
        help="Drive subfolder matching VITE_DRIVE_FOLDER (default: DoneIt)",
    )
    args = parser.parse_args()

    check_tool("tippecanoe")

    # Navigate to the tracks folder via GVFS
    print("Locating Google Drive via GVFS ...")
    drive_root = find_gdrive_root()
    doneit_folder = find_folder(drive_root, args.folder)
    tracks_folder = find_folder(doneit_folder, "tracks")
    print(f"Found tracks folder: {get_drive_id(tracks_folder)}")

    # Load country lookup index
    print("Loading country index ...")
    gdf, sindex = load_country_index()

    # Load existing index for filename→fileId mapping (preserved across rebuilds)
    track_names = list_by_name(tracks_folder)
    filename_to_file_id: dict[str, str] = {}
    if "tracks-index.json" in track_names:
        try:
            existing = json.loads(track_names["tracks-index.json"].read_text())
            filename_to_file_id = {e["filename"]: e["fileId"] for e in existing.get("tracks", [])}
            print(f"Loaded {len(filename_to_file_id)} existing fileId mappings from index")
        except Exception as e:
            print(f"Warning: could not read tracks-index.json: {e}", file=sys.stderr)

    # Discover category subfolders
    category_folders: dict[str, Path] = {}
    for display_name, path in track_names.items():
        if path.is_dir():
            category_folders[display_name] = path

    if not category_folders:
        sys.exit("No category subfolders found in tracks/ — expected e.g. hiking/, coastal/")

    with tempfile.TemporaryDirectory(prefix="doneit-pmtiles-") as tmpdir:
        tmp = Path(tmpdir)

        # Convert GPX → GeoJSONSeq (reading directly from GVFS)
        geojsonseq = tmp / "tracks.geojsonseq"
        total = 0
        index_entries: list[dict[str, object]] = []
        with geojsonseq.open("w") as out:
            for category, cat_gvfs in sorted(category_folders.items()):
                gpx_files = {
                    name: path
                    for name, path in list_by_name(cat_gvfs).items()
                    if name.lower().endswith(".gpx")
                }
                print(f"  {category}: {len(gpx_files)} tracks")
                for filename, gvfs_path in sorted(gpx_files.items()):
                    file_id = filename_to_file_id.get(filename, get_drive_id(gvfs_path))
                    features = gpx_to_features(gvfs_path, category, file_id)
                    for feature in features:
                        out.write(json.dumps(feature) + "\n")
                        total += 1
                    if features:
                        bbox = bbox_from_features(features)
                        country: str | None = None
                        if bbox and gdf is not None:
                            mid_lng = (bbox["west"] + bbox["east"]) / 2
                            mid_lat = (bbox["south"] + bbox["north"]) / 2
                            country = lookup_country(gdf, sindex, mid_lng, mid_lat)
                        props: dict[str, object] = features[0]["properties"]  # type: ignore[assignment]
                        index_entries.append({
                            "fileId": file_id,
                            "filename": filename,
                            "category": category,
                            "displayName": props["display_name"],
                            "date": props["date"],
                            "country": country,
                            "bbox": bbox,
                            "inPmtiles": True,
                        })

        if total == 0:
            sys.exit("No tracks found.")

        print(f"Converted {total} track(s) to GeoJSONSeq")

        # Run tippecanoe
        pmtiles_out = tmp / "tracks.pmtiles"
        print("Running tippecanoe ...")
        subprocess.run(
            [
                "tippecanoe",
                "-o", str(pmtiles_out),
                "-l", "tracks",          # filter by 'category' property in MapLibre
                "-Z0",   # min zoom: 0 = whole world in one tile
                "-z14",  # max zoom: 14 = ~10 m resolution (street level)
                "--no-feature-limit",    # keep all tracks at every zoom
                "--no-tile-size-limit",
                "--simplification=4",
                "--coalesce-densest-as-needed",
                "--force",
                str(geojsonseq),
            ],
            check=True,
        )
        size_mb = pmtiles_out.stat().st_size / 1_048_576
        print(f"Generated tracks.pmtiles ({size_mb:.1f} MB)")

        # Write to GVFS tracks folder (same as copying in the file manager)
        dest = tracks_folder / "tracks.pmtiles"
        print("Writing tracks.pmtiles to Google Drive ...")
        shutil.copyfile(str(pmtiles_out), str(dest))

        # Write tracks-index.json to Google Drive
        index_data: dict[str, object] = {
            "version": 1,
            "generated": datetime.now(timezone.utc).isoformat(),
            "tracks": index_entries,
        }
        index_dest = tracks_folder / "tracks-index.json"
        print(f"Writing tracks-index.json ({len(index_entries)} tracks) to Google Drive ...")
        index_dest.write_text(json.dumps(index_data, indent=2, default=str))

        # Resolve Drive file ID of the uploaded PMTiles file
        updated_names = list_by_name(tracks_folder)
        if "tracks.pmtiles" in updated_names:
            drive_id = get_drive_id(updated_names["tracks.pmtiles"])
            print(f"\nDrive file ID: {drive_id}")
            print("Add to tile-sources.json in your Drive root (first run only):")
            print(
                json.dumps(
                    {
                        "id": "tracks-pmtiles",
                        "label": "My Tracks",
                        "type": "pmtiles-drive",
                        "fileId": drive_id,
                        "styleUrl": "<your base MapLibre style URL>",
                        "attribution": "Personal tracks",
                        "thumbColor": "#4a90d9",
                        "icon": "<svg>...</svg>",
                    },
                    indent=2,
                )
            )
        else:
            print("Upload complete. Find the file ID in Google Drive or the file manager.")


if __name__ == "__main__":
    main()
