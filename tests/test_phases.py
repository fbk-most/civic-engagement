"""Phases (civic_engagement/phases.py): the changes a team's phase lets
through, with teams (`pin`) and without (`open`)."""

import json
import logging

import pytest
from fastapi.testclient import TestClient

from civic_engagement import access, config, domain
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import PhaseSpec, ViewSpec
from civic_engagement.phases import INTERVENTIONS_EDIT, NOTES_EDIT, OPERATIONS, SCENARIOS_EDIT, check
from civic_engagement.pins import DigitPin
from civic_engagement.store import state, storage
from civic_engagement.store.storage import LocalStorage
from civic_engagement.store.teams import TeamError, TeamStore
from tests.test_teams import ADMIN, BENCH, _login, pin_app  # noqa: F401 (pin_app: a fixture)

# The toy pack's phases in these tests (it has none otherwise): one where
# nothing changes, one for the cards only, one for everything.
PHASES = [
    PhaseSpec(id="looking", label="Guardare", label_en="Looking", views=["as-is"]),
    PhaseSpec(id="placing", label="Posare", label_en="Placing", operations=[INTERVENTIONS_EDIT], views=["cards"]),
    PhaseSpec(id="all", label="Tutto", label_en="All", operations=[INTERVENTIONS_EDIT, SCENARIOS_EDIT], views=["cards"]),
]
IDS = [phase.id for phase in PHASES]
# The views they name (test_views.py).
VIEWS = [
    ViewSpec(id="as-is", label="Com'è", label_en="As is", panels=["tab.2d", "tab.3d", "kpi", "legend"], intervention_mode="hidden"),
    ViewSpec(id="cards", label="Carte", label_en="Cards", panels=["tab.2d", "tab.3d", "cards", "interventions"], tab="3d"),
]


@pytest.fixture
def phased(monkeypatch):
    monkeypatch.setattr(active_pack(), "phases", PHASES)
    monkeypatch.setattr(active_pack(), "views", VIEWS)


@pytest.fixture
def app(pin_app, phased):  # noqa: F811
    """With teams, and the toy pack with phases: the team store read again
    with them."""
    access.team_store.cache_clear()
    return pin_app


@pytest.fixture
def open_app(tmp_path, monkeypatch, phased):
    """Without teams, the state in tmp_path: the app built for a phase (or none)."""
    monkeypatch.delenv("CIVIC_ENGAGEMENT_AUTH", raising=False)
    monkeypatch.delenv("CIVIC_ENGAGEMENT_FRONTEND", raising=False)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_STATE", str(tmp_path))
    for cached in (config.auth_mechanism, storage.state_storage):
        cached.cache_clear()
    monkeypatch.setattr(state.store, "_sessions", {})

    def build(phase: str | None) -> TestClient:
        if phase is None:
            monkeypatch.delenv("CIVIC_ENGAGEMENT_PHASE", raising=False)
        else:
            monkeypatch.setenv("CIVIC_ENGAGEMENT_PHASE", phase)
        return TestClient(create_app(active_pack()))

    yield build
    storage.state_storage.cache_clear()


def _team(client, name: str = "Team 1") -> tuple[dict, dict, dict]:
    """A team, its editor's and its viewers' headers."""
    team = client.post("/api/admin/teams", json={"name": name}, headers=ADMIN).json()
    editor = client.post(f"/api/admin/teams/{team['id']}/members", json={"name": "Anna", "role": "editor"}, headers=ADMIN).json()
    viewers = client.post(f"/api/admin/teams/{team['id']}/members", json={"role": "viewer"}, headers=ADMIN).json()
    return team, _login(client, editor["pin"]), _login(client, viewers["pin"])


def _set(client, team: str, phase: str) -> None:
    response = client.put(f"/api/admin/teams/{team}/phase", json={"phase": phase}, headers=ADMIN)
    assert response.status_code == 200, response.text


def _guarded(client, headers) -> dict[str, int]:
    """Each change the phases guard, tried in turn: its status. A card and
    a scenario are there first (made in the phase `all`), so that each
    change has something to act on."""
    card = client.get("/api/interventions", headers=headers).json()[0]["id"]
    calls = {
        "POST /interventions": ("POST", "/api/interventions", BENCH),
        "PATCH /interventions": ("PATCH", f"/api/interventions/{card}", {"params": {}}),
        "PATCH /interventions/enabled": ("PATCH", f"/api/interventions/{card}/enabled", {"enabled": False}),
        "DELETE /interventions": ("DELETE", f"/api/interventions/{card}", None),
        "POST /scenarios": ("POST", "/api/scenarios", {"name": "Other"}),
        "POST /scenarios/load": ("POST", "/api/scenarios/idea/load", None),
        "DELETE /scenarios": ("DELETE", "/api/scenarios/other", None),
        "POST /session/clear": ("POST", "/api/session/clear", None),
    }
    return {name: client.request(method, path, json=body, headers=headers).status_code for name, (method, path, body) in calls.items()}


