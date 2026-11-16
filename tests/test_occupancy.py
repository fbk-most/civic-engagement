"""Two things cannot stand on the same ground, whatever the cards: a card is
refused (409, nothing stored) over what already stands there. The route
functions are called directly, with the session store emptied and never
written to disk."""

import pytest
from fastapi import HTTPException
from shapely.geometry import LineString, Point, box

from civic_twin import scene
from civic_twin.api.routes_cards import CARDS
from civic_twin.api.routes_interventions import (
    check_new_intervention,
    create_intervention,
    update_intervention,
)
from civic_twin.domains.urban.clearing import to_wgs84
from civic_twin.domains.urban.layout import build_layout
from civic_twin.domains.urban.occupancy import blocking_occupants
from civic_twin.domains.urban.parameters import OCCUPYING_AREA_CARDS
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import InterventionCreate, InterventionUpdate
from civic_twin.scene import load_baseline
from civic_twin.store.state import store

SPEC = {card.card_type: card for card in CARDS}
PLACING = [c for c in SPEC if c != "change_ground_cover"]  # that one takes no ground


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


@pytest.fixture(scope="module")
def spot(baseline) -> Point:
    """A point with 40 m of nothing round it, so only the cards placed by the
    test stand there."""
    layout = build_layout(baseline, [])
    min_x, min_y, max_x, max_y = to_projected(baseline.site_boundary).bounds
    for x in range(int(min_x), int(max_x), 5):
        for y in range(int(min_y), int(max_y), 5):
            square = to_wgs84(box(x - 20, y - 20, x + 20, y + 20))
            if not blocking_occupants(layout, "add_playground", square, {}, 0):
                return Point(x, y)
    raise RuntimeError("no free spot in the baseline")


def card(card_type: str, at: Point, params: dict | None = None, dx: float = 0.0) -> InterventionCreate:
    """The card at `at` (shifted by `dx` metres): a point, a 10 m line or a 10 m square."""
    x, y = at.x + dx, at.y
    kind = SPEC[card_type].placement_type
    shape = {
        "point": Point(x, y),
        "polyline": LineString([(x - 5, y), (x + 5, y)]),
        "area": box(x - 5, y - 5, x + 5, y + 5),
    }[kind]
    defaults = {p.key: p.default for p in SPEC[card_type].params}
    params = {**defaults, **(params or {})}
    return InterventionCreate(card_type=card_type, geometry=to_wgs84(shape), params=params)


def place(data: InterventionCreate, t: int = 0, acknowledged: bool = True):
    if acknowledged:
        keys = [w.key for w in check_new_intervention(data, t).warnings]
        data = data.model_copy(update={"acknowledged_warnings": keys})
    return create_intervention(data, t)


def refused(data: InterventionCreate, t: int = 0) -> HTTPException:
    before = len(store.list_interventions())
    with pytest.raises(HTTPException) as error:
        place(data, t)
    assert error.value.status_code == 409
    assert len(store.list_interventions()) == before  # nothing stored
    return error.value


@pytest.mark.parametrize("second", PLACING)
@pytest.mark.parametrize("first", PLACING)
def test_no_two_cards_stand_on_the_same_ground(spot, first, second):
    place(card(first, spot))
    if first == "new_path" and second == "new_path":
        place(card(second, spot))  # two paths may cross
    elif second == "cultivate_terrain" and first not in OCCUPYING_AREA_CARDS:
        place(card(second, spot))  # a garden clears what stands on its ground
    else:
        assert refused(card(second, spot)).detail["blocking"]


def test_the_gazebo_on_the_vegetable_garden_is_refused_and_says_what_is_there(spot):
    place(card("cultivate_terrain", spot, {"cover_type": "vegetable_garden"}))
    error = refused(card("add_pergola", spot))
    assert {b["type"] for b in error.detail["blocking"]} == {"cultivated_area"}


def test_the_ground_cover_card_takes_no_ground(spot):
    place(card("cultivate_terrain", spot))
    place(card("add_bench", spot, dx=30))
    check = check_new_intervention(card("change_ground_cover", spot, dx=30), t=0)
    assert not check.blocking


def test_touching_is_not_overlapping(spot):
    place(card("add_bench", spot))
    place(card("add_bench", spot, dx=2.0))  # a bench is 1.2 m wide: they do not meet
    refused(card("add_bench", spot, dx=0.5))


def test_a_card_is_refused_over_what_is_placed_for_a_later_year(spot):
    place(card("cultivate_terrain", spot), t=10)
    refused(card("add_bench", spot), t=3)
    refused(card("add_bench", spot), t=12)


def test_a_card_is_refused_over_the_pond(baseline):
    pond = next(c for c in baseline.covers if c.cover_type == "water")
    centre = to_projected(pond.geometry).representative_point()
    error = refused(card("add_bench", centre))
    assert {b["type"] for b in error.detail["blocking"]} == {"water"}


def test_a_replanting_does_not_collide_with_the_stump_it_replaces(baseline):
    tree = next(e for e in baseline.elements if e.type == "tree")
    at = to_projected(tree.geometry)
    data = card("plant_tree", at)
    assert tree.id in {b.id for b in check_new_intervention(data, 0).blocking}
    replanting = data.model_copy(update={"replaces_element_id": tree.id})
    assert tree.id not in {b.id for b in check_new_intervention(replanting, 0).blocking}


def test_editing_a_card_cannot_make_it_overlap_its_neighbour(spot):
    place(card("add_pergola", spot, {"size": "small"}))
    placed = place(card("add_pergola", spot, {"size": "small"}, dx=4.5))
    mine = placed.interventions[-1]
    update_intervention(mine.id, InterventionUpdate(params={"size": "small"}), t=0)  # itself is not in the way
    with pytest.raises(HTTPException) as error:
        update_intervention(mine.id, InterventionUpdate(params={"size": "large"}), t=0)
    assert error.value.status_code == 409
    assert store.get_intervention(mine.id).params == {"size": "small"}
