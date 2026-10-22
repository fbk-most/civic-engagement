"""Building elements from OSM footprints (civic_engagement/ingestion/buildings.py):
the height cascade, and a site's defaults for what the data doesn't say."""

import geopandas as gpd
from shapely.geometry import LineString, Point, box

from civic_engagement.ingestion.buildings import BuildingDefaults, building_elements, footprints

# About 1 m in degrees, near 46° N (longitude) and anywhere (latitude).
M_LNG = 1 / 77_300
M_LAT = 1 / 111_200


def _square(x_m: float, side_m: float):
    return box(11 + x_m * M_LNG, 46, 11 + (x_m + side_m) * M_LNG, 46 + side_m * M_LAT)


def _features(rows: list[dict]) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")


DEFAULTS = BuildingDefaults(
    height_m=7.0,
    level_height_m=3.0,
    kind_height_m={"church": 12.0},
    area_height_m=((25, 3.0), (80, 5.0)),
    roof_shape="gabled",
)


def test_footprints_keeps_the_polygons_numbered_from_zero():
    features = _features([
        {"geometry": Point(11, 46), "building": "yes"},
        {"geometry": _square(0, 10), "building": "yes"},
        {"geometry": LineString([(11, 46), (11.001, 46)]), "building": "yes"},
        {"geometry": _square(50, 10), "building": "yes"},
    ])
    assert list(footprints(features).index) == [0, 1]


def test_heights_from_tags_then_kind_then_area_then_default():
    buildings = footprints(_features([
        {"geometry": _square(0, 20), "building": "yes", "height": "15 m"},
        {"geometry": _square(50, 20), "building": "yes", "building:levels": "3", "roof:levels": "1"},
        {"geometry": _square(100, 20), "building": "church"},
        {"geometry": _square(150, 4), "building": "yes"},  # 16 m²: a hut
        {"geometry": _square(200, 8), "building": "yes"},  # 64 m²: a barn
        {"geometry": _square(250, 20), "building": "yes"},  # 400 m²
    ]))
    heights = [e.properties["height"] for e in building_elements(buildings, DEFAULTS)]
    assert heights == [15.0, 12.0, 12.0, 3.0, 5.0, 7.0]


def test_roof_from_tag_else_the_sites_default():
    buildings = footprints(_features([
        {"geometry": _square(0, 10), "building": "yes", "roof:shape": "hipped"},
        {"geometry": _square(50, 10), "building": "yes"},
    ]))
    elements = building_elements(buildings, DEFAULTS)
    assert [e.id for e in elements] == ["building-0", "building-1"]
    assert [e.properties["roof_shape"] for e in elements] == ["hipped", "gabled"]
    assert all(e.properties["building_kind"] == "yes" for e in elements)


def test_no_default_roof_means_flat():
    buildings = footprints(_features([{"geometry": _square(0, 10)}]))
    (element,) = building_elements(buildings, BuildingDefaults(height_m=10, level_height_m=3.2))
    assert element.properties == {"height": 10.0}


class _Lidar:
    """A LiDAR model whose every footprint reads `stats`."""

    def __init__(self, stats):
        self.stats = stats

    def sample(self, polygon_utm):
        return self.stats


def test_roof_samples_give_eave_ridge_and_a_missing_building_the_defaults():
    from civic_engagement.ingestion.lidar import BuildingLidarStats

    defaults = BuildingDefaults(height_m=7.0, level_height_m=3.0, roof_shape="gabled", roof_samples=True)
    buildings = footprints(_features([{"geometry": _square(0, 10), "building": "yes"}]))

    def read(**roof):
        stats = BuildingLidarStats(height_p90=9.0, height_max=10.0, height_std=3.0, **roof)
        (element,) = building_elements(buildings, defaults, _Lidar(stats))
        return element.properties

    # A pitched roof: eave and ridge from the roof's own samples.
    assert read(roof_share=0.8, roof_low=6.0, roof_high=9.5) == {
        "height": 6.0, "roof_shape": "gabled", "ridge_height_m": 9.5, "building_kind": "yes",
    }
    # A flat one: the ridge hardly above the eave.
    assert read(roof_share=0.8, roof_low=6.0, roof_high=6.5) == {"height": 6.5, "roof_shape": "flat", "building_kind": "yes"}
    # Hardly any roof in the LiDAR: not there (yet, or too small), the defaults.
    assert read(roof_share=0.1, roof_low=2.0, roof_high=2.4) == {"height": 7.0, "roof_shape": "gabled", "building_kind": "yes"}

    # Hardly any roof, over a large footprint: a mapping error, left out.
    large = footprints(_features([{"geometry": _square(0, 30), "building": "yes"}]))
    missing = BuildingLidarStats(height_p90=0.0, height_max=8.0, height_std=1.0, roof_share=0.1, roof_low=3.0, roof_high=7.0)
    assert building_elements(large, defaults, _Lidar(missing)) == []
