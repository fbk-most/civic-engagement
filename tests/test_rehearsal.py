"""The rehearsal page's API (api/routes_rehearsal.py): with
CIVIC_ENGAGEMENT_REHEARSAL=1, an editor moves their own team's phase."""

import logging

import pytest
from fastapi.testclient import TestClient

from civic_engagement import access
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from tests.test_phases import ADMIN, IDS, _team, open_app, phased  # noqa: F401 (fixtures)
from tests.test_teams import pin_app  # noqa: F401 (a fixture)


@pytest.fixture
def rehearsal(pin_app, phased, monkeypatch):  # noqa: F811
    """With teams, phases and the flag: the app built again with it."""
    monkeypatch.setenv("CIVIC_ENGAGEMENT_REHEARSAL", "1")
    access.team_store.cache_clear()
    return TestClient(create_app(active_pack()))


def test_off_by_default(pin_app, phased):  # noqa: F811
    access.team_store.cache_clear()
    _, editor, _ = _team(pin_app)
    assert pin_app.get("/api/rehearsal", headers=editor).status_code == 404
    assert pin_app.put("/api/rehearsal/phase", json={"phase": "all"}, headers=editor).status_code == 404


def test_on_says_so(pin_app, phased, monkeypatch, caplog):  # noqa: F811
    monkeypatch.setenv("CIVIC_ENGAGEMENT_REHEARSAL", "1")
    access.team_store.cache_clear()
    with caplog.at_level(logging.WARNING):
        create_app(active_pack())
    assert "editors can change their team's phase" in caplog.text


def test_not_with_open(open_app, monkeypatch, caplog):  # noqa: F811
    """Without teams there's no team's phase to move: off, and said so."""
    monkeypatch.setenv("CIVIC_ENGAGEMENT_REHEARSAL", "1")
    with caplog.at_level(logging.WARNING):
        client = open_app(None)
    assert "needs CIVIC_ENGAGEMENT_AUTH=pin" in caplog.text
    assert client.get("/api/rehearsal").status_code == 404


def test_phases_views_and_who_may_move(rehearsal):
    _, editor, viewers = _team(rehearsal)
    got = rehearsal.get("/api/rehearsal", headers=editor).json()
    assert [p["id"] for p in got["phases"]] == IDS
    assert [v["id"] for v in got["views"]] == ["as-is", "cards"]
    assert got["can_set_phase"] is True
    assert rehearsal.get("/api/rehearsal", headers=viewers).json()["can_set_phase"] is False
    assert rehearsal.get("/api/rehearsal").status_code == 401


def test_editor_moves_own_team_only(rehearsal):
    one, editor, viewers = _team(rehearsal, "Team 1")
    two, _, _ = _team(rehearsal, "Team 2")
    answer = rehearsal.put("/api/rehearsal/phase", json={"phase": "all"}, headers=editor)
    assert answer.status_code == 200, answer.text
    assert answer.json()["phase"] == "all"
    teams = {t["id"]: t["phase"] for t in rehearsal.get("/api/admin/teams", headers=ADMIN).json()}
    assert teams == {one["id"]: "all", two["id"]: "looking"}
    # The team's windows: at once, with the same tokens.
    assert rehearsal.get("/api/auth/me", headers=viewers).json()["phase"] == "all"
    assert rehearsal.get("/api/session/revision", headers=viewers).json()["phase"] == "all"
    # Back, too.
    assert rehearsal.put("/api/rehearsal/phase", json={"phase": "looking"}, headers=editor).status_code == 200
    assert rehearsal.get("/api/auth/me", headers=editor).json()["phase"] == "looking"


def test_viewers_and_unknown_phases_refused(rehearsal):
    one, editor, viewers = _team(rehearsal)
    assert rehearsal.put("/api/rehearsal/phase", json={"phase": "all"}, headers=viewers).status_code == 403
    assert rehearsal.put("/api/rehearsal/phase", json={"phase": "nowhere"}, headers=editor).status_code == 422
    assert rehearsal.put("/api/rehearsal/phase", json={"phase": "all"}).status_code == 401
    assert rehearsal.get("/api/auth/me", headers=editor).json()["phase"] == "looking"
