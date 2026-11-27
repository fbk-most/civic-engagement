"""Notes (civic_engagement/store/notes.py, api/routes_notes.py): a team's,
apart from its scene."""

import dataclasses
import json

import pytest
from fastapi.testclient import TestClient

from civic_engagement import access, config, scene
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import InterventionCreate, NoteCreate, NoteUpdate, PhaseSpec
from civic_engagement.phases import INTERVENTIONS_EDIT, NOTES_EDIT
from civic_engagement.store import notes as notes_module
from civic_engagement.store import storage
from civic_engagement.store.notes import NoteStore
from civic_engagement.store.state import SessionStore
from civic_engagement.store.storage import LocalStorage
from tests.test_phases import _set, _team
from tests.test_teams import ADMIN, BENCH, pin_app  # noqa: F401 (pin_app: a fixture)

# Inside the toy square, and outside it.
HERE = {"type": "Point", "coordinates": [11.001, 46.001]}
THERE = {"type": "Point", "coordinates": [11.003, 46.002]}
AWAY = {"type": "Point", "coordinates": [11.1, 46.1]}

PHASES = [
    PhaseSpec(id="listening", label="Ascolto", label_en="Listening", operations=[NOTES_EDIT]),
    PhaseSpec(id="placing", label="Posare", label_en="Placing", operations=[INTERVENTIONS_EDIT]),
]


@pytest.fixture
def app(pin_app, monkeypatch):  # noqa: F811
    """With teams, phases for notes and for cards, and a fresh note store."""
    monkeypatch.setattr(active_pack(), "phases", PHASES)
    monkeypatch.setattr(notes_module.notes, "_notes", {})
    access.team_store.cache_clear()
    return pin_app


@pytest.fixture
def surveyed(monkeypatch):
    """The toy square's boundary taken as surveyed: it binds."""
    site = dataclasses.replace(config.active_site(), boundary_status="surveyed")
    monkeypatch.setattr(config, "active_site", lambda: site)


def test_editors_write_notes_viewers_read_them(app):
    team, editor, viewers = _team(app)
    revision = app.get("/api/session/revision", headers=viewers).json()

    added = app.post("/api/notes", json={"title": "  Shade  ", "text": "More trees, please", "geometry": HERE}, headers=editor)
    assert added.status_code == 200, added.text
    (note,) = added.json()["notes"]
    assert (note["title"], note["text"], note["created_by"], note["updated_by"]) == ("Shade", "More trees, please", "Anna", None)
    # The viewers see it, and are told to look: the notes' revision, not the scene's.
    now = app.get("/api/session/revision", headers=viewers).json()
    assert now["notes"] != revision["notes"] and now["revision"] == revision["revision"]
    listed = app.get("/api/notes", headers=viewers).json()
    assert listed["notes"] == [note] and listed["revision"] == now["notes"]

    # Changed, then moved: only what's given changes.
    changed = app.patch(f"/api/notes/{note['id']}", json={"text": ""}, headers=editor).json()["notes"][0]
    assert (changed["title"], changed["text"], changed["updated_by"]) == ("Shade", "", "Anna")
    moved = app.patch(f"/api/notes/{note['id']}", json={"geometry": THERE}, headers=editor).json()["notes"][0]
    assert moved["geometry"] == THERE and moved["title"] == "Shade"

    # Viewers can't change them.
    for method, path, body in (
        ("POST", "/api/notes", {"title": "x", "geometry": HERE}),
        ("PATCH", f"/api/notes/{note['id']}", {"title": "x"}),
        ("DELETE", f"/api/notes/{note['id']}", None),
    ):
        assert app.request(method, path, json=body, headers=viewers).status_code == 403, path

    # Another team's notes are none of this one's.
    _, other, _ = _team(app, "Team 2")
    assert app.get("/api/notes", headers=other).json()["notes"] == []
    assert app.delete(f"/api/notes/{note['id']}", headers=other).status_code == 404

    assert app.delete(f"/api/notes/{note['id']}", headers=editor).json()["notes"] == []
    assert app.delete(f"/api/notes/{note['id']}", headers=editor).status_code == 404
    assert app.patch(f"/api/notes/{note['id']}", json={"title": "x"}, headers=editor).status_code == 404


def test_notes_checked(app, surveyed):
    _, editor, _ = _team(app)
    for body in (
        {"title": "   ", "geometry": HERE},
        {"title": "x" * 81, "geometry": HERE},
        {"title": "Shade", "text": "x" * 2001, "geometry": HERE},
        {"title": "Shade", "geometry": {"type": "LineString", "coordinates": [[11.001, 46.001], [11.002, 46.001]]}},
        {"title": "Shade", "geometry": {"type": "Point", "coordinates": [11.001]}},
        {"text": "no title", "geometry": HERE},
    ):
        assert app.post("/api/notes", json=body, headers=editor).status_code == 422, body
    # Within the site, as the cards.
    outside = app.post("/api/notes", json={"title": "Far", "geometry": AWAY}, headers=editor)
    assert (outside.status_code, outside.json()["detail"]) == (422, "outside the site boundary")
    note = app.post("/api/notes", json={"title": "Shade", "geometry": HERE}, headers=editor).json()["notes"][0]
    assert app.patch(f"/api/notes/{note['id']}", json={"geometry": AWAY}, headers=editor).status_code == 422
    assert app.patch(f"/api/notes/{note['id']}", json={"title": ""}, headers=editor).status_code == 422
    assert app.get("/api/notes", headers=editor).json()["notes"][0]["geometry"] == HERE


