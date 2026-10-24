"""Buildings for a site's baseline: OpenStreetMap footprints, as osmnx
returns them (their tags as columns; the packs fetch them), to building
elements.

A building's height and roof come, in order of trust, from PAT's LiDAR
(lidar.py) when the site has it (with `roof_samples`, the roof's form
too: gabled or hipped, and its ridge's bearing), then from the footprint's
tags, then from the site's defaults (`BuildingDefaults`); its roof colour from the
orthophoto (ortofoto.py), when there is one; its walls' material from the
`building:material` tag (a pack may guess it where OSM has none).
"""

import math
from dataclasses import dataclass, field

import geopandas as gpd
import pandas as pd
from pyproj import Transformer
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from civic_engagement.geo_utils import to_projected
from civic_engagement.ingestion.lidar import LidarHeightModel
from civic_engagement.ingestion.ortofoto import OrtofotoModel
from civic_engagement.models.schema import DiscreteElement


@dataclass(frozen=True, kw_only=True)
class BuildingDefaults:
    """What a site assumes of a building its data says nothing about."""

    # The last resort, for a footprint with no height, storeys, known kind or
    # area rule.
    height_m: float
    # A storey's height, to turn OSM's `building:levels` into metres.
    level_height_m: float
    # Heights by the OSM `building` value, for footprints with neither
    # `height` nor `building:levels`.
    kind_height_m: dict[str, float] = field(default_factory=dict)
    # Heights by footprint area, before the last resort: (largest area in m²,
    # height), smallest first — a hut isn't as tall as a house.
    area_height_m: tuple[tuple[float, float], ...] = ()
    # The roof of a footprint with no `roof:shape` tag and no LiDAR to tell:
    # an OSM roof shape (see the 3D view's roofs.ts), or None for flat. Also
    # the shape of a roof LiDAR finds pitched ("pitched" without one).
    roof_shape: str | None = None
    # Above this, a building's LiDAR nDSM (surface-minus-terrain height)
    # varies too much across its own footprint to be a flat roof. A real
    # signal, with a known false positive (a flat roof under heavy rooftop
    # plant), accepted as a PoC-level limit.
    roof_pitch_std_threshold_m: float = 2.0
    # A pitched roof's rise (ridge above eave), from LiDAR, is clamped to this
    # range: `max - p90` alone is thrown by chimneys and antennas, and by
    # footprints that overlap a taller neighbour.
    roof_min_rise_m: float = 1.5
    roof_max_rise_m: float = 6.0
    # How LiDAR reads a building. False: the footprint's 90th percentile is
    # its height, the spread of its heights says whether its roof is pitched
    # (for a town's blocks, with courtyards inside the footprint). True: only
    # the roof's own samples count (see lidar.py's BuildingLidarStats): the
    # eave and the ridge a low and a high percentile of them, the roof
    # pitched if the ridge rises at least `roof_samples_pitch_m` above the
    # eave, and no building in the LiDAR (the defaults instead) if they're
    # less than `roof_samples_min_share` of the footprint (for detached
    # houses, barns and huts) — unless the footprint is larger than
    # `roof_samples_max_missing_m2`: then it's left out, as an OSM mapping
    # error (a whole compound drawn as one building, say) rather than a
    # building newer than the survey.
    roof_samples: bool = False
    roof_samples_pitch_m: float = 1.0
    roof_samples_min_share: float = 0.3
    roof_samples_max_missing_m2: float = 500.0


def parse_numeric_tag(raw: pd.Series) -> pd.Series:
    """Parse a loosely-formatted OSM numeric tag (e.g. "12", "12 m") into
    floats, leaving anything absent or unparseable as NaN so callers can fall
    through to the next source in their own precedence chain."""
    extracted = raw.astype(str).str.extract(r"(\d+(?:\.\d+)?)")[0]
    return pd.to_numeric(extracted, errors="coerce")


def tag_column(df: gpd.GeoDataFrame, name: str) -> pd.Series:
    """OSM tag columns only exist when at least one fetched feature carries the
    tag, so every read has to tolerate the column being absent entirely."""
    if name in df.columns:
        return df[name]
    return pd.Series(index=df.index, dtype=object)


