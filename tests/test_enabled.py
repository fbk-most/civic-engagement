"""Cards turned on and off (`Intervention.enabled`): kept on the scene, left
out of what's computed from it and of the scenarios saved. Who may turn
them is test_phases.py's (`PATCH /interventions/enabled`)."""

import json

from civic_engagement import scene
from civic_engagement.models.schema import Intervention
from civic_engagement.store.scenarios import library
from civic_engagement.store.state import SessionStore
from civic_engagement.store.storage import LocalStorage
from tests.test_phases import open_app, phased  # noqa: F401 (fixtures)
from tests.test_teams import BENCH

OTHER = {**BENCH, "geometry": {"type": "Point", "coordinates": [11.001, 46.002]}}


def _computed(client) -> dict:
    """What the scene's cards are evaluated into: its elements, its
    indicators, the deferred ones and the series."""
    scene_ = client.get("/api/scene").json()
    return {
        "elements": scene_["elements"],
        "indicators": scene_["indicators"],
        "deferred": client.get("/api/indicators/deferred").json(),
        "series": client.get("/api/indicators/series").json(),
    }


def test_old_documents_load_as_enabled(tmp_path):
    card = {**BENCH, "id": "a", "created_at": "2026-10-16T00:00:00+00:00"}
    assert Intervention(**card).enabled
    (tmp_path / "session.json").write_text(json.dumps({"default": [card]}))
    store = SessionStore(LocalStorage(tmp_path), "session.json")
    assert [i.enabled for i in store.list_interventions()] == [True]
    assert [i.id for i in store.enabled_interventions()] == ["a"]


def test_a_card_off_is_left_out_of_what_is_computed(open_app, monkeypatch):  # noqa: F811
    client = open_app(None)
    client.post("/api/interventions", json=BENCH)
    alone = _computed(client)
    other = client.post("/api/interventions", json=OTHER).json()["interventions"][-1]["id"]
    both = _computed(client)
    assert both["indicators"] != alone["indicators"]

    evaluated = []
    monkeypatch.setattr(scene, "_evaluate", lambda interventions: evaluated.append(interventions))
    revision = client.get("/api/session/revision").json()["revision"]
    off = client.patch(f"/api/interventions/{other}/enabled", json={"enabled": False})
    assert off.status_code == 200
    # Every card still listed, with its flag; the team's windows follow.
    assert [i["enabled"] for i in off.json()["interventions"]] == [True, False]
    assert client.get("/api/session/revision").json()["revision"] != revision
    assert _computed(client) == alone
    # And on again: both evaluations were cached, none made.
    client.patch(f"/api/interventions/{other}/enabled", json={"enabled": True})
    assert _computed(client) == both
    assert evaluated == []

    assert client.patch("/api/interventions/nothing/enabled", json={"enabled": False}).status_code == 404


def test_scenarios_keep_the_cards_on_and_load_them_on(open_app):  # noqa: F811
    client = open_app(None)
    client.post("/api/interventions", json=BENCH)
    other = client.post("/api/interventions", json=OTHER).json()["interventions"][-1]["id"]
    client.patch(f"/api/interventions/{other}/enabled", json={"enabled": False})
    assert client.post("/api/scenarios", json={"name": "Idea"}).json()["interventions"] == 1
    saved = json.loads(library()[0].read("idea.json"))
    assert len(saved["interventions"]) == 1 and other not in {i["id"] for i in saved["interventions"]}

    # A document with a card off (written by hand): loaded, all on.
    saved["interventions"].append({**saved["interventions"][0], "id": "off", "enabled": False})
    library()[0].write("hand.json", json.dumps(saved).encode())
    loaded = client.post("/api/scenarios/hand/load").json()["interventions"]
    assert [i["enabled"] for i in loaded] == [True, True]
