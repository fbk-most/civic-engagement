"""OSM fetch helpers for baseline ingestion.

The height-parsing logic here was extracted from the original scripts/spikes/pd.py
and scripts/spikes/pv.py experiments (both had copy-pasted the same regex hack).
"""

import math

import geopandas as gpd
import osmnx as ox
import pandas as pd
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry

from bologna_civic_dt.sites import SITE
from civic_engagement.config import PROJECTED_CRS, WGS84_CRS

COVER_TAG_TO_TYPE = {
    ("natural", "wood"): "wood",
    ("natural", "scrub"): "meadow",
    ("natural", "grassland"): "meadow",
    ("natural", "water"): "water",
    ("landuse", "grass"): "lawn",
    ("landuse", "meadow"): "meadow",
    ("landuse", "forest"): "wood",
    ("leisure", "garden"): "lawn",
    ("leisure", "park"): "lawn",
    ("leisure", "pitch"): "paving",
}
COVER_TAGS = {
    "natural": ["wood", "scrub", "grassland", "water"],
    "landuse": ["grass", "meadow", "forest"],
    "leisure": ["garden", "park", "pitch"],
}
PATH_HIGHWAY_TAGS = ["footway", "pedestrian", "path", "steps", "living_street"]
PATH_WIDTH_DEFAULTS_M = {
    "footway": 2.0,
    "pedestrian": 4.0,
    "path": 1.5,
    "steps": 2.0,
    "living_street": 5.0,
}

# Vehicle-class ways, kept separate from PATH_HIGHWAY_TAGS/fetch_paths since
# they render as their own "street" element type (flat dark gray, no
# material variety) rather than as a path.
STREET_HIGHWAY_TAGS = ["primary", "secondary", "tertiary", "unclassified", "residential", "service"]

# Only used when a way carries no `lanes` tag (see street_widths) — a plain
# two-way assumption. Most ways in practice do carry `lanes`, which wins.
STREET_WIDTH_DEFAULTS_M = {
    "primary": 9.0,
    "secondary": 8.0,
    "tertiary": 7.0,
    "unclassified": 6.0,
    "residential": 6.0,
    "service": 3.5,
}
LANE_WIDTH_M = 3.25


