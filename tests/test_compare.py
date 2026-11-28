"""A second scenario looked at beside the current scene (`scenario=` on the
scene, the deferred indicators and the series): computed apart, the
session untouched. Each team's own: test_teams.py."""

from civic_engagement import scene
from civic_engagement.store import scenarios
from civic_engagement.store.scenarios import library
from tests.test_enabled import OTHER
from tests.test_phases import open_app, phased  # noqa: F401 (fixtures)
from tests.test_teams import BENCH


def _computed(client, query: str = "") -> dict:
    """What a scene's cards are evaluated into, `query` added to each request."""
    scene_ = client.get(f"/api/scene?t=5{query}").json()
    return {
        "elements": scene_["elements"],
        "indicators": scene_["indicators"],
        "deferred": client.get(f"/api/indicators/deferred?t=5{query}").json(),
        "series": client.get(f"/api/indicators/series?{query[1:]}").json(),
    }


def test_a_saved_scenario_beside_the_current_scene(open_app):  # noqa: F811
    client = open_app(None)
    client.post("/api/interventions", json=BENCH)
    alone = _computed(client)
    assert client.post("/api/scenarios", json={"name": "Idea"}).status_code == 200
    client.post("/api/interventions", json=OTHER)
    both = _computed(client)
    revision = client.get("/api/session/revision").json()["revision"]

    assert _computed(client, "&scenario=idea") == alone
    looked = client.get("/api/scene?scenario=idea").json()
    assert len(looked["interventions"]) == 1
    # Not the session's revision: a window doesn't take it for a change.
    assert looked["revision"].startswith("scenario-idea-")
    # The current scene as it was, and nobody told to look again.
    assert _computed(client) == both
    assert client.get("/api/session/revision").json()["revision"] == revision


def test_a_scenario_not_there_or_not_an_id(open_app):  # noqa: F811
    client = open_app(None)
    for path in ("/api/scene", "/api/indicators/deferred", "/api/indicators/series"):
        assert client.get(f"{path}?scenario=nothing").status_code == 404, path
        assert client.get(f"{path}?scenario=../x").status_code == 422, path


def test_read_once_forgotten_when_saved_or_deleted(open_app, monkeypatch):  # noqa: F811
    client = open_app(None)
    client.post("/api/interventions", json=BENCH)
    client.post("/api/scenarios", json={"name": "Idea"})
    reads = []
    read = scenarios.read_scenario
    monkeypatch.setattr(scenarios, "read_scenario", lambda *args: reads.append(args[0]) or read(*args))
    for t in range(3):
        client.get(f"/api/scene?t={t}&scenario=idea")
    assert reads == ["idea"]

    # Saved again with another card: that one.
    client.post("/api/interventions", json=OTHER)
    client.post("/api/scenarios", json={"name": "Idea", "overwrite": True})
    assert len(client.get("/api/scene?scenario=idea").json()["interventions"]) == 2
    client.delete("/api/scenarios/idea")
    assert client.get("/api/scene?scenario=idea").status_code == 404
    assert library()[0].read("idea.json") is None


def test_comparing_keeps_both_evaluations(open_app, monkeypatch):  # noqa: F811
    client = open_app(None)
    client.post("/api/interventions", json=BENCH)
    client.post("/api/scenarios", json={"name": "Idea"})
    client.post("/api/interventions", json=OTHER)
    client.get("/api/scene")
    client.get("/api/scene?scenario=idea")
    evaluated = []
    monkeypatch.setattr(scene, "_evaluate", lambda interventions: evaluated.append(interventions))
    for t in range(4):
        client.get(f"/api/scene?t={t}")
        client.get(f"/api/scene?t={t}&scenario=idea")
    assert evaluated == []
