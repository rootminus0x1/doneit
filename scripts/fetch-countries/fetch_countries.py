"""
Downloads Natural Earth 10m admin-1 (states/provinces), simplifies geometries,
strips unused properties, and writes to public/ne_110m_countries.geojson.
Run with: yarn fetch-countries
"""

from pathlib import Path

import geopandas as gpd

URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"
OUT = Path(__file__).parent.parent.parent / "public" / "ne_110m_countries.geojson"

print(f"Fetching {URL} ...")
gdf = gpd.read_file(URL)

gdf = gdf[["name", "geonunit", "admin", "geometry"]]
# simplify(bumping tolerance, ...)
# bumping tolerance reduces file size so larger the toleranec the smaller the file
gdf["geometry"] = gdf["geometry"].simplify(0.05, preserve_topology=True)

OUT.parent.mkdir(parents=True, exist_ok=True)
gdf.to_file(OUT, driver="GeoJSON")
print(f"Written {OUT} ({len(gdf)} features, {OUT.stat().st_size // 1024} KB)")
