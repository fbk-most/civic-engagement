import json

import pytest

from civic_engagement.config import SITE
from civic_engagement.models.schema import Intervention
from civic_engagement.store.scenarios import (
    ScenarioError,
    delete_scenario,
    list_scenarios,
    read_scenario,
    save_scenario,
    scenario_id,
)


def _intervention(id: str, deleted: bool = False) -> Intervention:
    return Intervention(
        id=id,
        card_type="add_bench",
        geometry={"type": "Point", "coordinates": [11.12, 46.07]},
        params={},
        deleted=deleted,
        created_at="2026-10-16T00:00:00+00:00",
    )


def test_scenario_id_is_a_slug():
    assert scenario_id("  Proposta Scuola, 2ª versione! ") == "proposta-scuola-2a-versione"
    assert scenario_id("Città") == "citta"
    assert scenario_id("!!!") == ""


def test_save_list_read_delete(tmp_path):
    info = save_scenario("Proposta A", [_intervention("a"), _intervention("b", deleted=True)], directory=tmp_path)
    assert (info.id, info.name, info.interventions) == ("proposta-a", "Proposta A", 1)
    assert [s.id for s in list_scenarios(tmp_path)] == ["proposta-a"]
    read_info, interventions = read_scenario("proposta-a", tmp_path)
    assert read_info.name == "Proposta A"
    assert [i.id for i in interventions] == ["a"]
    delete_scenario("proposta-a", tmp_path)
    assert list_scenarios(tmp_path) == []


def test_save_refuses_to_overwrite_unless_asked(tmp_path):
    save_scenario("Proposta A", [_intervention("a")], directory=tmp_path)
    with pytest.raises(FileExistsError):
        save_scenario("proposta a", [], directory=tmp_path)
    assert save_scenario("proposta a", [], overwrite=True, directory=tmp_path).interventions == 0


def test_save_needs_a_name(tmp_path):
    with pytest.raises(ScenarioError):
        save_scenario("  ", [], directory=tmp_path)


def test_ids_cannot_leave_the_directory(tmp_path):
    with pytest.raises(ScenarioError):
        read_scenario("../session", tmp_path)
    with pytest.raises(ScenarioError):
        delete_scenario("../session", tmp_path)


def test_reads_a_bare_list_and_skips_other_sites(tmp_path):
    (tmp_path / "old.json").write_text(json.dumps([_intervention("a").model_dump()]))
    (tmp_path / "elsewhere.json").write_text(
        json.dumps({"site_id": "not-" + SITE.site_id, "name": "x", "interventions": []})
    )
    (tmp_path / "broken.json").write_text("{")
    assert [(s.id, s.name, s.interventions) for s in list_scenarios(tmp_path)] == [("old", "old", 1)]
    with pytest.raises(ScenarioError):
        read_scenario("elsewhere", tmp_path)
    with pytest.raises(ScenarioError):
        read_scenario("broken", tmp_path)


def test_replace_sets_the_old_session_aside(tmp_path, monkeypatch):
    from civic_engagement.store import state

    monkeypatch.setattr(state, "SESSION_JSON_PATH", tmp_path / "session.json")
    monkeypatch.delenv("CIVIC_ENGAGEMENT_SCENARIO", raising=False)
    store = state.SessionStore()
    store.replace([_intervention("a")])
    assert not list(tmp_path.glob("session.*.json"))  # nothing to set aside yet
    revision = store.revision
    store.replace([_intervention("b"), _intervention("c")])
    assert [i.id for i in store.list_interventions()] == ["b", "c"]
    assert store.revision != revision
    (kept,) = tmp_path.glob("session.*.json")
    assert [i["id"] for i in json.loads(kept.read_text())["default"]] == ["a"]


def test_within_boundary_gives_a_metre():
    from civic_engagement.geo_utils import within_boundary

    # About 100 m a side, near 46° N.
    boundary = {"type": "Polygon", "coordinates": [[[11.0, 46.0], [11.0013, 46.0], [11.0013, 46.0009], [11.0, 46.0009], [11.0, 46.0]]]}
    point = lambda lng, lat: {"type": "Point", "coordinates": [lng, lat]}  # noqa: E731
    assert within_boundary(point(11.0006, 46.0004), boundary)
    # Half a metre past the edge: still in; ten metres: out.
    assert within_boundary(point(11.0013 + 0.5 / 77_300, 46.0004), boundary)
    assert not within_boundary(point(11.0013 + 10 / 77_300, 46.0004), boundary)
    line = {"type": "LineString", "coordinates": [[11.0006, 46.0004], [11.003, 46.0004]]}
    assert not within_boundary(line, boundary)