def footprints(features: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """The polygons among OSM features (osmnx also returns the nodes and
    lines tagged `building`), numbered from 0."""
    return features[features.geometry.type.isin(["Polygon", "MultiPolygon"])].reset_index()


def building_heights(buildings: gpd.GeoDataFrame, defaults: BuildingDefaults) -> pd.Series:
    """Resolve a height in metres for every footprint, in descending order of
    trustworthiness: an explicit `height` tag, then storey count
    (`building:levels` plus any habitable `roof:levels`) times a nominal storey
    height, then a guess keyed on the `building` kind, then on the footprint's
    area, then the default.
    """
    explicit = parse_numeric_tag(tag_column(buildings, "height"))
    levels = parse_numeric_tag(tag_column(buildings, "building:levels"))
    roof_levels = parse_numeric_tag(tag_column(buildings, "roof:levels")).fillna(0)
    from_levels = (levels + roof_levels) * defaults.level_height_m
    from_kind = pd.to_numeric(tag_column(buildings, "building").map(defaults.kind_height_m), errors="coerce")
    heights = explicit.fillna(from_levels).fillna(from_kind)
    if defaults.area_height_m:
        areas = buildings.geometry.to_crs(PROJECTED_CRS).area
        from_area = pd.Series(float("nan"), index=buildings.index)
        for largest_m2, height in reversed(defaults.area_height_m):
            from_area[areas <= largest_m2] = height
        heights = heights.fillna(from_area)
    return heights.fillna(defaults.height_m)


_TO_WGS84 = Transformer.from_crs(PROJECTED_CRS, WGS84_CRS, always_xy=True)


def ridge_bearing_deg(polygon_utm: BaseGeometry, ridge: tuple[float, float]) -> float:
    """A ridge's direction (a unit vector in UTM) as a bearing, degrees
    clockwise from true north, in [0, 180): UTM's north is a degree or so off
    true north away from the zone's central meridian."""
    centre = polygon_utm.centroid
    lng0, lat0 = _TO_WGS84.transform(centre.x, centre.y)
    lng1, lat1 = _TO_WGS84.transform(centre.x + ridge[0], centre.y + ridge[1])
    east = (lng1 - lng0) * math.cos(math.radians(lat0))
    return round(math.degrees(math.atan2(east, lat1 - lat0)) % 180, 1)


def building_elements(
    buildings: gpd.GeoDataFrame,
    defaults: BuildingDefaults,
    lidar: LidarHeightModel | None = None,
    ortofoto: OrtofotoModel | None = None,
) -> list[DiscreteElement]:
    """The footprints (see `footprints`) as building elements, `building-<n>`
    by their row."""
    heights = building_heights(buildings, defaults)
    roof_shapes = tag_column(buildings, "roof:shape")
    kinds = tag_column(buildings, "building")
    wall_materials = tag_column(buildings, "building:material")
    elements = []
    for i, geometry in buildings.geometry.items():
        height = float(heights[i])
        # Real tag always wins over anything inferred below.
        roof_shape = str(roof_shapes[i]) if pd.notna(roof_shapes[i]) else None
        ridge_height_m = None
        ridge_bearing = None

        geojson = mapping(geometry)
        polygon_utm = to_projected(geojson) if (lidar or ortofoto) else None
        stats = lidar.sample(polygon_utm) if lidar else None
        if stats is not None and defaults.roof_samples and stats.roof_share < defaults.roof_samples_min_share:
            if polygon_utm.area > defaults.roof_samples_max_missing_m2:
                print(f"building-{i}: {polygon_utm.area:.0f} m², but {stats.roof_share:.0%} of it a roof in the LiDAR: left out")
                continue
            stats = None
        # Pitched: the site's own pitched shape, if it has one.
        pitched = defaults.roof_shape if defaults.roof_shape not in (None, "flat") else "pitched"
        if stats is not None and defaults.roof_samples:
            rise = stats.roof_high - stats.roof_low
            if rise >= defaults.roof_samples_pitch_m:
                height = stats.roof_low
                form = lidar.roof_form(polygon_utm)
                if form is not None:
                    roof_shape = roof_shape or ("hipped" if form.shape == "hipped" else pitched)
                    # A hip's ridge is along the long side; a gable's either way.
                    if (roof_shape == "hipped") == (form.shape == "hipped"):
                        ridge_bearing = ridge_bearing_deg(polygon_utm, form.ridge)
                roof_shape = roof_shape or pitched
                rise = min(max(rise, defaults.roof_min_rise_m), defaults.roof_max_rise_m)
                ridge_height_m = round(height + rise, 1)
            else:
                height = stats.roof_high
                roof_shape = roof_shape or "flat"
        elif stats is not None:
            # p90 always, flat or pitched: robust to a chimney/antenna/
            # parapet pulling the true max up past what a facilitator would
            # call the building's height. The roof's rise above it is clamped
            # rather than taken as `max - p90` directly (see BuildingDefaults).
            height = stats.height_p90
            if roof_shape is None:
                roof_shape = pitched if stats.height_std > defaults.roof_pitch_std_threshold_m else "flat"
            if roof_shape != "flat":
                rise = min(max(stats.height_max - height, defaults.roof_min_rise_m), defaults.roof_max_rise_m)
                ridge_height_m = round(height + rise, 1)
        if roof_shape is None:
            roof_shape = defaults.roof_shape

        properties: dict = {"height": round(height, 1)}
        # Only emitted when actually known (tagged, inferred or the site's
        # default): the 3D view falls back to a flat roof / generic facade
        # rather than inventing a value here.
        if roof_shape is not None:
            properties["roof_shape"] = roof_shape
        if ridge_height_m is not None:
            properties["ridge_height_m"] = ridge_height_m
        if ridge_bearing is not None:
            properties["ridge_bearing_deg"] = ridge_bearing
        if pd.notna(kinds[i]):
            properties["building_kind"] = str(kinds[i])
        if pd.notna(wall_materials[i]):
            properties["wall_material"] = str(wall_materials[i])
        if ortofoto and polygon_utm is not None:
            rgb = ortofoto.sample_roof_rgb(polygon_utm)
            if rgb is not None:
                properties["roof_color"] = "#%02x%02x%02x" % rgb

        elements.append(DiscreteElement(
            id=f"building-{i}", type="building", source="baseline",
            geometry=geojson,
            properties=properties,
        ))
    return elements
