"""One-off script: fetch OSM data for the active site (see sites.py;
CIVIC_ENGAGEMENT_SITE selects it) and write its baseline JSON. Re-run whenever the site
or fetch logic changes.

    uv run python -m bologna_civic_dt.ingestion.build_baseline
    CIVIC_ENGAGEMENT_SITE=piazza_xx_settembre uv run python -m bologna_civic_dt.ingestion.build_baseline
"""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import substring, unary_union

from bologna_civic_dt.sites import SITE
from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from bologna_civic_dt.trees import (
    assign_baseline_species,
    assign_baseline_tree_identity,
    height_to_canopy_ratio,
    species_traits,
)
from civic_engagement.geo_utils import to_projected
from civic_engagement.ingestion.lidar import LidarHeightModel
from civic_engagement.ingestion.ortofoto import OrtofotoModel
from bologna_civic_dt.ingestion.osm import (
    _carriageway_pairs,
    buffer_polygon_m,
    fetch_buildings,
    fetch_cover_regions,
    fetch_crossing_footways,
    fetch_paths,
    fetch_points,
    fetch_streets,
    geojson_to_geometry,
    geometry_to_geojson,
)
from bologna_civic_dt.ingestion.road_markings import (
    CROSSING_STRIPE_DASH_M,
    CROSSING_STRIPE_GAP_M,
    CROSSING_STRIPE_LEN_M,
    CROSSING_STRIPE_WIDTH_M,
    LANE_DIVIDER_DASH_M,
    LANE_DIVIDER_GAP_M,
    LANE_DIVIDER_WIDTH_M,
    as_lines,
    dashed_segments,
    lane_marking_lines,
)
from civic_engagement.models.schema import BaselineScene, CoverPolygon, DiscreteElement


# Which cover wins where two OSM regions claim the same ground. Ordered from
# most to least specific: a pond mapped inside a park is a pond, and the park
# polygon around it is the thing that should give way.
COVER_PRIORITY = ["water", "wood", "meadow", "lawn", "gravel", "permeable_paving", "paving"]

# Maps a real OSM `genus` tag (lowercased) onto our SPECIES_GROWTH keys. Only
# covers genera actually observed in this site's OSM data plus their obvious
# relatives — anything else falls back to "unknown" rather than guessing.
OSM_GENUS_ALIASES = {
    "platanus": "plane",
    "ulmus": "elm",
    "ginkgo": "ginkgo",
    "quercus": "oak",
    "betula": "birch",
    "tilia": "linden",
    "aesculus": "horse_chestnut",
    "cupressus": "cypress",
    "pinus": "pine",
}


# A `highway=crossing` node's matched `footway=crossing` way (its own
# digitized line across the road) is usually mapped right at the node, but
# not always exactly coincident — this bounds how far away a candidate way
# can still count as "the same crossing" rather than an unrelated footway.
CROSSING_FOOTWAY_MAX_DIST_M = 8.0
# How far a crossing node may sit from the on-road piece of its footway that
# gets striped — nodes are mapped on the road centreline, so anything further
# is a piece belonging to a different carriageway.
CROSSING_ON_ROAD_MAX_DIST_M = 3.0

# Gaps narrower than twice this between street ribbons are treated as road
# (see road_surface_m in build()).
ROAD_SURFACE_GAP_CLOSE_M = 2.0

# Along one crosswalk, on-road pieces separated by less than this are joined
# into a single zebra. A crosswalk often spans two same-direction one-way
# ways mapped a few metres apart (e.g. Piazza Dante's secondary + tertiary in
# front of the station, 4m apart at true scale) that the 2D map draws as one
# road; a gap wider than this is a real island or bus platform and still
# breaks the zebra.
CROSSING_MAX_GAP_M = 6.0



def _tag_or_none(value) -> str | None:
    """An OSM tag value as a plain string, or None where the way lacks it."""
    return None if value is None or (isinstance(value, float) and pd.isna(value)) else str(value)


def _int_or_none(value) -> int | None:
    return None if value is None or pd.isna(value) else int(value)