INTERVENTION_ROUTES = {
    "POST /interventions", "PATCH /interventions", "PATCH /interventions/enabled", "DELETE /interventions", "POST /session/clear"
}
SCENARIO_ROUTES = {"POST /scenarios", "POST /scenarios/load", "DELETE /scenarios"}


@pytest.mark.parametrize("phase", IDS)
def test_each_guarded_route_by_phase_and_role(app, phase):
    team, editor, viewers = _team(app)
    _set(app, team["id"], "all")
    assert app.post("/api/interventions", json=BENCH, headers=editor).status_code == 200
    assert app.post("/api/scenarios", json={"name": "Idea"}, headers=editor).status_code == 200
    _set(app, team["id"], phase)
    allowed = {op for spec in PHASES if spec.id == phase for op in spec.operations}

    # Viewers: never, whatever the phase (403, as before phases).
    assert set(_guarded(app, viewers).values()) == {403}
    # Editors: what the phase allows; the rest, 409 naming the phase.
    statuses = _guarded(app, editor)
    for route, status in statuses.items():
        operation = INTERVENTIONS_EDIT if route in INTERVENTION_ROUTES else SCENARIOS_EDIT
        if operation in allowed:
            assert status in (200, 204), (route, status)
        else:
            assert status == 409, (route, status)
    refused = app.post("/api/interventions", json=BENCH, headers=editor)
    if INTERVENTIONS_EDIT not in allowed:
        assert refused.json()["detail"] == f"Not allowed in the current phase ({phase})"

    # Reading, never blocked.
    for path in ("/api/scene", "/api/interventions", "/api/scenarios", "/api/indicators/series"):
        assert app.get(path, headers=viewers).status_code == 200, path


def test_me_and_the_revision_carry_the_phase(app):
    team, editor, viewers = _team(app)
    me = app.get("/api/auth/me", headers=editor).json()
    assert (me["phase"], me["operations"]) == ("looking", [])  # a new team: the first phase
    assert app.get("/api/session/revision", headers=viewers).json()["phase"] == "looking"

    _set(app, team["id"], "all")
    # At once, with the same token: read at each request.
    assert app.get("/api/auth/me", headers=editor).json()["operations"] == [INTERVENTIONS_EDIT, SCENARIOS_EDIT]
    viewer = app.get("/api/auth/me", headers=viewers).json()
    assert (viewer["phase"], viewer["operations"]) == ("all", [])
    assert app.get("/api/session/revision", headers=viewers).json()["phase"] == "all"
    # The login's answer too.
    pin = app.post(f"/api/admin/teams/{team['id']}/members", json={"name": "Bea", "role": "editor"}, headers=ADMIN).json()["pin"]
    login = app.post("/api/auth/pin", json={"pin": pin}, headers={"X-Forwarded-For": "10.0.0.1"}).json()
    assert (login["phase"], login["operations"]) == ("all", [INTERVENTIONS_EDIT, SCENARIOS_EDIT])


def test_the_manager_sets_phases(app):
    one, _, _ = _team(app, "Team 1")
    two, _, _ = _team(app, "Team 2")
    assert [p["id"] for p in app.get("/api/admin/phases", headers=ADMIN).json()] == IDS
    assert app.get("/api/admin/phases", headers=ADMIN).json()[1]["operations"] == [INTERVENTIONS_EDIT]
    assert one["phase"] == "looking"

    # One team; then back (any phase after any).
    assert app.put(f"/api/admin/teams/{one['id']}/phase", json={"phase": "all"}, headers=ADMIN).json()["phase"] == "all"
    _set(app, one["id"], "placing")
    assert {t["id"]: t["phase"] for t in app.get("/api/admin/teams", headers=ADMIN).json()} == {"team-1": "placing", "team-2": "looking"}
    # Every team.
    teams = app.put("/api/admin/phase", json={"phase": "all"}, headers=ADMIN).json()
    assert [(t["id"], t["phase"]) for t in teams] == [("team-1", "all"), ("team-2", "all")]

    # Unknown phases, teams.
    for path in (f"/api/admin/teams/{two['id']}/phase", "/api/admin/phase"):
        response = app.put(path, json={"phase": "nowhere"}, headers=ADMIN)
        assert response.status_code == 422 and "nowhere" in response.json()["detail"]
    assert app.put("/api/admin/teams/nobody/phase", json={"phase": "all"}, headers=ADMIN).status_code == 404
    assert app.put("/api/admin/phase", json={"phase": "all"}).status_code == 401


def test_a_pack_without_phases(pin_app):  # noqa: F811
    """Nothing blocked; the manager is told there are no phases."""
    team, editor, _ = _team(pin_app)
    assert team["phase"] is None
    me = pin_app.get("/api/auth/me", headers=editor).json()
    assert (me["phase"], me["operations"]) == (None, list(OPERATIONS))
    assert pin_app.get("/api/session/revision", headers=editor).json()["phase"] is None
    assert pin_app.post("/api/interventions", json=BENCH, headers=editor).status_code == 200
    assert pin_app.get("/api/admin/phases", headers=ADMIN).json() == []
    for path in (f"/api/admin/teams/{team['id']}/phase", "/api/admin/phase"):
        response = pin_app.put(path, json={"phase": "all"}, headers=ADMIN)
        assert response.status_code == 422 and response.json()["detail"] == "The pack has no phases"