def test_phases_that_dont_allow_notes(app):
    team, editor, viewers = _team(app)
    note = app.post("/api/notes", json={"title": "Shade", "geometry": HERE}, headers=editor).json()["notes"][0]
    _set(app, team["id"], "placing")
    for method, path, body in (
        ("POST", "/api/notes", {"title": "x", "geometry": HERE}),
        ("PATCH", f"/api/notes/{note['id']}", {"title": "x"}),
        ("DELETE", f"/api/notes/{note['id']}", None),
    ):
        refused = app.request(method, path, json=body, headers=editor)
        assert (refused.status_code, refused.json()["detail"]) == (409, "Not allowed in the current phase (placing)"), path
        assert app.request(method, path, json=body, headers=viewers).status_code == 403, path
    # Reading, never blocked.
    assert app.get("/api/notes", headers=viewers).json()["notes"] == [note]


def test_notes_leave_the_scene_alone(app, monkeypatch):
    """No evaluation, and the scene's revision unchanged: the windows
    don't fetch the scene again for a note."""
    _, editor, _ = _team(app)
    before = app.get("/api/scene", headers=editor).json()
    evaluated = []
    monkeypatch.setattr(scene, "_evaluate", lambda interventions: evaluated.append(interventions))
    note = app.post("/api/notes", json={"title": "Shade", "geometry": HERE}, headers=editor).json()["notes"][0]
    app.patch(f"/api/notes/{note['id']}", json={"geometry": THERE}, headers=editor)
    app.delete(f"/api/notes/{note['id']}", headers=editor)
    assert evaluated == []
    assert app.get("/api/session/revision", headers=editor).json()["revision"] == before["revision"]


def test_notes_go_with_the_team(app, tmp_path):
    team, editor, viewers = _team(app)
    app.post("/api/notes", json={"title": "Shade", "geometry": HERE}, headers=editor)
    document = tmp_path / "tests/toy_pack/data/notes/team-1.json"
    assert [n["title"] for n in json.loads(document.read_text())["team-1"]] == ["Shade"]

    export = app.get(f"/api/admin/teams/{team['id']}/export", headers=ADMIN).json()
    assert [n["title"] for n in export["notes"]] == ["Shade"]

    # Deleted with the team: a new team of the same id starts with none.
    revision = app.get("/api/session/revision", headers=viewers).json()["notes"]
    assert app.delete(f"/api/admin/teams/{team['id']}", headers=ADMIN).status_code == 204
    assert not document.exists()
    assert notes_module.notes.revision(team["id"]) != revision
    again, editor, _ = _team(app)
    assert again["id"] == team["id"]
    assert app.get("/api/notes", headers=editor).json()["notes"] == []


def test_the_open_mechanism(tmp_path, monkeypatch):
    monkeypatch.delenv("CIVIC_ENGAGEMENT_AUTH", raising=False)
    monkeypatch.delenv("CIVIC_ENGAGEMENT_PHASE", raising=False)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_STATE", str(tmp_path))
    for cached in (config.auth_mechanism, storage.state_storage):
        cached.cache_clear()
    monkeypatch.setattr(notes_module.notes, "_notes", {})
    try:
        client = TestClient(create_app(active_pack()))
        note = client.post("/api/notes", json={"title": "Shade", "geometry": HERE}).json()["notes"][0]
        assert note["created_by"] is None
        assert (tmp_path / "tests/toy_pack/data/notes/default.json").is_file()
    finally:
        storage.state_storage.cache_clear()


# The store.


def test_the_store_read_again(tmp_path):
    storage = LocalStorage(tmp_path)
    name = lambda team: f"notes/{team}.json"  # noqa: E731
    notes = NoteStore(storage, name)
    kept = notes.add_note(NoteCreate(title="Shade", geometry=HERE), "team-1", author="Anna")
    gone = notes.add_note(NoteCreate(title="Noise", text="Traffic", geometry=HERE), "team-1", author="Anna")
    notes.update_note(kept.id, NoteUpdate(geometry=THERE), "team-1", author="Bea")
    assert notes.delete_note(gone.id, "team-1")
    assert notes.update_note("note-none", NoteUpdate(title="x"), "team-1") is None

    again = NoteStore(storage, name).list_notes("team-1")
    assert [(n.id, n.geometry, n.created_by, n.updated_by) for n in again] == [(kept.id, THERE, "Anna", "Bea")]
    assert NoteStore(storage, name).list_notes("team-2") == []
    notes.forget("team-1")
    assert not (tmp_path / "notes/team-1.json").exists() and notes.list_notes("team-1") == []


def test_the_sessions_set_aside_untouched(tmp_path):
    """Notes live apart: a team's sessions set aside are found by prefix,
    and notes never among them."""
    storage = LocalStorage(tmp_path)
    sessions = SessionStore(storage, lambda team: f"sessions/{team}.json")
    sessions.add_intervention(InterventionCreate(**BENCH), team="team-1")
    sessions.replace([], "team-1")
    aside = sessions.set_aside("team-1")
    assert len(aside) == 1

    notes = NoteStore(storage, lambda team: f"notes/{team}.json")
    note = notes.add_note(NoteCreate(title="Shade", geometry=HERE), "team-1")
    notes.delete_note(note.id, "team-1")
    notes.forget("team-1")
    assert sessions.set_aside("team-1") == aside
    sessions.forget("team-1")
    assert not list((tmp_path / "sessions").iterdir())

