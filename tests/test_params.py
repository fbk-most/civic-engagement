"""The parameters of a card are checked against its spec before anything is
stored: a value the spec does not allow is a 422, not a card that breaks the
scene (or hangs it) for as long as the session lasts. The route functions are
called directly, with the session store emptied and never written to disk."""

import glob
import json

import pytest
from fastapi import HTTPException

from civic_twin import scene
from civic_twin.api.routes_cards import CARDS, validate_params
from civic_twin.api.routes_interventions import (
    check_new_intervention,
    create_intervention,
    update_intervention,
)
from civic_twin.models.schema import InterventionCreate, InterventionUpdate
from civic_twin.store.state import store

POINT = {"type": "Point", "coordinates": [11.1195, 46.0702]}


@pytest.fixture(autouse=True)
def empty_store(monkeypatch):
    monkeypatch.setattr(store, "_sessions", {})
    monkeypatch.setattr(store, "_save", lambda: None)
    scene._scenario_cache.clear()
    yield
    scene._scenario_cache.clear()


@pytest.mark.parametrize(
    ("card_type", "params"),
    [
        ("cultivate_terrain", {"cover_type": "banana"}),  # not one of the options
        ("plant_tree", {"species": "banana"}),
        ("plant_tree", {"canopy_diameter": -5}),  # below the minimum
        ("plant_tree", {"canopy_diameter": 99}),  # above the maximum
        ("plant_grove", {"spacing": 0}),  # would never end
        ("new_path", {"width": "wide"}),  # not a number
        ("new_path", {"width": True}),  # a bool is not a number
        ("new_path", {"width": float("nan")}),
        ("add_pergola", {"size": 3}),  # not one of the options
        ("add_bench", {"whatever": 1}),  # not a parameter of the card
        ("cultivate_terrain", {"purpose": "commercial"}),  # the old name of cover_type
    ],
)
def test_a_value_the_spec_does_not_allow_is_refused(card_type, params):
    with pytest.raises(HTTPException) as refused:
        validate_params(card_type, params)
    assert refused.value.status_code == 422


@pytest.mark.parametrize(
    ("card_type", "params"),
    [
        ("add_bench", {}),
        ("plant_tree", {}),  # what is left out takes its default
        ("plant_tree", {"species": "linden"}),
        ("plant_tree", {"canopy_diameter": 1}),  # an int is a number; the limits are inclusive
        ("plant_tree", {"canopy_diameter": 3.0}),
        ("cultivate_terrain", {"cover_type": "flowerbed"}),
    ],
)
def test_what_the_spec_allows_is_accepted(card_type, params):
    validate_params(card_type, params)


def test_the_refusal_says_which_parameters_are_wrong():
    with pytest.raises(HTTPException) as refused:
        validate_params("plant_grove", {"species": "banana", "spacing": 0, "extra": 1})
    for word in ("species", "spacing", "extra"):
        assert word in refused.value.detail


def test_a_card_with_invalid_params_is_not_stored():
    for card_type, params in (("plant_tree", {"species": "banana"}), ("add_bench", {"x": 1})):
        data = InterventionCreate(card_type=card_type, geometry=POINT, params=params)
        with pytest.raises(HTTPException) as refused:
            create_intervention(data, t=0)
        assert refused.value.status_code == 422
        with pytest.raises(HTTPException) as refused:
            check_new_intervention(data, t=0)
        assert refused.value.status_code == 422
    assert store.list_interventions() == []
    scene.current_scene(0)  # the session still works


def test_an_update_with_invalid_params_changes_nothing():
    placed = store.add_intervention(
        InterventionCreate(card_type="plant_tree", geometry=POINT, params={"species": "oak"})
    )
    with pytest.raises(HTTPException) as refused:
        update_intervention(placed.id, InterventionUpdate(params={"species": "banana"}), t=0)
    assert refused.value.status_code == 422
    assert store.list_interventions()[0].params == {"species": "oak"}
    update_intervention(placed.id, InterventionUpdate(params={"species": "linden"}), t=0)
    assert store.list_interventions()[0].params == {"species": "linden"}


def test_an_update_of_what_does_not_exist_is_still_a_404():
    with pytest.raises(HTTPException) as refused:
        update_intervention("int-nope", InterventionUpdate(params={"species": "banana"}), t=0)
    assert refused.value.status_code == 404


def test_every_card_spec_agrees_with_itself():
    """A new card whose defaults or options its own spec refuses fails here."""
    for card in CARDS:
        validate_params(card.card_type, {p.key: p.default for p in card.params})
        for param in card.params:
            for option in param.options or []:
                validate_params(card.card_type, {param.key: option})
            if param.min is not None and param.max is not None:
                validate_params(card.card_type, {param.key: param.min})
                validate_params(card.card_type, {param.key: param.max})


def test_the_recorded_sessions_pass_the_validation():
    paths = glob.glob("tests/fixtures/reference/*/*session.json")
    assert paths
    for path in paths:
        with open(path) as file:
            payload = json.load(file)
        for interventions in payload.values() if isinstance(payload, dict) else [payload]:
            for intervention in interventions:
                validate_params(intervention["card_type"], intervention["params"])


def test_loading_skips_saved_cards_the_spec_no_longer_accepts(tmp_path, monkeypatch):
    def card(card_id, params):
        return {"id": card_id, "card_type": "cultivate_terrain", "geometry": POINT, "params": params,
                "deleted": False, "created_at": "2026-01-01T00:00:00+00:00",
                "replaces_element_id": None, "planted_year": 0}

    path = tmp_path / "session.json"
    path.write_text(json.dumps({"default": [card("old", {"purpose": "commercial"}),
                                            card("ok", {"cover_type": "flowerbed"})]}))
    monkeypatch.setattr("civic_twin.store.state.SESSION_JSON_PATH", path)
    loaded = type(store)()
    assert [i.id for i in loaded.list_interventions()] == ["ok"]