def test_the_open_mechanism(open_app):
    # No CIVIC_ENGAGEMENT_PHASE: nothing blocked.
    client = open_app(None)
    me = client.get("/api/auth/me").json()
    assert (me["role"], me["phase"], me["operations"]) == ("editor", None, list(OPERATIONS))
    assert client.post("/api/interventions", json=BENCH).status_code == 200
    # In a phase: what it allows.
    client = open_app("looking")
    assert client.get("/api/auth/me").json()["operations"] == []
    assert client.get("/api/session/revision").json()["phase"] == "looking"
    assert client.post("/api/interventions", json=BENCH).status_code == 409
    assert client.post("/api/session/clear").status_code == 409
    client = open_app("placing")
    assert client.post("/api/interventions", json=BENCH).status_code == 200
    assert client.post("/api/scenarios", json={"name": "Idea"}).status_code == 409
    # One the pack doesn't have: the app doesn't start.
    with pytest.raises(RuntimeError, match="CIVIC_ENGAGEMENT_PHASE='nowhere'"):
        open_app("nowhere")


def test_the_open_mechanism_without_phases(tmp_path, monkeypatch):
    monkeypatch.delenv("CIVIC_ENGAGEMENT_AUTH", raising=False)
    config.auth_mechanism.cache_clear()
    monkeypatch.setenv("CIVIC_ENGAGEMENT_PHASE", "looking")
    with pytest.raises(RuntimeError, match="the pack has no phases"):
        create_app(active_pack())


# The team store.


def test_phases_kept_in_the_team_store(tmp_path):
    teams = TeamStore(LocalStorage(tmp_path), "teams.json", DigitPin(), b"secret", IDS)
    team = teams.create_team("Team 1")
    assert team.phase == "looking"
    teams.set_phase(team.id, "all")
    with pytest.raises(TeamError, match="No phase"):
        teams.set_phase(team.id, "nowhere")
    assert json.loads((tmp_path / "teams.json").read_text())["teams"][0]["phase"] == "all"
    again = TeamStore(LocalStorage(tmp_path), "teams.json", DigitPin(), b"secret", IDS)
    assert again.team(team.id).phase == "all"
    # Read by a pack without phases: none.
    assert TeamStore(LocalStorage(tmp_path), "teams.json", DigitPin(), b"secret").team(team.id).phase is None


def test_teams_from_before_phases_or_in_one_gone(tmp_path, caplog):
    teams = [
        {"id": "old", "name": "Old", "created_at": "2026-11-01T00:00:00+00:00", "members": []},
        {"id": "gone", "name": "Gone", "created_at": "2026-11-01T00:00:00+00:00", "members": [], "phase": "vanished"},
    ]
    (tmp_path / "teams.json").write_text(json.dumps({"teams": teams}))
    with caplog.at_level(logging.WARNING):
        store = TeamStore(LocalStorage(tmp_path), "teams.json", DigitPin(), b"secret", IDS)
    assert [team.phase for team in store.teams()] == ["looking", "looking"]
    assert "'vanished'" in caplog.text and "'old'" not in caplog.text


# Declaring phases.


def test_phases_checked_when_the_pack_registers(monkeypatch):
    check(PHASES)
    with pytest.raises(ValueError, match="same id"):
        check([PHASES[0], PHASES[0]])
    with pytest.raises(ValueError, match="unknown operations"):
        check([PhaseSpec(id="x", label="X", label_en="X", operations=["cards.burn"])])
    assert NOTES_EDIT in OPERATIONS

    class Broken(type(active_pack())):
        phases = [PHASES[0], PHASES[0]]

    monkeypatch.setattr(domain, "_pack", None)
    with pytest.raises(ValueError, match="same id"):
        domain.register(Broken())
    assert domain._pack is None


def test_unknown_operations_cant_be_guarded():
    with pytest.raises(ValueError):
        access.allowed("cards.burn")


def test_the_cli(app, monkeypatch, capsys):
    """civic-engagement-admin's `phase`, against the app on a free port."""
    import socket
    import threading
    import time

    import uvicorn

    from civic_engagement import admin

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app.app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_ADMIN_URL", f"http://127.0.0.1:{port}")
    try:
        admin.main(["phase", "list"])
        listed = capsys.readouterr().out.splitlines()
        assert [line.split()[0] for line in listed] == IDS and "may: nothing" in listed[0]
        admin.main(["team", "create", "Team 1"])
        admin.main(["team", "create", "Team 2"])
        assert "team-1  Team 1  (0 cards)  phase looking" in capsys.readouterr().out
        admin.main(["phase", "set", "placing", "--team", "team-2"])
        assert capsys.readouterr().out.strip() == "team-2  Team 2  (0 cards)  phase placing"
        admin.main(["phase", "set", "all"])
        assert capsys.readouterr().out.count("phase all") == 2
        with pytest.raises(SystemExit, match="422"):
            admin.main(["phase", "set", "nowhere"])
    finally:
        server.should_exit = True
        thread.join()
