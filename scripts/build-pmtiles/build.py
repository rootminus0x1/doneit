"""CLI entry point for the DoneIt build pipeline.

Usage:
  uv run python build.py [OPTIONS] [TASK ...]

Options:
  --force           Delete gpx-cache.json and .doit.db before running. All tracks
                    are re-parsed and all peak baggings are re-detected from scratch.
  --retrack PATTERN Remove GPX cache entries matching PATTERN (glob, e.g. 'hills/*')
                    and delete .doit.db so those tracks are re-parsed and re-bagged.
  --bag-distance M  Peak detection radius in metres (default: 500). Any change is
                    detected automatically and triggers re-bagging of all cached tracks.
  --folder NAME     Drive folder name (default: DoneIt).
  TASK              doit tasks to run (default: build_tracks build_peaks_pmtiles).
"""
import argparse
import fnmatch
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
BAG_CONFIG_PATH = HERE / ".bag-config.json"


def _bag_distance_changed(bag_distance: float) -> bool:
    """Return True if bag-distance differs from last run; update stored value."""
    try:
        stored = json.loads(BAG_CONFIG_PATH.read_text()).get("bag_distance")
    except Exception:
        stored = None
    if stored == bag_distance:
        return False
    BAG_CONFIG_PATH.write_text(json.dumps({"bag_distance": bag_distance}))
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build DoneIt PMTiles (wraps doit).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "available tasks:\n"
            "  parse_and_bag_tracks  parse new/changed GPX tracks and detect peak baggings\n"
            "  build_tracks          build tracks.pmtiles and tracks-index.json\n"
            "  build_peaks_pmtiles   build peaks.pmtiles\n"
        ),
    )
    parser.add_argument(
        "--folder", default="DoneIt", metavar="NAME",
        help="Drive folder name to read GPX tracks and peaks from (default: %(default)s)",
    )
    parser.add_argument(
        "--bag-distance", type=float, default=500.0, metavar="METRES",
        help=(
            "peak detection radius in metres (default: %(default)s); "
            "any change is detected automatically and re-bags all cached tracks"
        ),
    )
    parser.add_argument(
        "--force", action="store_true",
        help=(
            "delete gpx-cache.json and .doit.db before running, "
            "forcing a full rebuild: all tracks are re-parsed and all peak "
            "baggings are re-detected from scratch"
        ),
    )
    parser.add_argument(
        "--retrack", metavar="PATTERN",
        help=(
            "remove GPX cache entries matching a glob pattern (e.g. 'hills/*') "
            "and delete .doit.db so those tracks are re-parsed and re-bagged; "
            "other cached tracks are not affected"
        ),
    )
    parser.add_argument(
        "tasks", nargs="*",
        help="doit task(s) to run (default: build_tracks build_peaks_pmtiles)",
    )
    args = parser.parse_args()

    env = {
        **os.environ,
        "DONEIT_FOLDER": args.folder,
        "DONEIT_BAG_DISTANCE": str(args.bag_distance),
    }

    db_path = HERE / ".doit.db"

    # Write .bag-config.json so doit detects a bag-distance change via its file dep.
    # The pipeline also reads bag_distance from peaks-index.json to confirm the change.
    if not args.force:
        _bag_distance_changed(args.bag_distance)

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
            # Update stored bag distance so the next non-force run doesn't re-trigger
            BAG_CONFIG_PATH.write_text(json.dumps({"bag_distance": args.bag_distance}))

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
            if db_path.exists():
                db_path.unlink()
                print("Deleted .doit.db")

    t0 = time.perf_counter()
    result = subprocess.run(
        ["uv", "run", "doit", *args.tasks],
        env=env,
        cwd=str(HERE),
    )
    elapsed = time.perf_counter() - t0
    print(f"Total: {elapsed:.1f}s", file=sys.stderr)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
