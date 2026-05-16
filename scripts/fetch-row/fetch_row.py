#!/usr/bin/env python3
"""
Download Rights of Way GeoJSON data from rowmaps.com and merge into a single
GeoJSON FeatureCollection, ready for PMTiles conversion with tippecanoe.

Usage:
    python fetch_row.py [output.geojson]

Output defaults to row_combined.geojson in the current directory.
"""

import json
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE_URL = "https://www.rowmaps.com/jsons"

ROW_TYPES = {
    1: "footpath",
    2: "bridleway",
    3: "restricted_byway",
    4: "byway",
}

# 149 UK local authorities with their codes and names
AUTHORITIES = {
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


def fetch_json(url: str, retries: int = 3) -> dict | None:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "rowmaps-downloader/1.0"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None  # this authority has no data for this ROW type
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            print(f"  HTTP {e.code}: {url}", file=sys.stderr)
            return None
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            print(f"  Error fetching {url}: {e}", file=sys.stderr)
            return None


def fetch_authority_type(code: str, name: str, type_num: int) -> list[dict]:
    url = f"{BASE_URL}/{code}/mutated{type_num}.json"
    row_type = ROW_TYPES[type_num]
    data = fetch_json(url)
    if data is None:
        return []

    features = data.get("features", [])
    for feature in features:
        props = feature.setdefault("properties", {})
        props["row_type"] = row_type
        props["authority_code"] = code
        props["authority_name"] = name

    return features


def main():
    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("row_combined.geojson")

    all_features = []
    total = len(AUTHORITIES) * len(ROW_TYPES)
    completed = 0

    print(f"Downloading {len(AUTHORITIES)} authorities × {len(ROW_TYPES)} ROW types = {total} requests")
    print(f"Output: {output_path}\n")

    tasks = [
        (code, name, type_num)
        for code, name in sorted(AUTHORITIES.items())
        for type_num in ROW_TYPES
    ]

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {
            pool.submit(fetch_authority_type, code, name, type_num): (code, type_num)
            for code, name, type_num in tasks
        }
        for future in as_completed(futures):
            code, type_num = futures[future]
            completed += 1
            try:
                features = future.result()
                all_features.extend(features)
                print(
                    f"[{completed:>4}/{total}] {code} {ROW_TYPES[type_num]:<20} "
                    f"({len(features)} features)"
                )
            except Exception as e:
                print(f"[{completed:>4}/{total}] {code} {ROW_TYPES[type_num]} FAILED: {e}", file=sys.stderr)

    geojson = {
        "type": "FeatureCollection",
        "features": all_features,
    }

    print(f"\nWriting {len(all_features)} features to {output_path} ...")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    print("Done.")


if __name__ == "__main__":
    main()
