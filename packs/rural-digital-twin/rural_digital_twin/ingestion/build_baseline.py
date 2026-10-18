"""Writes the Bocenago site's boundary and baseline, from OpenStreetMap:
the municipality's boundary, and its land covers — forest, meadows,
grassland, scrub, rock, the village — clipped to it. The forest is split
into stands by altitude belt (see stands.py), which needs the site's
terrain grid: build it first (ingestion/build_terrain.py). Where OSM has no
cover, the ground is the terrain's own surface.

    uv run python -m rural_digital_twin.ingestion.build_baseline
"""

import base64
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmnx as ox
import shapely
from shapely.geometry import box, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from civic_engagement.local_frame import Anchor
from civic_engagement.models.schema import BaselineScene, CoverPolygon, TerrainGrid
from rural_digital_twin.sites import DATA_DIR
from rural_digital_twin.stands import BELTS, belt_of, stand_properties

# The municipality of Bocenago, as an OpenStreetMap relation.
OSM_RELATION = "R46873"

# Each cover type and the OSM tags it comes from, in order of precedence:
# where two overlap (OSM often draws a meadow over the forest), the earlier
# wins, so the covers come out without overlaps.
COVER_TAGS: list[tuple[str, dict[str, list[str]]]] = [
    ("residential", {"landuse": ["residential"]}),
    ("rock", {"natural": ["bare_rock", "scree"]}),
    ("meadow", {"landuse": ["meadow", "farmland"]}),
    ("grassland", {"natural": ["grassland"], "landuse": ["grass"]}),
    ("scrub", {"natural": ["scrub", "heath"]}),
    ("forest", {"landuse": ["forest"], "natural": ["wood"]}),
]
MIN_COVER_M2 = 200
MIN_STAND_M2 = 5000


def _to(geometry: BaseGeometry, crs_from: str, crs_to: str) -> BaseGeometry:
    return gpd.GeoSeries([geometry], crs=crs_from).to_crs(crs_to).iloc[0]


def _polygons(geometry: BaseGeometry, min_area_m2: float) -> list[BaseGeometry]:
    return [p for p in getattr(geometry, "geoms", [geometry]) if p.geom_type == "Polygon" and p.area >= min_area_m2]


def _geojson(geometry_utm: BaseGeometry) -> dict:
    return mapping(shapely.set_precision(_to(geometry_utm, PROJECTED_CRS, WGS84_CRS), 1e-7))


def fetch_boundary() -> tuple[dict, str]:
    gdf = ox.geocode_to_gdf(OSM_RELATION, by_osmid=True)
    geometry = gdf.geometry.iloc[0]
    if geometry.geom_type != "Polygon":
        raise RuntimeError(f"Expected one polygon for {OSM_RELATION}, got a {geometry.geom_type}")
    boundary = {"type": "Polygon", "coordinates": [[[round(x, 7), round(y, 7)] for x, y in geometry.exterior.coords]]}
    return boundary, gdf["name"].iloc[0]


def fetch_land_covers(boundary_wgs84: BaseGeometry) -> dict[str, BaseGeometry]:
    """Each cover type's area within the boundary, in UTM, without overlaps."""
    tags: dict[str, list[str]] = {}
    for _, cover_tags in COVER_TAGS:
        for key, values in cover_tags.items():
            tags.setdefault(key, []).extend(values)
    features = ox.features_from_polygon(boundary_wgs84, tags=tags)
    features = features[features.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].to_crs(PROJECTED_CRS)
    boundary_utm = _to(boundary_wgs84, WGS84_CRS, PROJECTED_CRS)
    taken = shapely.Polygon()
    covers = {}
    for cover_type, cover_tags in COVER_TAGS:
        match = np.zeros(len(features), dtype=bool)
        for key, values in cover_tags.items():
            if key in features:
                match |= features[key].isin(values).to_numpy()
        area = unary_union([g.buffer(0) for g in features.geometry[match]]).intersection(boundary_utm).difference(taken)
        covers[cover_type] = area
        taken = taken.union(area)
    return covers


