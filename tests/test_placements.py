"""The cards' placements: drawn (a point, a line, an area), picked among the
baseline's buildings, or without a place (a policy, at most one if the card
says so); and the pack's own refusals."""

import json

import pytest
from fastapi.testclient import TestClient

from civic_engagement import config
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from civic_engagement.geo_utils import footprints
from civic_engagement.scene import load_baseline
from civic_engagement.store import state, storage

POINT = {"type": "Point", "coordinates": [11.002, 46.001]}
MURAL_REFUSED = {"message": "Un murale non ha una quota.", "message_en": "A mural has no rate."}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """The app without teams, its state in tmp_path."""
    monkeypatch.delenv("CIVIC_ENGAGEMENT_AUTH", raising=False)
    monkeypatch.delenv("CIVIC_ENGAGEMENT_FRONTEND", raising=False)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_STATE", str(tmp_path))
    for cached in (config.auth_mechanism, storage.state_storage):
        cached.cache_clear()
    monkeypatch.setattr(state.store, "_sessions", {})
    monkeypatch.setattr(state.store, "_uncontrollables", {})
    yield TestClient(create_app(active_pack()))
    for cached in (config.auth_mechanism, storage.state_storage):
        cached.cache_clear()


def test_footprints_as_one_multipolygon():
    square = [[[0, 0], [1, 0], [1, 1], [0, 0]]]
    assert footprints([{"type": "Polygon", "coordinates": square},
                       {"type": "MultiPolygon", "coordinates": [square, square]}]) == {
        "type": "MultiPolygon", "coordinates": [square, square, square]}


def test_a_card_on_buildings_takes_their_footprints(client):
    (building,) = [e for e in load_baseline().elements if e.type == "building"]
    scene = client.post("/api/interventions", json={
        "card_type": "mural", "element_ids": [building.id, building.id], "params": {},
        "geometry": POINT,  # ignored: the footprints count
    })
    assert scene.status_code == 200, scene.text
    (mural,) = scene.json()["interventions"]
    assert mural["element_ids"] == [building.id]
    assert mural["geometry"] == footprints([building.geometry])


def test_a_card_on_buildings_needs_the_sites_buildings(client):
    for ids in (None, [], ["no-such-building"]):
        response = client.post("/api/interventions", json={"card_type": "mural", "element_ids": ids, "params": {}})
        assert response.status_code == 422, ids
        assert "Murale" in response.json()["detail"]["message"], ids


def test_a_policy_has_no_place_and_is_single(client):
    created = client.post("/api/interventions", json={"card_type": "seating_policy", "geometry": POINT, "params": {"rate": 20}})
    assert created.status_code == 200
    (policy,) = created.json()["interventions"]
    assert policy["geometry"] is None and policy["element_ids"] is None
    again = client.post("/api/interventions", json={"card_type": "seating_policy", "params": {"rate": 30}})
    assert (again.status_code, again.json()["detail"]["message_en"]) == (409, "The scenario already has “Free seating”: edit that one.")
    # Edited instead; and once deleted, it can be placed again.
    assert client.patch(f"/api/interventions/{policy['id']}", json={"params": {"rate": 30}}).status_code == 200
    client.delete(f"/api/interventions/{policy['id']}")
    assert client.post("/api/interventions", json={"card_type": "seating_policy", "params": {}}).status_code == 200


def test_a_drawn_card_needs_its_geometry(client):
    assert client.post("/api/interventions", json={"card_type": "add_bench", "params": {}}).status_code == 422
    placed = client.post("/api/interventions", json={"card_type": "add_bench", "geometry": POINT, "element_ids": ["x"], "params": {}})
    assert placed.json()["interventions"][0]["element_ids"] is None


def test_the_pack_refuses_what_it_wants(client):
    (building,) = [e for e in load_baseline().elements if e.type == "building"]
    refused = client.post("/api/interventions", json={"card_type": "mural", "element_ids": [building.id], "params": {"rate": 1}})
    assert (refused.status_code, refused.json()["detail"]) == (422, MURAL_REFUSED)


