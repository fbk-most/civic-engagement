"""Real-world area/length helpers for indicator computation. Reprojects to the
same UTM32N CRS used elsewhere (see config.py) since GeoJSON lon/lat degrees
aren't usable directly for area or length math.
"""

import math
import random

import geopandas as gpd
from shapely.geometry import Point, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from civic_engagement.config import PROJECTED_CRS, WGS84_CRS


def to_projected(geojson: dict) -> BaseGeometry:
    geom = shape(geojson)
    return gpd.GeoSeries([geom], crs=WGS84_CRS).to_crs(PROJECTED_CRS).iloc[0]


def to_projected_many(geojsons: list[dict]) -> list[BaseGeometry]:
    """`to_projected` for many geometries at once (one reprojection)."""
    if not geojsons:
        return []
    return list(gpd.GeoSeries([shape(g) for g in geojsons], crs=WGS84_CRS).to_crs(PROJECTED_CRS))


def area_m2(geojson: dict) -> float:
    return to_projected(geojson).area


def length_m(geojson: dict) -> float:
    return to_projected(geojson).length


def grid_points_within(geojson: dict, spacing_m: float) -> list[dict]:
    """Regular grid of points, `spacing_m` apart, that fall inside a polygon —
    used to lay out a grove's trees. Returned as WGS84 GeoJSON Points."""
    polygon = to_projected(geojson)
    minx, miny, maxx, maxy = polygon.bounds

    points = []
    y = miny
    while y <= maxy:
        x = minx
        while x <= maxx:
            pt = Point(x, y)
            if polygon.contains(pt):
                points.append(pt)
            x += spacing_m
        y += spacing_m

    if not points:
        return []
    wgs84_points = gpd.GeoSeries(points, crs=PROJECTED_CRS).to_crs(WGS84_CRS)
    return [mapping(p) for p in wgs84_points]


# Fraction of `spacing_m` a jittered point can be nudged from its grid cell
# centre, in a random direction — enough to break the "rows and columns"
# read without a point drifting into a neighbouring cell.
JITTER_FRACTION = 0.4


def jittered_grid_points_within(geojson: dict, spacing_m: float, seed: str) -> list[dict]:
    """Like `grid_points_within`, but each grid point gets a small random
    offset, so a grove reads as informally planted rather than gridded.

    Deterministic per `seed` (`random.Random(seed)`, same idea as
    `bologna_civic_dt/trees.py`'s baseline tree identities): a grove's trees
    must come out the same for the same intervention every time — in every
    evaluation of every scenario, not just within one request.
    """
    polygon = to_projected(geojson)
    minx, miny, maxx, maxy = polygon.bounds
    rng = random.Random(seed)

    points = []
    y = miny
    while y <= maxy:
        x = minx
        while x <= maxx:
            offset_r = rng.uniform(0, spacing_m * JITTER_FRACTION)
            offset_theta = rng.uniform(0, 2 * math.pi)
            pt = Point(x + offset_r * math.cos(offset_theta), y + offset_r * math.sin(offset_theta))
            if polygon.contains(pt):
                points.append(pt)
            x += spacing_m
        y += spacing_m

    if not points:
        return []
    wgs84_points = gpd.GeoSeries(points, crs=PROJECTED_CRS).to_crs(WGS84_CRS)
    return [mapping(p) for p in wgs84_points]


def grove_points_within(geojson: dict, spacing_m: float, seed: str, algorithm: str = "jittered") -> list[dict]:
    """Scatters a grove's trees with `algorithm`: "jittered" (see
    `jittered_grid_points_within`'s docstring) or "grid". The urban pack
    takes it from the site (`grove_placement_algorithm`).
    """
    if algorithm == "jittered":
        return jittered_grid_points_within(geojson, spacing_m, seed)
    return grid_points_within(geojson, spacing_m)


def points_along(geojson: dict, spacing_m: float) -> list[dict]:
    """Points along a line, both ends included, evenly spaced as close to
    `spacing_m` apart as the line's length allows — used to lay out the
    streetlights of a lit path. Returned as WGS84 GeoJSON Points."""
    line = to_projected(geojson)
    gaps = max(1, round(line.length / spacing_m))
    points = [line.interpolate(line.length * i / gaps) for i in range(gaps + 1)]
    wgs84_points = gpd.GeoSeries(points, crs=PROJECTED_CRS).to_crs(WGS84_CRS)
    return [mapping(p) for p in wgs84_points]


def centroid_point(geojson: dict) -> dict:
    """WGS84 GeoJSON Point at the centroid of a polygon — used to give an
    area card's equipment (playground, fitness area) a single geometric
    handle for the 3D builder, the same way `grid_points_within` does for a
    grove's trees."""
    polygon = to_projected(geojson)
    wgs84_point = gpd.GeoSeries([polygon.centroid], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0]
    return mapping(wgs84_point)


def coverage_pct(site_boundary: dict, points: list[dict], radius_m: float) -> float:
    """% of the site area within `radius_m` of any of `points` — used for the
    lighting/shelter coverage heuristics behind the social indicators."""
    site = to_projected(site_boundary)
    site_area = site.area
    if site_area == 0 or not points:
        return 0.0

    projected_points = gpd.GeoSeries([shape(p) for p in points], crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    covered = unary_union([p.buffer(radius_m) for p in projected_points]).intersection(site)
    return 100 * covered.area / site_area