def _crosswalk_spans(line_m: LineString, road_surface_m) -> list[tuple[float, float]]:
    """Distance intervals (along `line_m`) where a crosswalk crosses asphalt,
    with gaps under CROSSING_MAX_GAP_M joined. Shared by the zebra stripes and
    by trimming the crosswalk's own path ribbon, so the two always agree on
    where the road is."""
    intervals = sorted(
        tuple(sorted((line_m.project(Point(p.coords[0])), line_m.project(Point(p.coords[-1])))))
        for p in as_lines(line_m.intersection(road_surface_m))
    )
    merged: list[list[float]] = []
    for start, end in intervals:
        if merged and start - merged[-1][1] < CROSSING_MAX_GAP_M:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(a, b) for a, b in merged if b > a]

CARRIAGEWAY_MIDLINE_SAMPLES = 20


def _carriageway_midline(line_i: LineString, line_j: LineString, samples: int = CARRIAGEWAY_MIDLINE_SAMPLES) -> LineString:
    """Midline between a bridged carriageway pair's two digitized
    centrelines, to draw the divider line separating them. A plain geometric
    average at each of `samples` evenly-spaced points along `line_i` (each
    paired with its nearest point on `line_j`) — robust to a non-parallel
    curving pair (see osm.py's street_widths docstring on Bologna's forecourt
    loop) and needs no "which side is the partner on" logic the way an
    `offset_curve` approach would.
    """
    points = []
    for k in range(samples):
        point_i = line_i.interpolate(k / (samples - 1), normalized=True)
        point_j = line_j.interpolate(line_j.project(point_i))
        points.append(((point_i.x + point_j.x) / 2, (point_i.y + point_j.y) / 2))
    return LineString(points)


def _by_cover_priority(covers_raw):
    return sorted(
        covers_raw.iterrows(),
        key=lambda item: (
            COVER_PRIORITY.index(item[1].cover_type)
            if item[1].cover_type in COVER_PRIORITY
            else len(COVER_PRIORITY)
        ),
    )


def _polygonal(geom):
    """Keeps only the polygonal part of a geometry, or None if there is none.

    Clipping one polygon against another routinely yields a GeometryCollection
    with stray lines and points where the boundaries touch, and those are not
    valid ground cover.
    """
    if geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        parts = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not parts:
            return None
        merged = unary_union(parts)
        return None if merged.is_empty else merged
    return None


