"""CLI entry point for the DoneIt build pipeline.

Usage:
  uv run python build.py [OPTIONS] [TASK ...]

Options:
  --force           Delete gpx-cache.json and .doit.db to force a full rebuild.
  --retrack PATTERN Remove GPX cache entries matching PATTERN (glob, e.g. 'hills/*')
                    and delete .doit.db so those tracks are re-parsed and re-bagged.
  --folder NAME     Drive folder name (default: DoneIt).
  --bag-distance M  Peak detection radius in metres (default: 500).
  --country         Annotate tracks with country name.
  TASK              doit tasks to run (default: build_tracks build_peaks_pmtiles).

To re-bag after a peak name change or new peak added:
  uv run python build.py --force
"""
import argparse
import fnmatch
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build DoneIt PMTiles (wraps doit).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--folder", default="DoneIt", metavar="NAME")
    parser.add_argument("--bag-distance", type=float, default=500.0, metavar="METRES")
    parser.add_argument("--country", action="store_true",
                        help="Annotate tracks with country name")
    parser.add_argument("--force", action="store_true",
                        help="Delete gpx-cache.json and .doit.db before running")
    parser.add_argument("--retrack", metavar="PATTERN",
                        help="Glob matching cache keys (e.g. 'hills/*') to remove and re-run")
    parser.add_argument("tasks", nargs="*")
    args = parser.parse_args()

    env = {
        **os.environ,
        "DONEIT_FOLDER": args.folder,
        "DONEIT_BAG_DISTANCE": str(args.bag_distance),
        "DONEIT_COUNTRY": "1" if args.country else "",
    }

    db_path = HERE / ".doit.db"

    if args.force or args.retrack:
        sys.path.insert(0, str(HERE))
        import pipeline  # noqa: PLC0415

        drive_root = pipeline.find_gdrive_root()
        doneit = pipeline.find_folder(drive_root, args.folder)
        tracks_folder = pipeline.find_folder(doneit, "tracks")
        track_names = pipeline.list_by_name(tracks_folder)
        cache_path: Path = track_names.get(
            pipeline.GPX_CACHE_NAME, tracks_folder / pipeline.GPX_CACHE_NAME
        )

        if args.force:
            if cache_path.exists():
                cache_path.unlink()
                print(f"Deleted {pipeline.GPX_CACHE_NAME}")
            if db_path.exists():
                db_path.unlink()
                print("Deleted .doit.db")

        if args.retrack:
            if cache_path.exists():
                try:
                    data = json.loads(cache_path.read_text())
                    if data.get("version") == 1:
                        entries: dict[str, object] = data.get("entries", {})
                        removed = [k for k in list(entries) if fnmatch.fnmatch(k, args.retrack)]
                        for k in removed:
                            del entries[k]
                        if removed:
                            cache_path.write_text(json.dumps(data))
                            print(f"Removed {len(removed)} entr(ies) matching '{args.retrack}':")
                            for k in removed:
                                print(f"  {k}")
                        else:
                            print(f"No cache entries matched '{args.retrack}'")
                except Exception as exc:
                    sys.exit(f"Could not update cache: {exc}")
            else:
                print("Cache does not exist — nothing to remove")
            # Discard doit stored state so it re-evaluates the modified cache
            if db_path.exists():
                db_path.unlink()
                print("Deleted .doit.db")

    result = subprocess.run(
        ["uv", "run", "doit", *args.tasks],
        env=env,
        cwd=str(HERE),
    )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