def buffer_polygon_m(polygon_wgs84: BaseGeometry, buffer_m: float) -> BaseGeometry:
    """Buffer a WGS84 polygon by a distance in meters, via a projected round-trip."""
    projected = gpd.GeoSeries([polygon_wgs84], crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    buffered = projected.buffer(buffer_m)
    return buffered.to_crs(WGS84_CRS).iloc[0]


def parse_numeric_tag(raw: pd.Series) -> pd.Series:
    """Parse a loosely-formatted OSM numeric tag (e.g. "12", "12 m") into
    floats, leaving anything absent or unparseable as NaN so callers can fall
    through to the next source in their own precedence chain."""
    extracted = raw.astype(str).str.extract(r"(\d+(?:\.\d+)?)")[0]
    return pd.to_numeric(extracted, errors="coerce")


def _tag_column(df: gpd.GeoDataFrame, name: str) -> pd.Series:
    """OSM tag columns only exist when at least one fetched feature carries the
    tag, so every read has to tolerate the column being absent entirely."""
    if name in df.columns:
        return df[name]
    return pd.Series(index=df.index, dtype=object)


def building_heights(buildings: gpd.GeoDataFrame, default_height_m: float) -> pd.Series:
    """Resolve a height in metres for every footprint, in descending order of
    trustworthiness: an explicit `height` tag, then storey count
    (`building:levels` plus any habitable `roof:levels`) times a nominal storey
    height, then a guess keyed on the `building` kind, then the flat default.
    """
    explicit = parse_numeric_tag(_tag_column(buildings, "height"))
    levels = parse_numeric_tag(_tag_column(buildings, "building:levels"))
    roof_levels = parse_numeric_tag(_tag_column(buildings, "roof:levels")).fillna(0)
    from_levels = (levels + roof_levels) * SITE.building_level_height_m
    from_kind = pd.to_numeric(
        _tag_column(buildings, "building").map(SITE.building_kind_default_height_m), errors="coerce"
    )
    return explicit.fillna(from_levels).fillna(from_kind).fillna(default_height_m)


def fetch_buildings(polygon: BaseGeometry, default_height_m: float) -> gpd.GeoDataFrame:
    buildings = ox.features_from_polygon(polygon, tags={"building": True})
    buildings = buildings[buildings.geometry.type.isin(["Polygon", "MultiPolygon"])]
    buildings["height"] = building_heights(buildings, default_height_m)
    # Carried through for the 3D view: roof shape drives the roof solid, and
    # the building kind picks a facade material. Neither affects the 2D map.
    buildings["roof_shape"] = _tag_column(buildings, "roof:shape")
    buildings["building_kind"] = _tag_column(buildings, "building")
    return buildings.reset_index()[["geometry", "height", "roof_shape", "building_kind"]]


def fetch_cover_regions(polygon: BaseGeometry) -> gpd.GeoDataFrame:
    regions = ox.features_from_polygon(polygon, tags=COVER_TAGS)
    regions = regions[regions.geometry.type.isin(["Polygon", "MultiPolygon"])].reset_index()

    def cover_type_for(row) -> str | None:
        for key in ("natural", "landuse", "leisure"):
            value = row.get(key)
            if pd.notna(value) and (key, value) in COVER_TAG_TO_TYPE:
                return COVER_TAG_TO_TYPE[(key, value)]
        return None

    regions["cover_type"] = regions.apply(cover_type_for, axis=1)
    regions = regions.dropna(subset=["cover_type"])
    return regions[["geometry", "cover_type"]]


def fetch_paths(polygon: BaseGeometry) -> gpd.GeoDataFrame:
    try:
        paths = ox.features_from_polygon(polygon, tags={"highway": PATH_HIGHWAY_TAGS})
    except ox._errors.InsufficientResponseError:
        return gpd.GeoDataFrame(columns=["geometry", "width", "material", "footway"])
    paths = paths[paths.geometry.type.isin(["LineString", "MultiLineString"])].reset_index()
    paths["width"] = paths.get("highway", pd.Series(index=paths.index)).map(PATH_WIDTH_DEFAULTS_M).fillna(2.0)
    paths["material"] = paths.get("surface", pd.Series(index=paths.index)).fillna("paving")
    # Kept so build_baseline.py can tell a crosswalk (`footway=crossing`) from
    # an ordinary footway — its on-road part is drawn as zebra stripes, not
    # as a path ribbon.
    paths["footway"] = _tag_column(paths, "footway")
    return paths[["geometry", "width", "material", "footway"]]


# Only bridge a divided-road gap between ways that share a `name` and sit
# within this distance — bounds the risk of a name reused across an entire
# plaza's street grid (Piazza Dante's own name tags 23 separate ways) getting
# treated as one continuous divided road.
SAME_NAME_PAIR_MAX_DIST_M = 15.0
# Below this, a same-named way isn't a parallel twin at all — it's the *same*
# lane continuing past an intersection or around a corner, sharing an actual
# endpoint (distance ~0). Excluding these matters: naive nearest-neighbour
# picks the touching continuation over the real parallel twin a few metres
# away almost every time (0 always beats any positive distance), which is
# why the first version of this bridging logic barely fired at all.
SAME_NAME_MIN_PAIR_DIST_M = 1.5
# Extra width, split across both paired ways, beyond just touching — a hair
# of guaranteed overlap so the seam doesn't show as a hairline gap.
CARRIAGEWAY_OVERLAP_MARGIN_M = 1.0
# A genuine divided-road twin runs *opposite* the way it's paired with (two
# directions of the same corridor); the dot product of their overall
# direction vectors should be strongly negative. Above this (same direction,
# or crossing at an angle) it's some other nearby segment sharing the name —
# see the docstring below for why that distinction matters here specifically.
ANTIPARALLEL_DOT_MAX = -0.5


def _way_direction(geom) -> tuple[float, float]:
    """Overall direction (unit vector, first point to last, in a projected
    CRS) — a coarse per-way bearing, just precise enough to tell "the other
    direction of this same road" apart from "some other nearby segment"."""
    coords = list(geom.coords)
    (x0, y0), (x1, y1) = coords[0], coords[-1]
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    return (dx / length, dy / length) if length else (0.0, 0.0)


def _carriageway_pairs(streets: gpd.GeoDataFrame, projected: gpd.GeoSeries) -> list[tuple[int, int]]:
    """Matches each `oneway=yes` street to its genuine anti-parallel
    same-named twin — the two OSM ways that together represent one divided
    road, one per direction. A name isn't always just a simple A/B pair
    though (see `street_widths`'s docstring on Piazza XX Settembre's
    forecourt loop), so a candidate `j` only counts for `i` if it shares `i`'s
    name, sits within [SAME_NAME_MIN_PAIR_DIST_M, SAME_NAME_PAIR_MAX_DIST_M]
    of it, and runs opposite it (dot product of their overall directions
    below ANTIPARALLEL_DOT_MAX) — of those, the nearest wins.

    Returns one `(i, j)` per way `i` that has an eligible partner, so a
    mutually-matched pair appears as both `(i, j)` and `(j, i)`; callers that
    want each physical carriageway once should dedupe via `frozenset`.
    """
    name = _tag_column(streets, "name")
    is_oneway = _tag_column(streets, "oneway").astype(str).str.lower().eq("yes")
    named_oneway = [i for i in streets.index if is_oneway[i] and pd.notna(name[i])]
    directions = {i: _way_direction(projected[i]) for i in named_oneway}

    pairs: list[tuple[int, int]] = []
    for i in named_oneway:
        dir_i = directions[i]
        best_j, best_d = None, None
        for j in named_oneway:
            if j == i or name[j] != name[i]:
                continue
            d = projected[i].distance(projected[j])
            if not (SAME_NAME_MIN_PAIR_DIST_M <= d <= SAME_NAME_PAIR_MAX_DIST_M):
                continue
            dir_j = directions[j]
            dot = dir_i[0] * dir_j[0] + dir_i[1] * dir_j[1]
            if dot > ANTIPARALLEL_DOT_MAX:
                continue
            if best_d is None or d < best_d:
                best_j, best_d = j, d
        if best_j is not None:
            pairs.append((i, best_j))
    return pairs


def street_widths(streets: gpd.GeoDataFrame) -> pd.Series:
    """Resolve a width in metres per street way. A divided road maps to two
    separate one-way OSM ways (one per direction), each carrying its own
    `lanes` — using the flat per-class STREET_WIDTH_DEFAULTS_M for both
    (as if each were the *whole*, two-way road) was rendering them side by
    side at roughly double the real combined width, which is what actually
    read as "two separate streets" for a single one-way pair. `lanes` (present
    on ~75% of ways in practice) is a directly per-way measurement and wins
    whenever it's there; the class default is a two-way assumption, so it's
    halved for a `oneway=yes` way that lacks a `lanes` tag rather than trusted
    at face value.

    Fixing that width exposed a second issue: the two ways' digitized
    centrelines routinely sit several metres apart (their real, mapped
    positions — a mapper draws each direction's own lane line, not a shared
    axis), which the old oversized flat widths happened to paper over by
    sheer excess and the corrected, accurate widths no longer reach across —
    "one street, painted line down the middle" was rendering as two visibly
    separated strips. For each `oneway=yes` way, this looks for its nearest
    same-named `oneway=yes` partner within SAME_NAME_PAIR_MAX_DIST_M (see
    `_carriageway_pairs`) and widens *both* just enough that their
    independently-drawn ribbons (each still centred on its own line — see
    `builders/paths.ts`) overlap rather than leaving a gap.

    A name isn't always just a simple A/B divided-road pair, though — Piazza
    XX Settembre's own forecourt loop tags 19 separate ways "Piazza Venti
    Settembre", and nearest-by-distance alone matched several of them to an
    unrelated segment elsewhere on the same loop rather than a real twin
    (confirmed by checking direction: the bad matches ran in *the same*
    direction as their "partner", at a distance the curve just happened to
    bring them close at — not opposite directions of one corridor). That
    produced a wide/narrow/wide alternation following the loop around,
    exactly the "large roads that become narrow" symptom. `_way_direction`'s
    ANTIPARALLEL_DOT_MAX filters to only the ways actually running opposite
    the candidate, which is what a genuine divided-road twin does and a
    same-loop neighbour usually doesn't.
    """
    lanes = parse_numeric_tag(_tag_column(streets, "lanes"))
    class_default = streets.get("highway", pd.Series(index=streets.index)).map(STREET_WIDTH_DEFAULTS_M).fillna(6.0)
    is_oneway = _tag_column(streets, "oneway").astype(str).str.lower().eq("yes")
    fallback = class_default.where(~is_oneway, class_default / 2)
    width = (lanes * LANE_WIDTH_M).fillna(fallback)

    projected = gpd.GeoSeries(streets.geometry, crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    for i, j in _carriageway_pairs(streets, projected):
        width[i] = max(width[i], projected[i].distance(projected[j]) + CARRIAGEWAY_OVERLAP_MARGIN_M)

    return width


def fetch_streets(polygon: BaseGeometry) -> gpd.GeoDataFrame:
    try:
        streets = ox.features_from_polygon(polygon, tags={"highway": STREET_HIGHWAY_TAGS})
    except ox._errors.InsufficientResponseError:
        return gpd.GeoDataFrame(
            columns=["geometry", "width", "name", "oneway", "highway", "lanes", "lanes_forward", "lanes_backward"]
        )
    streets = streets[streets.geometry.type.isin(["LineString", "MultiLineString"])].reset_index()
    streets["width"] = street_widths(streets)
    # Carried through (not just used internally by street_widths) so
    # build_baseline.py can re-run `_carriageway_pairs` and lay out per-lane
    # markings (see road_markings.lane_marking_lines) on this same dataframe,
    # without a second OSM fetch.
    streets["name"] = _tag_column(streets, "name")
    streets["oneway"] = _tag_column(streets, "oneway")
    streets["highway"] = _tag_column(streets, "highway")
    streets["lanes"] = parse_numeric_tag(_tag_column(streets, "lanes"))
    streets["lanes_forward"] = parse_numeric_tag(_tag_column(streets, "lanes:forward"))
    streets["lanes_backward"] = parse_numeric_tag(_tag_column(streets, "lanes:backward"))
    return streets[["geometry", "width", "name", "oneway", "highway", "lanes", "lanes_forward", "lanes_backward"]]


def fetch_crossing_footways(polygon: BaseGeometry) -> gpd.GeoDataFrame:
    """The pedestrian path's own line across the road at a crossing
    (`footway=crossing`), distinct from the `highway=crossing` *node* fetched
    by `fetch_points` — this is what gives a crossing a real orientation to
    draw zebra stripes along (see build_baseline.py)."""
    try:
        footways = ox.features_from_polygon(polygon, tags={"footway": "crossing"})
    except ox._errors.InsufficientResponseError:
        return gpd.GeoDataFrame(columns=["geometry"])
    footways = footways[footways.geometry.type.isin(["LineString", "MultiLineString"])].reset_index()
    return footways[["geometry"]]


def fetch_points(polygon: BaseGeometry, tags: dict) -> gpd.GeoDataFrame:
    try:
        points = ox.features_from_polygon(polygon, tags=tags)
    except ox._errors.InsufficientResponseError:
        return gpd.GeoDataFrame(columns=["geometry"])
    return points[points.geometry.type == "Point"].reset_index()


def geometry_to_geojson(geom: BaseGeometry) -> dict:
    return mapping(geom)


def geojson_to_geometry(geojson: dict) -> BaseGeometry:
    return shape(geojson)