def test_a_saved_policy_loads_back(client, tmp_path):
    client.post("/api/interventions", json={"card_type": "seating_policy", "params": {"rate": 5}})
    client.post("/api/scenarios", json={"name": "Policy"})
    client.post("/api/session/clear")
    loaded = client.post("/api/scenarios/policy/load").json()
    assert [(i["card_type"], i["geometry"]) for i in loaded["interventions"]] == [("seating_policy", None)]
    saved = json.loads((tmp_path / "tests/toy_pack/data/scenarios/policy.json").read_text())
    assert saved["interventions"][0]["geometry"] is None


def test_an_edit_is_refused_by_the_pack_too(client):
    (building,) = [e for e in load_baseline().elements if e.type == "building"]
    (mural,) = client.post("/api/interventions", json={"card_type": "mural", "element_ids": [building.id], "params": {}}).json()["interventions"]
    refused = client.patch(f"/api/interventions/{mural['id']}", json={"params": {"rate": 1}})
    assert (refused.status_code, refused.json()["detail"]) == (422, MURAL_REFUSED)
    assert client.get("/api/scene").json()["interventions"][0]["params"] == {}


def test_a_single_card_once_in_the_store(tmp_path):
    from civic_engagement.models.schema import InterventionCreate
    from civic_engagement.store.state import AlreadyPlaced, SessionStore
    from civic_engagement.store.storage import LocalStorage

    sessions = SessionStore(LocalStorage(tmp_path), "session.json")
    policy = InterventionCreate(card_type="seating_policy", params={})
    sessions.add_intervention(policy, single=True)
    with pytest.raises(AlreadyPlaced):
        sessions.add_intervention(policy, single=True)
    assert len(sessions.list_interventions()) == 1


def test_a_scenario_with_a_single_card_twice_is_listed_not_loaded(client, tmp_path):
    client.post("/api/interventions", json={"card_type": "seating_policy", "params": {}})
    client.post("/api/scenarios", json={"name": "Twice"})
    path = tmp_path / "tests/toy_pack/data/scenarios/twice.json"
    document = json.loads(path.read_text())
    document["interventions"] *= 2
    path.write_text(json.dumps(document))
    assert "twice" in [s["id"] for s in client.get("/api/scenarios").json()]
    response = client.post("/api/scenarios/twice/load")
    assert response.status_code == 422 and "seating_policy" in response.json()["detail"]


def test_the_buildings_a_card_can_take(client, monkeypatch):
    from civic_engagement.models.schema import BuildingChoice

    (building,) = [e for e in load_baseline().elements if e.type == "building"]
    # By default, the pack says nothing: any building.
    assert client.get("/api/cards/mural/buildings").json() == {"buildings": None}
    assert client.get("/api/cards/no_such_card/buildings").status_code == 404
    assert client.get("/api/cards/seating_policy/buildings").status_code == 422

    town_hall = BuildingChoice(pickable=False, label="Il municipio", label_en="The town hall")
    monkeypatch.setattr(type(active_pack()), "building_choices", lambda self, card_type: {building.id: town_hall})
    assert client.get("/api/cards/mural/buildings").json()["buildings"][building.id]["label_en"] == "The town hall"
    response = client.post("/api/interventions", json={"card_type": "mural", "element_ids": [building.id], "params": {}})
    assert response.status_code == 422
    assert response.json()["detail"]["message_en"] == "“Mural” can’t go on: The town hall."

    picked = BuildingChoice(pickable=True, label="Il municipio")
    monkeypatch.setattr(type(active_pack()), "building_choices", lambda self, card_type: {building.id: picked})
    assert client.post("/api/interventions", json={"card_type": "mural", "element_ids": [building.id], "params": {}}).status_code == 200


def test_the_scene_says_what_each_card_took(client):
    (building,) = [e for e in load_baseline().elements if e.type == "building"]
    scene = client.post("/api/interventions", json={"card_type": "mural", "element_ids": [building.id], "params": {}}).json()
    client.post("/api/interventions", json={"card_type": "seating_policy", "params": {"rate": 1}})
    scene = client.get("/api/scene").json()
    mural = next(iv for iv in scene["interventions"] if iv["card_type"] == "mural")
    assert scene["summaries"] == {mural["id"]: ["Edifici: 1", "Buildings: 1"]}
