"""What the API says about a card before and when it is placed: the check, and
the refusal of a polygon over something protected. The route functions are
called directly, with the session store emptied and never written to disk."""

import pytest
from fastapi import HTTPException
from shapely.geometry import box

from civic_twin import scene
from civic_twin.api.routes_interventions import check_new_intervention, create_intervention
from civic_twin.domains.urban.clearing import to_wgs84
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import InterventionCreate
from civic_twin.scene import load_baseline
from civic_twin.store.state import store


@pytest.fixture(autouse=True)
def empty_store(monkeypatch):
    monkeypatch.setattr(store, "_sessions", {})
    monkeypatch.setattr(store, "_save", lambda: None)
    scene._scenario_cache.clear()
    yield
    scene._scenario_cache.clear()


@pytest.fixture(scope="module")
def baseline():
    return load_baseline()


def around(point, half: float) -> dict:
    return to_wgs84(box(point.x - half, point.y - half, point.x + half, point.y + half))


def cultivate(geometry: dict, purpose: str = "botanical") -> InterventionCreate:
    return InterventionCreate(card_type="cultivate_terrain", geometry=geometry, params={"purpose": purpose})


def pond_centre(baseline):
    return to_projected(next(c for c in baseline.covers if c.cover_type == "water").geometry).representative_point()


def test_a_card_that_does_not_clear_has_nothing_to_check(baseline):
    bench = InterventionCreate(
        card_type="add_bench", geometry=to_wgs84(pond_centre(baseline)), params={}
    )
    check = check_new_intervention(bench, t=0)
    assert not check.blocking and not check.warnings and not check.clearing.elements_by_type


def test_draining_the_pond_is_a_warning_not_an_error(baseline):
    check = check_new_intervention(cultivate(around(pond_centre(baseline), 6.0)), t=0)
    assert not check.blocking
    assert [(w.code, w.cover_type) for w in check.warnings] == [("cover_replaced", "water")]
    assert check.warnings[0].area_m2 == pytest.approx(144.0, rel=0.01)
    assert check.clearing.cover_area_m2_by_type["water"] == pytest.approx(144.0, rel=0.01)


def test_a_polygon_over_a_building_or_a_street_is_an_error(baseline):
    building = next(e for e in baseline.elements if e.type == "building")
    street = next(e for e in baseline.elements if e.type == "street")
    on_building = to_projected(building.geometry).representative_point()
    on_street = to_projected(street.geometry).interpolate(0.5, normalized=True)
    check = check_new_intervention(cultivate(around(on_building, 1.0)), t=0)
    assert (building.id, "building") in {(b.id, b.type) for b in check.blocking}
    check = check_new_intervention(cultivate(around(on_street, 1.0)), t=0)
    assert street.id in {b.id for b in check.blocking}


def test_the_check_says_what_would_be_cleared(baseline):
    pond = to_projected(next(c for c in baseline.covers if c.cover_type == "water").geometry)
    polygon = to_wgs84(box(pond.centroid.x - 30, pond.centroid.y - 20, pond.centroid.x + 30, pond.centroid.y + 20))
    check = check_new_intervention(cultivate(polygon), t=0)
    assert not check.blocking
    assert check.clearing.elements_by_type.keys() >= {"tree", "bench", "path"}
    assert set(check.clearing.cover_area_m2_by_type) == {"water", "lawn"}


def test_a_refused_placement_says_why_and_stores_nothing(baseline):
    building = next(e for e in baseline.elements if e.type == "building")
    polygon = around(to_projected(building.geometry).representative_point(), 1.0)
    with pytest.raises(HTTPException) as refused:
        create_intervention(cultivate(polygon), t=0)
    assert refused.value.status_code == 422
    assert building.id in {b["id"] for b in refused.value.detail["blocking"]}
    assert store.list_interventions() == []


def test_a_placement_with_a_warning_goes_through(baseline):
    result = create_intervention(cultivate(around(pond_centre(baseline), 6.0)), t=3)
    assert [i.card_type for i in result.interventions] == ["cultivate_terrain"]
    assert result.interventions[0].planted_year == 3


def test_the_check_sees_what_an_earlier_card_already_cleared(baseline):
    """A second card over the same spot has nothing left to clear there, once
    the first one has. Before the first, it still has."""
    tree = next(e for e in baseline.elements if e.type == "tree")
    polygon = around(to_projected(tree.geometry), 1.0)
    if check_new_intervention(cultivate(polygon), t=5).blocking:
        pytest.skip("the first tree has a protected object next to it")
    create_intervention(cultivate(polygon), t=5)
    assert check_new_intervention(cultivate(polygon), t=3).clearing.elements_by_type.get("tree") == 1
    assert check_new_intervention(cultivate(polygon), t=8).clearing.elements_by_type.get("tree") is None
