"""Writes the Bocenago site's boundary and baseline: the municipality's
boundary from OpenStreetMap, and a baseline with nothing on it yet (no
elements, no covers: the bare ground is the terrain's own surface).

    uv run python -m rural_digital_twin.ingestion.build_baseline
"""

import json
from pathlib import Path

import osmnx as ox

from civic_engagement.models.schema import BaselineScene
from rural_digital_twin.sites import DATA_DIR

# The municipality of Bocenago, as an OpenStreetMap relation.
OSM_RELATION = "R46873"


def main() -> None:
    gdf = ox.geocode_to_gdf(OSM_RELATION, by_osmid=True)
    geometry = gdf.geometry.iloc[0]
    if geometry.geom_type != "Polygon":
        raise RuntimeError(f"Expected one polygon for {OSM_RELATION}, got a {geometry.geom_type}")
    boundary = {
        "type": "Polygon",
        "coordinates": [[[round(x, 7), round(y, 7)] for x, y in geometry.exterior.coords]],
    }
    out = Path(DATA_DIR)
    out.mkdir(parents=True, exist_ok=True)
    feature = {
        "type": "Feature",
        "properties": {
            "name": gdf["name"].iloc[0],
            "source": "OpenStreetMap",
            "osm_relation": OSM_RELATION,
            "licence": "© OpenStreetMap contributors, ODbL",
        },
        "geometry": boundary,
    }
    (out / "boundary.geojson").write_text(json.dumps(feature))
    baseline = BaselineScene(site_boundary=boundary, elements=[], covers=[])
    (out / "baseline.json").write_text(json.dumps(baseline.model_dump(), indent=2))
    print(f"Wrote {out}/boundary.geojson ({len(boundary['coordinates'][0])} vertices) and baseline.json")


if __name__ == "__main__":
    main()