def build() -> BaselineScene:
    site_polygon = geojson_to_geometry(SITE.site_boundary_geojson)
    fetch_area = buffer_polygon_m(site_polygon, SITE.building_fetch_buffer_m)

    lidar = LidarHeightModel.load()
    if lidar is None:
        print(f"No LiDAR data under {SITE.data_dir}/lidar/ — building heights/roof shapes will be OSM-tags-only.")
    ortofoto = OrtofotoModel.load()
    if ortofoto is None:
        print(f"No orthophoto under {SITE.data_dir}/ortofoto/ — roofs will have no colour tint.")

    print("Fetching buildings...")
    buildings = fetch_buildings(fetch_area, SITE.default_building_height_m)
    print("Fetching cover regions...")
    covers_raw = fetch_cover_regions(site_polygon)
    print("Fetching paths...")
    paths = fetch_paths(fetch_area)
    print("Fetching streets...")
    streets = fetch_streets(fetch_area)
    print("Fetching trees...")
    trees = fetch_points(fetch_area, {"natural": "tree"})

    # Drop trees that land inside a building footprint or a water body — OSM
    # digitises tree points and area boundaries independently, and the two
    # occasionally disagree (a tree ends up rendered floating inside the
    # pond). A genuine mid-pond/mid-building tree isn't a plausible real
    # position, so these are dropped rather than nudged to a guessed spot.
    exclusion_parts = [to_projected(geometry_to_geojson(g)) for g in buildings.geometry]
    exclusion_parts += [
        to_projected(geometry_to_geojson(row.geometry))
        for _, row in covers_raw.iterrows()
        if row.cover_type == "water"
    ]
    if exclusion_parts and len(trees) > 0:
        exclusion_zone = unary_union(exclusion_parts)
        inside = trees.geometry.apply(lambda pt: to_projected(geometry_to_geojson(pt)).within(exclusion_zone))
        if inside.any():
            print(f"Dropping {int(inside.sum())} tree(s) inside a building/water footprint")
        trees = trees[~inside]

    print("Fetching benches...")
    benches = fetch_points(fetch_area, {"amenity": "bench"})
    print("Fetching water features...")
    water_features = fetch_points(fetch_area, {"amenity": "fountain"})
    print("Fetching streetlights...")
    streetlights = fetch_points(fetch_area, {"highway": "street_lamp"})
    print("Fetching crossings...")
    crossings = fetch_points(fetch_area, {"highway": "crossing"})
    print("Fetching crossing footways...")
    footway_crossings = fetch_crossing_footways(fetch_area)
    print("Fetching traffic signals...")
    traffic_signals = fetch_points(fetch_area, {"highway": "traffic_signals"})

    elements: list[DiscreteElement] = []

    for i, row in buildings.iterrows():
        height = float(row.height)
        # Real tag always wins over anything inferred below.
        roof_shape = str(row.roof_shape) if pd.notna(row.roof_shape) else None
        ridge_height_m = None

        polygon_utm = to_projected(geometry_to_geojson(row.geometry)) if (lidar or ortofoto) else None
        stats = lidar.sample(polygon_utm) if lidar else None
        if stats is not None:
            # p90 always, flat or pitched: robust to a chimney/antenna/
            # parapet pulling the true max up past what a facilitator would
            # call the building's height. See config.SITE.roof_min_rise_m for why
            # the roof's rise above this is clamped rather than taken as
            # `max - p90` directly.
            height = stats.height_p90
            if roof_shape is None:
                # See config.SITE.roof_pitch_std_threshold_m: a real signal, with a
                # known false-positive mode (flat roof + heavy rooftop plant)
                # accepted as a PoC-level limit rather than built around.
                roof_shape = "pitched" if stats.height_std > SITE.roof_pitch_std_threshold_m else "flat"
            if roof_shape != "flat":
                rise = min(max(stats.height_max - height, SITE.roof_min_rise_m), SITE.roof_max_rise_m)
                ridge_height_m = round(height + rise, 1)

        properties: dict = {"height": round(height, 1)}
        # Only emitted when actually known (tagged or inferred) — the 3D view
        # falls back to a flat roof / generic facade rather than inventing a
        # value here.
        if roof_shape is not None:
            properties["roof_shape"] = roof_shape
        if ridge_height_m is not None:
            properties["ridge_height_m"] = ridge_height_m
        if pd.notna(row.building_kind):
            properties["building_kind"] = str(row.building_kind)
        if ortofoto and polygon_utm is not None:
            rgb = ortofoto.sample_roof_rgb(polygon_utm)
            if rgb is not None:
                properties["roof_color"] = "#%02x%02x%02x" % rgb

        elements.append(DiscreteElement(
            id=f"building-{i}", type="building", source="baseline",
            geometry=geometry_to_geojson(row.geometry),
            properties=properties,
        ))

    for i, row in trees.iterrows():
        # `or` doesn't work here: a NaN float is truthy, so `nan or fallback`
        # would still return the NaN instead of falling through.
        species_raw = row.get("genus")
        if pd.isna(species_raw):
            species_raw = row.get("species")
        tree_id = f"tree-{i}"
        if pd.isna(species_raw):
            # No usable OSM tag (the overwhelming majority of trees) — draw a
            # plausible species instead of leaving it "unknown", so the plaza
            # gets real visual variety. See growth.TRENTO_SPECIES_WEIGHTS.
            species = assign_baseline_species(tree_id)
        else:
            # OSM tags genus with a capitalized scientific name (e.g.
            # "Platanus", "Ginkgo") — normalize known genera onto our
            # lowercase SPECIES_GROWTH keys so they actually hit the growth/
            # foliage tables instead of silently falling back to "unknown".
            species = OSM_GENUS_ALIASES.get(str(species_raw).strip().lower(), "unknown")

        # Identity (age class, current size, guessed cut year) is assigned
        # once here, offline, and baked into the baseline JSON — never
        # recomputed or edited live (see bologna_civic_dt/trees.py).
        identity = assign_baseline_tree_identity(tree_id=tree_id, species=species)
        elements.append(DiscreteElement(
            id=tree_id, type="tree", source="baseline",
            geometry=geometry_to_geojson(row.geometry),
            properties={
                "species": species,
                "age_class": identity["age_class"],
                "canopy_diameter": identity["canopy_diameter"],
                "height": round(identity["canopy_diameter"] * height_to_canopy_ratio(species), 2),
                "cut_year": identity["cut_year"],
                **species_traits(species),
            },
        ))

    for i, row in benches.iterrows():
        elements.append(DiscreteElement(
            id=f"bench-{i}", type="bench", source="baseline",
            geometry=geometry_to_geojson(row.geometry), properties={},
        ))

    for i, row in water_features.iterrows():
        elements.append(DiscreteElement(
            id=f"water_feature-{i}", type="water_feature", source="baseline",
            geometry=geometry_to_geojson(row.geometry), properties={},
        ))

    for i, row in streetlights.iterrows():
        elements.append(DiscreteElement(
            id=f"streetlight-{i}", type="streetlight", source="baseline",
            geometry=geometry_to_geojson(row.geometry), properties={},
        ))

    # The road surface as drawn: every street ribbon at its rendered width.
    # Small gaps between adjacent ribbons (two carriageways a metre or two
    # apart that aren't bridged — see osm.street_widths) are closed, since
    # the map reads them as one continuous road; a real traffic island is
    # wider than ROAD_SURFACE_GAP_CLOSE_M * 2 and survives. Used to clip
    # crosswalks (see below) to where they actually cross asphalt.
    streets_m = gpd.GeoSeries(streets.geometry, crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    road_surface_m = unary_union([
        streets_m[k].buffer(float(streets.width[k]) / 2) for k in streets.index if pd.notna(streets.width[k])
    ]).buffer(ROAD_SURFACE_GAP_CLOSE_M).buffer(-ROAD_SURFACE_GAP_CLOSE_M)

    for i, row in paths.iterrows():
        geometry = row.geometry
        if row.footway == "crossing":
            # A crosswalk's on-road part is drawn as zebra stripes (the
            # `crossing` elements below); drawing it as a path too laid an
            # opaque paving strip right over the stripes. Only its sidewalk
            # ends stay a path.
            off_road_m = []
            for path_line_m in as_lines(gpd.GeoSeries([geometry], crs=WGS84_CRS).to_crs(PROJECTED_CRS).iloc[0]):
                cursor = 0.0
                for start, end in _crosswalk_spans(path_line_m, road_surface_m) + [(path_line_m.length, None)]:
                    if start > cursor:
                        off_road_m.append(substring(path_line_m, cursor, start))
                    if end is not None:
                        cursor = end
            off_road_m = [line for line in off_road_m if line.length > 0]
            if not off_road_m:
                continue
            geometry = gpd.GeoSeries([MultiLineString(off_road_m)], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0]
        elements.append(DiscreteElement(
            id=f"path-{i}", type="path", source="baseline",
            geometry=geometry_to_geojson(geometry),
            properties={"width": float(row.width), "material": row.material},
        ))

    for i, row in streets.iterrows():
        elements.append(DiscreteElement(
            id=f"street-{i}", type="street", source="baseline",
            geometry=geometry_to_geojson(row.geometry),
            # `material: "asphalt"` isn't cosmetic here — it's what lets the
            # 3D view's `buildPaths` (which every other LineString element
            # already goes through, keyed on this exact property) render
            # streets for free with the right surface, no separate builder.
            properties={
                "width": float(row.width),
                "material": "asphalt",
                # Traffic direction and class, for the cars in the 3D view
                # (frontend/src/three/people/traffic.ts): OSM `oneway`
                # ("yes", "-1" = against the drawing direction, or absent)
                # and `highway` (service roads get less traffic).
                "highway": _tag_or_none(row.highway),
                "oneway": _tag_or_none(row.oneway),
                "lanes": _int_or_none(row.lanes),
                "lanes_forward": _int_or_none(row.lanes_forward),
                "lanes_backward": _int_or_none(row.lanes_backward),
            },
        ))

    # One divider-line element per bridged carriageway pair (reusing the same
    # pairing `street_widths` already computed inside `fetch_streets`, per
    # `_carriageway_pairs`'s docstring) — the white line down the middle that
    # was missing since the widened ribbons started overlapping into one
    # solid mass with no visible seam.
    # Solid where opposite directions meet, dashed between same-direction
    # lanes (see road_markings.lane_marking_lines) — an experiment the
    # facilitator asked to try; easy to collapse back to one style.
    def add_lane_divider(element_id: str, lines_m: list[LineString], style: str) -> None:
        if style == "dashed":
            lines_m = [d for line in lines_m for d in dashed_segments(line, LANE_DIVIDER_DASH_M, LANE_DIVIDER_GAP_M)]
        if not lines_m:
            return
        geometry_wgs84 = gpd.GeoSeries([MultiLineString(lines_m)], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0]
        elements.append(DiscreteElement(
            id=element_id, type="lane_divider", source="baseline",
            geometry=geometry_to_geojson(geometry_wgs84),
            properties={"width": LANE_DIVIDER_WIDTH_M, "material": "lane_divider", "style": style},
        ))

    seen_carriageway_pairs = set()
    for i, j in _carriageway_pairs(streets, streets_m):
        pair_key = frozenset((i, j))
        if pair_key in seen_carriageway_pairs:
            continue
        seen_carriageway_pairs.add(pair_key)
        add_lane_divider(f"lane_divider-{i}-{j}", [_carriageway_midline(streets_m[i], streets_m[j])], "solid")

    for i, row in streets.iterrows():
        solid_m, dashed_m = lane_marking_lines(
            streets_m[i],
            lanes=row.lanes if pd.notna(row.lanes) else None,
            oneway=str(row.oneway).lower() == "yes",
            lanes_forward=row.lanes_forward if pd.notna(row.lanes_forward) else None,
            lanes_backward=row.lanes_backward if pd.notna(row.lanes_backward) else None,
            highway=row.highway if pd.notna(row.highway) else None,
        )
        add_lane_divider(f"lane_divider-{i}-solid", solid_m, "solid")
        add_lane_divider(f"lane_divider-{i}-dashed", dashed_m, "dashed")

    # Real zebra stripes need the crossing's own orientation, which only its
    # matched `footway=crossing` way (the pedestrian path's own line across
    # the road) carries — the `highway=crossing` node itself is just a point.
    # Not every crossing has a matched way; one without a match is dropped
    # rather than kept as a vague, unoriented marker (same "degrade by
    # omission, not by faking it" stance as the optional LiDAR/orthophoto
    # inputs above and Bologna's unmapped benches).
    #
    # The matched way is clipped to the road surface first: a mapped
    # footway=crossing routinely runs on across sidewalks and traffic islands,
    # or spans several carriageways each with its own crossing node, and
    # striping the whole line put paint on pavements and stacked one set of
    # stripes per node on the same line (Bologna's bus forecourt especially).
    # Each node keeps only the on-road piece nearest it, once.
    crossings_m = gpd.GeoSeries(crossings.geometry, crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    footways_m = gpd.GeoSeries(footway_crossings.geometry, crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    dropped_unmatched = dropped_off_road = dropped_duplicate = 0
    striped_pieces: set[tuple] = set()
    for i, row in crossings.iterrows():
        # Stored now (not just rendered) so the deferred walkability-indicator
        # work doesn't need a second ingestion pass — see the accessibility
        # indicator in bologna_civic_dt/model.py.
        crossing_type = row.get("crossing")

        if len(footways_m) == 0:
            dropped_unmatched += 1
            continue
        distances = footways_m.distance(crossings_m[i])
        nearest = distances.idxmin()
        if distances[nearest] > CROSSING_FOOTWAY_MAX_DIST_M:
            dropped_unmatched += 1
            continue

        footway_m = footways_m[nearest]
        on_road = [substring(footway_m, a, b) for a, b in _crosswalk_spans(footway_m, road_surface_m)]
        if not on_road:
            dropped_off_road += 1
            continue
        piece = min(on_road, key=lambda line: line.distance(crossings_m[i]))
        if piece.distance(crossings_m[i]) > CROSSING_ON_ROAD_MAX_DIST_M:
            dropped_off_road += 1
            continue
        piece_key = (nearest, tuple(round(c, 1) for c in piece.bounds))
        if piece_key in striped_pieces:
            dropped_duplicate += 1
            continue
        striped_pieces.add(piece_key)

        stripes_m = dashed_segments(
            piece, CROSSING_STRIPE_DASH_M, CROSSING_STRIPE_GAP_M,
            perpendicular_len_m=CROSSING_STRIPE_LEN_M,
        )
        if not stripes_m:
            dropped_off_road += 1
            continue
        geometry_wgs84 = gpd.GeoSeries([MultiLineString(stripes_m)], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0]
        elements.append(DiscreteElement(
            id=f"crossing-{i}", type="crossing", source="baseline",
            geometry=geometry_to_geojson(geometry_wgs84),
            properties={
                "width": CROSSING_STRIPE_WIDTH_M,
                "material": "crossing_marking",
                "crossing_type": crossing_type if pd.notna(crossing_type) else "unmarked",
            },
        ))
    if dropped_unmatched or dropped_off_road or dropped_duplicate:
        print(
            f"Crossings dropped: {dropped_unmatched} with no footway=crossing way within "
            f"{CROSSING_FOOTWAY_MAX_DIST_M}m, {dropped_off_road} with none of it on a street, "
            f"{dropped_duplicate} sharing an already-striped piece with another crossing node"
        )

    for i, row in traffic_signals.iterrows():
        elements.append(DiscreteElement(
            id=f"traffic_signal-{i}", type="traffic_signal", source="baseline",
            geometry=geometry_to_geojson(row.geometry), properties={},
        ))

    # Clip cover regions to the site boundary and against each other, then fill
    # whatever's left with a synthetic "paving" region — OSM rarely tags the
    # plaza surface itself, so without this the cover layer would leave most of
    # the square uncovered. The leftover fill's own clip boundary is
    # `fetch_area`, not `site_polygon`, for a provisional site (see
    # SITE.boundary_status): the 3D ground mesh is built entirely from cover
    # polygons (see three/builders/ground.ts, which has no fallback plane), so
    # clipping tightly to Bologna's placeholder ~45m circle left every
    # building/street/tree beyond it floating over bare ground, and made the
    # circle's own edge a stark, artificial-looking line cutting across real
    # streets in the middle of the default view. Clipping to fetch_area
    # instead pushes that edge out to match everything else that's actually
    # fetched and rendered. Indicators are unaffected either way — they
    # independently re-clip every cover to the true site_boundary for their
    # percentages (see the space use in bologna_civic_dt/geometry.py's cover_areas). A
    # surveyed site's boundary is real, trustworthy plaza data, so its
    # leftover fill stays tightly clipped to it, unchanged.
    ground_fill_boundary = fetch_area if SITE.boundary_status == "provisional" else site_polygon
    covers: list[CoverPolygon] = []
    claimed = None
    for i, row in _by_cover_priority(covers_raw):
        clipped = _polygonal(row.geometry.intersection(site_polygon))
        if clipped is None:
            continue
        # Subtracting what higher-priority covers already took makes the layer
        # a genuine partition of the site. OSM double-tags ground constantly
        # (a pond mapped inside a park, a garden overlapping a leisure area):
        # left overlapping, the polygons summed to 54,745 m2 on a 41,019 m2
        # site, and coplanar duplicates meant the 3D view had to guess whether
        # to draw lawn or water on the same patch of ground.
        if claimed is not None:
            clipped = _polygonal(clipped.difference(claimed))
            if clipped is None:
                continue
        covers.append(CoverPolygon(
            id=f"cover-{i}", cover_type=row.cover_type, source="baseline",
            geometry=geometry_to_geojson(clipped),
        ))
        claimed = clipped if claimed is None else unary_union([claimed, clipped])

    leftover = ground_fill_boundary if claimed is None else ground_fill_boundary.difference(claimed)
    leftover = _polygonal(leftover)
    if leftover is not None:
        covers.append(CoverPolygon(
            id="cover-paving-leftover", cover_type="paving", source="baseline",
            geometry=geometry_to_geojson(leftover),
        ))

    return BaselineScene(
        site_boundary=SITE.site_boundary_geojson,
        elements=elements,
        covers=covers,
    )


def main() -> None:
    from bologna_civic_dt.pack import UrbanPack
    from civic_engagement.domain import register

    register(UrbanPack())
    if SITE.boundary_status == "provisional":
        print(f"WARNING: {SITE.name}'s site boundary is PROVISIONAL, not real digitized data — see sites.py.")
    scene = build()
    Path(SITE.baseline_json_path).parent.mkdir(parents=True, exist_ok=True)
    with open(SITE.baseline_json_path, "w") as f:
        json.dump(scene.model_dump(), f, indent=2)
    print(
        f"Wrote {SITE.baseline_json_path}: "
        f"{len(scene.elements)} elements, {len(scene.covers)} cover regions."
    )


if __name__ == "__main__":
    main()
