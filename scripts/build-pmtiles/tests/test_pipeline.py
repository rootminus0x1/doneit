"""Unit tests for pipeline.py pure functions.

Importing pipeline here must not create any directories or make network calls.
If it does, the no-side-effects-at-import principle has been violated.
"""
import json
import pytest
import pipeline


# ---------------------------------------------------------------------------
# haversine_m
# ---------------------------------------------------------------------------

def test_haversine_same_point():
    assert pipeline.haversine_m(57.0, -4.0, 57.0, -4.0) == pytest.approx(0.0, abs=1.0)


def test_haversine_one_degree_latitude():
    # 1° of latitude ≈ 111 195 m
    dist = pipeline.haversine_m(0.0, 0.0, 1.0, 0.0)
    assert dist == pytest.approx(111_195, rel=0.005)


def test_haversine_ben_nevis_to_carn_mor_dearg():
    # Known pair: Ben Nevis (56.7969, -4.9976) → Carn Mor Dearg (56.8218, -4.9496) ≈ 4 km
    dist = pipeline.haversine_m(56.7969, -4.9976, 56.8218, -4.9496)
    assert 3_800 < dist < 4_300


def test_haversine_symmetric():
    a = pipeline.haversine_m(56.0, -4.0, 57.0, -5.0)
    b = pipeline.haversine_m(57.0, -5.0, 56.0, -4.0)
    assert a == pytest.approx(b, rel=1e-9)


# ---------------------------------------------------------------------------
# detect_baggings_for_new_tracks
# ---------------------------------------------------------------------------

MUNRO = {"name": "Ben Nevis", "lat": 56.7969, "lng": -4.9976, "ele": 1345.0}
CORBETT = {"name": "Beinn Bhan", "lat": 57.4167, "lng": -5.7333, "ele": 896.0}


def test_detect_baggings_track_on_summit():
    tracks = [("activity_1.gpx", "2024-06-15", [[-4.9976, 56.7969]])]
    peaks = {"munros": [MUNRO]}
    result = pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0)
    assert len(result) == 1
    assert result[0]["track"] == "activity_1.gpx"
    assert result[0]["date"] == "2024-06-15"
    assert result[0]["peaks"][0]["category"] == "munros"
    assert "Ben Nevis" in result[0]["peaks"][0]["names"]


def test_detect_baggings_track_far_from_peaks():
    # London is thousands of km from Scottish peaks
    tracks = [("activity_2.gpx", "2024-01-01", [[-0.1276, 51.5074]])]
    peaks = {"munros": [MUNRO]}
    assert pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0) == []


def test_detect_baggings_track_just_within_radius():
    # 400 m offset in latitude ≈ 0.0036°
    offset_lat = 400 / 111_000
    coords = [[-4.9976, 56.7969 + offset_lat]]
    tracks = [("activity_3.gpx", "2024-06-15", coords)]
    peaks = {"munros": [MUNRO]}
    result = pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0)
    assert len(result) == 1


def test_detect_baggings_track_just_beyond_radius():
    # 600 m offset → outside 500 m threshold
    offset_lat = 600 / 111_000
    coords = [[-4.9976, 56.7969 + offset_lat]]
    tracks = [("activity_4.gpx", "2024-06-15", coords)]
    peaks = {"munros": [MUNRO]}
    assert pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0) == []


def test_detect_baggings_multiple_categories():
    coords = [[-4.9976, 56.7969], [-5.7333, 57.4167]]
    tracks = [("activity_5.gpx", "2024-06-15", coords)]
    peaks = {"munros": [MUNRO], "corbetts": [CORBETT]}
    result = pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0)
    assert len(result) == 1
    categories = {p["category"] for p in result[0]["peaks"]}
    assert "munros" in categories
    assert "corbetts" in categories


def test_detect_baggings_empty_track_skipped():
    tracks = [("activity_6.gpx", "2024-06-15", [])]
    peaks = {"munros": [MUNRO]}
    assert pipeline.detect_baggings_for_new_tracks(tracks, peaks, 500.0) == []


# ---------------------------------------------------------------------------
# save_peaks_index / load_peaks_index
# ---------------------------------------------------------------------------

def test_peaks_index_roundtrip(tmp_path):
    path = tmp_path / "peaks-index.json"
    index = {
        "version": 2,
        "categories": [{"name": "munros", "count": 282}],
        "bagged": [
            {"track": "activity_1.gpx", "date": "2024-06-15",
             "peaks": [{"category": "munros", "names": ["Ben Nevis"]}]},
        ],
        "peak_hash": "abc123",
        "bag_distance": 500.0,
    }
    pipeline.save_peaks_index(path, index)
    loaded = pipeline.load_peaks_index(path)
    assert loaded["version"] == 2
    assert loaded["categories"] == [{"name": "munros", "count": 282}]
    assert len(loaded["bagged"]) == 1
    assert loaded["peak_hash"] == "abc123"
    assert loaded["bag_distance"] == 500.0


