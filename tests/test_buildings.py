"""Building elements from OSM footprints (civic_engagement/ingestion/buildings.py):
the height cascade, and a site's defaults for what the data doesn't say."""

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, Point, box

from civic_engagement.ingestion.buildings import BuildingDefaults, building_elements, footprints
from civic_engagement.ingestion.lidar import LidarHeightModel, RoofForm
from civic_engagement.ingestion.raster import Grid

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

    def roof_form(self, polygon_utm):
        return None


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


def _roof_model(roof) -> LidarHeightModel:
    """A LiDAR model over a 40 m square at 0.5 m: flat ground at 100 m, and
    the building's surface `roof(x, y)` metres above it (x, y from the
    square's centre)."""
    centres = (np.arange(80) + 0.5) * 0.5 - 20
    x, y = np.meshgrid(centres, -centres)
    dtm = np.full((80, 80), 100.0)
    return LidarHeightModel(Grid(-20, 20, 0.5, 0.5, dtm + roof(x, y)), Grid(-20, 20, 0.5, 0.5, dtm))


def test_roof_form_tells_a_gable_s_ridge_and_a_hip():
    # 12 m east-west by 8 m: eaves at 5 m, the ridge 3 m above them.
    footprint = box(-6, -4, 6, 4)
    along = _roof_model(lambda x, y: 8 - 0.75 * np.abs(y))  # ridge east-west
    across = _roof_model(lambda x, y: 8 - 0.5 * np.abs(x))  # ridge north-south
    hipped = _roof_model(lambda x, y: 8 - 0.75 * np.maximum(np.abs(y), np.abs(x) - 2))

    def ridge_east_west(form: RoofForm) -> bool:
        return abs(form.ridge[0]) > 0.99

    form = along.roof_form(footprint)
    assert form.shape == "gabled" and ridge_east_west(form)
    form = across.roof_form(footprint)
    assert form.shape == "gabled" and not ridge_east_west(form)
    form = hipped.roof_form(footprint)
    assert form.shape == "hipped" and ridge_east_west(form)