class Elevation:
    """The terrain grid's ground, as elevation above sea level, with its
    points in UTM."""

    def __init__(self, grid: TerrainGrid):
        levels = np.frombuffer(base64.b64decode(grid.heights), dtype="<u2").reshape(grid.rows, grid.cols)
        self.grid = grid
        self.metres = grid.base_elevation_m + levels * grid.height_scale_m
        self.anchor = Anchor.at(grid.anchor_lng, grid.anchor_lat)

    def local_to_utm(self, geometry_local: BaseGeometry) -> BaseGeometry:
        """A geometry in the grid's frame (x east, z south) to UTM."""
        wgs84 = shapely.transform(geometry_local, lambda c: np.column_stack(self.anchor.lng_lat(c[:, 0], -c[:, 1])))
        return _to(wgs84, WGS84_CRS, PROJECTED_CRS)

    def belt_areas(self) -> list[BaseGeometry]:
        """Each altitude belt's area, in UTM: its grid points' cells, merged
        into runs along each row."""
        g = self.grid
        belts = np.vectorize(belt_of)(self.metres)
        half = g.cell_m / 2
        areas = []
        for belt in range(len(BELTS)):
            boxes = []
            for row in range(g.rows):
                inside = np.concatenate([[False], belts[row] == belt, [False]])
                edges = np.flatnonzero(inside[1:] != inside[:-1])
                z = g.z0 + row * g.cell_m
                for start, end in zip(edges[::2], edges[1::2]):
                    boxes.append(box(g.x0 + start * g.cell_m - half, z - half, g.x0 + (end - 1) * g.cell_m + half, z + half))
            areas.append(self.local_to_utm(unary_union(boxes)) if boxes else shapely.Polygon())
        return areas

    def mean_within(self, polygon_utm: BaseGeometry) -> float:
        """The mean elevation of the grid points within a polygon."""
        g = self.grid
        wgs84 = _to(polygon_utm, PROJECTED_CRS, WGS84_CRS)
        local = shapely.transform(wgs84, lambda c: np.column_stack(self.anchor.east_north(c[:, 0], c[:, 1])))
        # Back to the grid's frame: z south.
        local = shapely.transform(local, lambda c: np.column_stack((c[:, 0], -c[:, 1])))
        xs, zs = np.meshgrid(g.x0 + np.arange(g.cols) * g.cell_m, g.z0 + np.arange(g.rows) * g.cell_m)
        inside = shapely.contains_xy(local, xs, zs)
        return float(self.metres[inside].mean()) if inside.any() else float("nan")


def stands_of(forest_utm: BaseGeometry, elevation: Elevation) -> list[CoverPolygon]:
    stands = []
    for belt, belt_area in enumerate(elevation.belt_areas()):
        for polygon in _polygons(forest_utm.intersection(belt_area), MIN_STAND_M2):
            stands.append(CoverPolygon(
                id=f"stand-{len(stands) + 1}",
                geometry=_geojson(polygon),
                cover_type="forest",
                properties=stand_properties(belt, elevation.mean_within(polygon), polygon.area / 10_000),
                source="baseline",
            ))
    return stands


def main() -> None:
    out = Path(DATA_DIR)
    grid_path = out / "terrain" / "terrain_grid.json"
    if not grid_path.is_file():
        raise SystemExit(f"{grid_path} is missing: build the terrain grid first (ingestion/build_terrain.py)")
    elevation = Elevation(TerrainGrid(**json.loads(grid_path.read_text())))

    boundary, name = fetch_boundary()
    covers_utm = fetch_land_covers(shape(boundary))
    covers: list[CoverPolygon] = []
    for cover_type, _ in reversed(COVER_TAGS):
        if cover_type == "forest":
            continue
        for polygon in _polygons(covers_utm[cover_type], MIN_COVER_M2):
            covers.append(CoverPolygon(
                id=f"{cover_type}-{len(covers) + 1}", geometry=_geojson(polygon), cover_type=cover_type, source="baseline",
            ))
    stands = stands_of(covers_utm["forest"], elevation)

    feature = {
        "type": "Feature",
        "properties": {"name": name, "source": "OpenStreetMap", "osm_relation": OSM_RELATION, "licence": "© OpenStreetMap contributors, ODbL"},
        "geometry": boundary,
    }
    (out / "boundary.geojson").write_text(json.dumps(feature))
    baseline = BaselineScene(site_boundary=boundary, elements=[], covers=[*stands, *covers])
    (out / "baseline.json").write_text(json.dumps(baseline.model_dump()))
    by_type: dict[str, float] = {}
    for c in baseline.covers:
        by_type[c.cover_type] = by_type.get(c.cover_type, 0) + _to(shape(c.geometry), WGS84_CRS, PROJECTED_CRS).area / 10_000
    print(f"Wrote {out}/boundary.geojson and baseline.json: {len(stands)} stands, {len(covers)} other covers; "
          + ", ".join(f"{t} {ha:.0f} ha" for t, ha in sorted(by_type.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
