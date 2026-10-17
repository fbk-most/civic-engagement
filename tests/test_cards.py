"""Cards that place several elements at once."""

import geopandas as gpd
import pytest
from shapely.geometry import LineString, mapping

from civic_engagement import scene
from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from bologna_civic_dt.layout import build_layout
from bologna_civic_dt.parameters import COST_PER_ELEMENT_EUR
from civic_engagement.geo_utils import to_projected
from civic_engagement.models.schema import Intervention


def _line(length_m: float, dx: float = 0.0, dy: float = 0.0) -> dict:
    c = to_projected(scene.load_baseline().site_boundary).representative_point()
    line = LineString([(c.x + dx - length_m / 2, c.y + dy), (c.x + dx + length_m / 2, c.y + dy)])
    return mapping(gpd.GeoSeries([line], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0])


def _lit_path(length_m: float, spacing_m: float) -> Intervention:
    return Intervention(
        id="lit", card_type="add_streetlight_path", geometry=_line(length_m), params={"spacing": spacing_m},
        created_at="2026-10-15T00:00:00+00:00", planted_year=2,
    )


def _tree_row(length_m: float, spacing_m: float, dx: float = 0.0, dy: float = 0.0) -> Intervention:
    return Intervention(
        id="row", card_type="plant_tree_row", geometry=_line(length_m, dx, dy),
        params={"species": "oak", "spacing": spacing_m, "canopy_diameter": 3.0},
        created_at="2026-10-15T00:00:00+00:00", planted_year=0,
    )


def test_lit_path_places_a_lamp_every_spacing_ends_included() -> None:
    layout = build_layout(scene.load_baseline(), [_lit_path(40, 15)])
    lamps = [e for e in layout.entries if e.element is not None and e.element.intervention_id == "lit"]
    assert len(lamps) == 4  # 40 m in 3 gaps of 13.3 m
    assert {e.element.type for e in lamps} == {"streetlight"}
    assert {e.start for e in lamps} == {2}
    ends = [to_projected(lamps[i].element.geometry) for i in (0, -1)]
    assert ends[0].distance(ends[1]) == pytest.approx(40, abs=0.1)


def test_lit_path_costs_and_lights_like_its_lamps() -> None:
    output = scene._evaluate([_lit_path(40, 15)]).output
    assert output.indicators["cost"][1] == 0
    assert output.indicators["cost"][2] == 4 * COST_PER_ELEMENT_EUR["streetlight"]
    as_is = scene._as_is().output
    assert output.indicators["safety"][2] > as_is.indicators["safety"][2]


def test_tree_row_plants_a_tree_every_spacing_and_pays_for_each() -> None:
    # Somewhere with nothing in the way of a 40 m row.
    for dy in range(-60, 61, 4):
        row = _tree_row(40, 8, dy=dy)
        layout = build_layout(scene.load_baseline(), [row])
        trees = [slot for slot in layout.trees if slot.intervention_id == "row"]
        if len(trees) == 6:  # 40 m in 5 gaps of 8 m
            break
    else:
        pytest.fail("no clear ground for a 40 m row")
    assert {(slot.species, slot.initial_diameter) for slot in trees} == {("oak", 3.0)}
    with_row = scene._evaluate([row]).output
    single = scene._evaluate([row.model_copy(update={"card_type": "plant_tree", "geometry": trees[0].geometry})]).output
    assert with_row.indicators["cost"][0] == pytest.approx(6 * single.indicators["cost"][0])


def test_tree_row_skips_paths_buildings_and_crowns() -> None:
    baseline = scene.load_baseline()
    site = to_projected(baseline.site_boundary)
    path = next(e for e in baseline.elements if e.type == "path" and to_projected(e.geometry).intersects(site))
    # A row drawn right along a path plants nothing.
    on_path = _tree_row(0, 8).model_copy(update={"geometry": path.geometry})
    layout = build_layout(baseline, [on_path])
    assert [slot for slot in layout.trees if slot.intervention_id == "row"] == []
