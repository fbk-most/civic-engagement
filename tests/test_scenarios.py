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
from civic_engagement.store.storage import LocalStorage


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


@pytest.fixture
def saved(tmp_path):
    """Saved scenarios in a directory of their own, no presets."""
    return LocalStorage(tmp_path)


def test_save_list_read_delete(saved):
    info = save_scenario("Proposta A", [_intervention("a"), _intervention("b", deleted=True)], saved=saved, presets=None)
    assert (info.id, info.name, info.interventions) == ("proposta-a", "Proposta A", 1)
    assert [s.id for s in list_scenarios(saved, None)] == ["proposta-a"]
    read_info, interventions = read_scenario("proposta-a", saved, None)
    assert read_info.name == "Proposta A"
    assert [i.id for i in interventions] == ["a"]
    delete_scenario("proposta-a", saved, None)
    assert list_scenarios(saved, None) == []


def test_save_refuses_to_overwrite_unless_asked(saved):
    save_scenario("Proposta A", [_intervention("a")], saved=saved, presets=None)
    with pytest.raises(FileExistsError):
        save_scenario("proposta a", [], saved=saved, presets=None)
    assert save_scenario("proposta a", [], overwrite=True, saved=saved, presets=None).interventions == 0


def test_save_needs_a_name(saved):
    with pytest.raises(ScenarioError):
        save_scenario("  ", [], saved=saved, presets=None)


def test_ids_cannot_leave_the_directory(saved):
    with pytest.raises(ScenarioError):
        read_scenario("../session", saved, None)
    with pytest.raises(ScenarioError):
        delete_scenario("../session", saved, None)


def test_reads_a_bare_list_and_skips_other_sites(tmp_path, saved):
    (tmp_path / "old.json").write_text(json.dumps([_intervention("a").model_dump()]))
    (tmp_path / "elsewhere.json").write_text(
        json.dumps({"site_id": "not-" + SITE.site_id, "name": "x", "interventions": []})
    )
    (tmp_path / "broken.json").write_text("{")
    assert [(s.id, s.name, s.interventions) for s in list_scenarios(saved, None)] == [("old", "old", 1)]
    with pytest.raises(ScenarioError):
        read_scenario("elsewhere", saved, None)
    with pytest.raises(ScenarioError):
        read_scenario("broken", saved, None)


def test_presets_beside_the_saved_scenarios(tmp_path):
    """The state elsewhere than the site's data: its presets are offered
    too, can be hidden by a saved scenario, and can't be deleted."""
    presets, saved = LocalStorage(tmp_path / "presets"), LocalStorage(tmp_path / "state")
    save_scenario("Demo", [_intervention("a")], saved=presets, presets=None)
    assert [s.id for s in list_scenarios(saved, presets)] == ["demo"]
    assert [i.id for i in read_scenario("demo", saved, presets)[1]] == ["a"]
    with pytest.raises(FileExistsError):
        save_scenario("Demo", [], saved=saved, presets=presets)
    save_scenario("Demo", [_intervention("b")], overwrite=True, saved=saved, presets=presets)
    assert [i.id for i in read_scenario("demo", saved, presets)[1]] == ["b"]
    assert len(list_scenarios(saved, presets)) == 1
    delete_scenario("demo", saved, presets)  # the saved one: the preset is back
    assert [i.id for i in read_scenario("demo", saved, presets)[1]] == ["a"]
    with pytest.raises(ScenarioError):
        delete_scenario("demo", saved, presets)
    with pytest.raises(FileNotFoundError):
        delete_scenario("other", saved, presets)


def test_replace_sets_the_old_session_aside(tmp_path, monkeypatch):
    from civic_engagement.store import state

    monkeypatch.delenv("CIVIC_ENGAGEMENT_SCENARIO", raising=False)
    store = state.SessionStore(LocalStorage(tmp_path), "session.json")
    store.replace([_intervention("a")])
    assert not list(tmp_path.glob("session.*.json"))  # nothing to set aside yet
    revision = store.revision()
    store.replace([_intervention("b"), _intervention("c")])
    assert [i.id for i in store.list_interventions()] == ["b", "c"]
    assert store.revision() != revision
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
