"""The uncontrollables (see civic_engagement/domain.py): the team's scenario
and "as is" evaluated under the same values, kept in the session and in a
saved scenario; a pack without any sees nothing of them."""

import json

import pytest
from fastapi.testclient import TestClient

from civic_engagement import config, scene
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import Intervention
from civic_engagement.store import state, storage
from civic_engagement.store.scenarios import read_scenario, save_scenario
from civic_engagement.store.state import SessionStore
from civic_engagement.store.storage import LocalStorage

BENCH = {"card_type": "add_bench", "geometry": {"type": "Point", "coordinates": [11.002, 46.001]}, "params": {}}


def _bench(id: str = "a") -> Intervention:
    return Intervention(id=id, card_type="add_bench", geometry=BENCH["geometry"], params={}, created_at="2026-11-22T00:00:00+00:00")


def test_the_pack_settles_and_refuses():
    pack = active_pack()
    assert pack.settled({}) == {"weather": "sunny"}
    # A value the pack no longer has, or an uncontrollable it no longer
    # declares (a scenario saved before): the default, and dropped.
    assert pack.settled({"weather": "snowy", "wind": "strong"}) == {"weather": "sunny"}
    assert pack.settled({"weather": "rainy"}) == {"weather": "rainy"}
    assert pack.refused({"weather": "rainy"}) is None
    assert "wind" in pack.refused({"wind": "strong"})
    assert "snowy" in pack.refused({"weather": "snowy"})


def test_the_session_keeps_them(tmp_path):
    documents = LocalStorage(tmp_path)
    sessions = SessionStore(documents, "session.json")
    sessions.replace([_bench()], "t")
    # None chosen: the old form, a list.
    assert isinstance(json.loads(documents.read("session.json"))["t"], list)
    revision = sessions.revision("t")
    sessions.set_uncontrollables({"weather": "rainy"}, "t")
    assert sessions.revision("t") != revision
    assert json.loads(documents.read("session.json"))["t"]["uncontrollables"] == {"weather": "rainy"}

    again = SessionStore(documents, "session.json")
    assert again.uncontrollables("t") == {"weather": "rainy"}
    assert [i.id for i in again.list_interventions("t")] == ["a"]
    again.replace([], "t")  # cards cleared: the uncontrollables kept
    assert again.uncontrollables("t") == {"weather": "rainy"}
    again.replace([_bench("b")], "t", {})  # a scenario saved without any
    assert again.uncontrollables("t") == {}


def test_a_scenario_keeps_them(tmp_path):
    saved = LocalStorage(tmp_path)
    info = save_scenario("Rain", [_bench()], saved=saved, presets=None, uncontrollables={"weather": "rainy"})
    assert info.uncontrollables == {"weather": "rainy"}
    assert read_scenario("rain", saved, None)[0].uncontrollables == {"weather": "rainy"}
    save_scenario("Plain", [_bench()], saved=saved, presets=None)
    assert "uncontrollables" not in json.loads(saved.read("plain.json"))
    assert read_scenario("plain", saved, None)[0].uncontrollables == {}


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


def test_as_is_under_the_same_values(client):
    (weather,) = client.get("/api/uncontrollables").json()
    assert (weather["id"], weather["default"], [v["id"] for v in weather["values"]]) == ("weather", "sunny", ["sunny", "rainy"])

    first = client.post("/api/interventions", json=BENCH).json()
    assert first["uncontrollables"] == {"weather": "sunny"}
    assert (first["indicators"]["sitters"], first["baseline_indicators"]["sitters"]) == (8, 4)

    rainy = client.put("/api/session/uncontrollables", json={"values": {"weather": "rainy"}})
    assert rainy.status_code == 200
    rainy = rainy.json()
    assert rainy["uncontrollables"] == {"weather": "rainy"}
    assert (rainy["indicators"]["sitters"], rainy["baseline_indicators"]["sitters"]) == (2, 1)
    assert [i["id"] for i in rainy["interventions"]] == [i["id"] for i in first["interventions"]]
    assert client.get("/api/scene").json()["uncontrollables"] == {"weather": "rainy"}

    series = client.get("/api/indicators/series").json()
    assert series["uncontrollables"] == {"weather": "rainy"}
    assert {(s["sitters"], b["sitters"]) for s, b in zip(series["scenario"], series["baseline"])} == {(2, 1)}

    # Left out: the default.
    assert client.put("/api/session/uncontrollables", json={"values": {}}).json()["uncontrollables"] == {"weather": "sunny"}


def test_refused_values_change_nothing(client):
    for values in ({"weather": "snowy"}, {"wind": "strong"}):
        assert client.put("/api/session/uncontrollables", json={"values": values}).status_code == 422
    assert client.get("/api/scene").json()["uncontrollables"] == {"weather": "sunny"}


def test_saved_loaded_and_kept_by_a_clear(client):
    client.post("/api/interventions", json=BENCH)
    client.put("/api/session/uncontrollables", json={"values": {"weather": "rainy"}})
    saved = client.post("/api/scenarios", json={"name": "Rain"}).json()
    assert saved["uncontrollables"] == {"weather": "rainy"}
    assert [s["uncontrollables"] for s in client.get("/api/scenarios").json() if s["id"] == "rain"] == [{"weather": "rainy"}]

    client.put("/api/session/uncontrollables", json={"values": {"weather": "sunny"}})
    loaded = client.post("/api/scenarios/rain/load").json()
    assert loaded["uncontrollables"] == {"weather": "rainy"} and len(loaded["interventions"]) == 1

    cleared = client.post("/api/session/clear").json()
    assert cleared["uncontrollables"] == {"weather": "rainy"} and cleared["interventions"] == []


def test_a_pack_without_sees_nothing_of_them(client, monkeypatch, tmp_path):
    pack = active_pack()
    calls = []

    def evaluate(baseline, interventions):  # the signature of a pack without
        calls.append(len(interventions))
        return type(pack).evaluate(pack, baseline, interventions)

    monkeypatch.setattr(pack, "uncontrollables", [])
    monkeypatch.setattr(pack, "evaluate", evaluate)
    scene._as_is.cache_clear()
    scene._scenario_cache.clear()
    try:
        assert client.get("/api/uncontrollables").json() == []
        created = client.post("/api/interventions", json=BENCH).json()
        assert created["uncontrollables"] == {} and calls
        session = json.loads((tmp_path / "tests/toy_pack/data/session.json").read_text())
        assert isinstance(session["default"], list)
        assert client.post("/api/scenarios", json={"name": "Urban"}).json()["uncontrollables"] == {}
        saved = json.loads((tmp_path / "tests/toy_pack/data/scenarios/urban.json").read_text())
        assert "uncontrollables" not in saved
    finally:
        scene._as_is.cache_clear()
        scene._scenario_cache.clear()