def test_save_peaks_index_deduplicates_by_track(tmp_path):
    path = tmp_path / "peaks-index.json"
    index = {
        "bagged": [
            {"track": "activity_1.gpx", "date": "2024-01-01",
             "peaks": [{"category": "munros", "names": ["Ben Nevis"]}]},
            {"track": "activity_1.gpx", "date": "2024-01-01",   # duplicate
             "peaks": [{"category": "munros", "names": ["Ben Nevis"]}]},
            {"date": "2024-01-01",                               # manual (no track)
             "peaks": [{"category": "munros", "names": ["Cairn Gorm"]}]},
            {"date": "2024-01-02",                               # second manual
             "peaks": [{"category": "munros", "names": ["Ben Macdui"]}]},
        ],
    }
    pipeline.save_peaks_index(path, index)
    loaded = pipeline.load_peaks_index(path)
    assert len(loaded["bagged"]) == 3  # one deduped track + two manual entries


def test_save_peaks_index_keeps_all_manual_entries(tmp_path):
    path = tmp_path / "peaks-index.json"
    index = {
        "bagged": [
            {"date": "2024-01-01", "peaks": [{"category": "munros", "names": ["A"]}]},
            {"date": "2024-01-02", "peaks": [{"category": "munros", "names": ["B"]}]},
            {"date": "2024-01-03", "peaks": [{"category": "munros", "names": ["C"]}]},
        ],
    }
    pipeline.save_peaks_index(path, index)
    loaded = pipeline.load_peaks_index(path)
    assert len(loaded["bagged"]) == 3


def test_load_peaks_index_missing_file(tmp_path):
    path = tmp_path / "nonexistent.json"
    result = pipeline.load_peaks_index(path)
    assert result["version"] == 2
    assert result["bagged"] == []
    assert result["categories"] == []


def test_load_peaks_index_malformed_file(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("not json {{{")
    result = pipeline.load_peaks_index(path)
    assert result["version"] == 2


# ---------------------------------------------------------------------------
# save_gpx_cache / load_gpx_cache
# ---------------------------------------------------------------------------

SAMPLE_CACHE = {
    "hills/activity_1.gpx": {
        "md5": "abc123",
        "mtime": 1_700_000_000.0,
        "meta": {"displayName": "Ben Nevis Circuit", "datetime": "2024-06-15T09:00:00Z",
                 "trackType": "hiking", "linkText": None},
        "tracks": [[[-4.9976, 56.7969], [-4.9800, 56.8000]]],
    },
}


def test_gpx_cache_roundtrip(tmp_path):
    path = tmp_path / "gpx-cache.json"
    pipeline.save_gpx_cache(path, SAMPLE_CACHE)
    loaded = pipeline.load_gpx_cache(path)
    assert "hills/activity_1.gpx" in loaded
    entry = loaded["hills/activity_1.gpx"]
    assert entry["md5"] == "abc123"
    assert entry["meta"]["displayName"] == "Ben Nevis Circuit"
    assert len(entry["tracks"][0]) == 2


def test_load_gpx_cache_missing_file(tmp_path):
    path = tmp_path / "no-cache.json"
    assert pipeline.load_gpx_cache(path) == {}


def test_load_gpx_cache_malformed_file(tmp_path):
    path = tmp_path / "bad-cache.json"
    path.write_text("not json")
    assert pipeline.load_gpx_cache(path) == {}


def test_load_gpx_cache_wrong_version(tmp_path):
    path = tmp_path / "old-cache.json"
    path.write_text(json.dumps({"version": 1, "entries": {"key": "value"}}))
    assert pipeline.load_gpx_cache(path) == {}


# ---------------------------------------------------------------------------
# bbox_from_features
# ---------------------------------------------------------------------------

def _make_feature(coords: list[list[float]]) -> dict:
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {}}


def test_bbox_single_feature():
    feature = _make_feature([[-5.0, 56.0], [-4.0, 57.0]])
    bbox = pipeline.bbox_from_features([feature])
    assert bbox is not None
    assert bbox["west"] == pytest.approx(-5.0)
    assert bbox["east"] == pytest.approx(-4.0)
    assert bbox["south"] == pytest.approx(56.0)
    assert bbox["north"] == pytest.approx(57.0)


def test_bbox_multiple_features():
    f1 = _make_feature([[-5.0, 56.0]])
    f2 = _make_feature([[-3.0, 58.0]])
    bbox = pipeline.bbox_from_features([f1, f2])
    assert bbox["west"] == pytest.approx(-5.0)
    assert bbox["east"] == pytest.approx(-3.0)
    assert bbox["north"] == pytest.approx(58.0)


def test_bbox_returns_none_for_empty_features():
    assert pipeline.bbox_from_features([]) is None


def test_bbox_returns_none_for_empty_coordinates():
    assert pipeline.bbox_from_features([_make_feature([])]) is None
