"""Named scenarios: a set of interventions saved under a name, to load back
into the session later (see `SessionStore.replace`).

One JSON document per scenario, named after the scenario (`scenario_id`, a
slug of its name):

    {"site_id": "...", "name": "...", "saved_at": "...", "interventions": [...]}

A document holding just the list of interventions (the old demo preset
format) is read too, with its name as the scenario's name.

Two places: the scenarios a team saved, in the state's storage
(store/storage.py), and the site's presets, shipped with its data in
data/<site>/scenarios/, which every team can load. A team's library
(`library`): with the open mechanism, its one team's is
data/<site>/scenarios/ — the same files as the presets unless
`CIVIC_ENGAGEMENT_STATE` puts the state elsewhere; with teams (pin),
data/<site>/scenarios/<team>/. A saved scenario with a preset's id hides
it; a preset can't be deleted.
"""

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from civic_engagement.config import SITE, auth_mechanism
from civic_engagement.models.schema import Intervention, ScenarioInfo
from civic_engagement.store.storage import LocalStorage, Storage, state_storage


class ScenarioError(Exception):
    """A scenario that can't be read, saved or found; the message says why."""


def library(team: str = "default") -> tuple[Storage, Storage | None]:
    """The team's saved scenarios, and the site's presets (None when they're
    the same documents)."""
    presets = LocalStorage(Path(SITE.data_dir) / "scenarios")
    if auth_mechanism() == "open":
        saved = state_storage().within(f"{SITE.data_dir}/scenarios")
    else:
        saved = state_storage().within(f"{SITE.data_dir}/scenarios/{team}")
    return saved, None if saved.location == presets.location else presets


SAVED, PRESETS = library()


def scenario_id(name: str) -> str:
    """The file name for a scenario name: "Proposta scuola 2" → "proposta-scuola-2"."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


def _name(scenario: str) -> str:
    # Only ids made by `scenario_id`: no way out of the directory.
    if not scenario or scenario != scenario_id(scenario):
        raise ScenarioError(f"Not a scenario id: {scenario!r}")
    return f"{scenario}.json"


def _parse(scenario: str, data: bytes) -> tuple[ScenarioInfo, list[Intervention]]:
    payload = json.loads(data)
    if isinstance(payload, list):
        payload = {"name": scenario, "interventions": payload}
    site_id = payload.get("site_id", SITE.site_id)
    if site_id != SITE.site_id:
        raise ScenarioError(f"Scenario {scenario!r} is for site {site_id!r}, not {SITE.site_id!r}")
    interventions = [Intervention(**i) for i in payload["interventions"]]
    interventions = [i for i in interventions if not i.deleted]
    info = ScenarioInfo(
        id=scenario,
        name=payload.get("name", scenario),
        saved_at=payload.get("saved_at"),
        interventions=len(interventions),
    )
    return info, interventions


def _find(scenario: str, saved: Storage, presets: Storage | None) -> bytes | None:
    name = _name(scenario)
    data = saved.read(name)
    if data is None and presets is not None:
        data = presets.read(name)
    return data


def list_scenarios(saved: Storage = SAVED, presets: Storage | None = PRESETS) -> list[ScenarioInfo]:
    """Every readable scenario, most recently saved first (undated ones last)."""
    infos = {}
    for documents in ([presets] if presets is not None else []) + [saved]:
        for name in documents.names():
            scenario = name.removesuffix(".json")
            try:
                info = _parse(scenario, documents.read(name) or b"")[0]
            except (ScenarioError, ValueError, KeyError, TypeError):
                continue  # not a scenario of this site: not offered
            infos[scenario] = info.model_copy(update={"preset": documents is presets})
    return sorted(infos.values(), key=lambda info: (info.saved_at or "", info.name), reverse=True)


def read_scenario(
    scenario: str, saved: Storage = SAVED, presets: Storage | None = PRESETS
) -> tuple[ScenarioInfo, list[Intervention]]:
    data = _find(scenario, saved, presets)
    if data is None:
        raise FileNotFoundError(scenario)
    try:
        return _parse(scenario, data)
    except (ValueError, KeyError, TypeError) as error:
        raise ScenarioError(f"Scenario {scenario!r} can't be read: {error}") from error


def save_scenario(
    name: str,
    interventions: list[Intervention],
    overwrite: bool = False,
    saved: Storage = SAVED,
    presets: Storage | None = PRESETS,
) -> ScenarioInfo:
    """Saves the interventions (the deleted ones left out) as `name`. An
    existing scenario of the same id is replaced only with `overwrite`."""
    name = name.strip()
    scenario = scenario_id(name)
    if not scenario:
        raise ScenarioError("A scenario needs a name with at least a letter or a digit")
    if not overwrite and _find(scenario, saved, presets) is not None:
        raise FileExistsError(scenario)
    kept = [i for i in interventions if not i.deleted]
    saved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "site_id": SITE.site_id,
        "name": name,
        "saved_at": saved_at,
        "interventions": [i.model_dump() for i in kept],
    }
    saved.write(_name(scenario), json.dumps(payload, indent=1).encode())
    return ScenarioInfo(id=scenario, name=name, saved_at=saved_at, interventions=len(kept))


def delete_scenario(scenario: str, saved: Storage = SAVED, presets: Storage | None = PRESETS) -> None:
    if saved.delete(_name(scenario)):
        return
    if presets is not None and presets.read(_name(scenario)) is not None:
        raise ScenarioError(f"Scenario {scenario!r} comes with the site: it can't be deleted")
    raise FileNotFoundError(scenario)


def scenario_documents(saved: Storage) -> dict[str, bytes]:
    """A library's saved scenarios, by file name: for an export."""
    return {name: saved.read(name) or b"" for name in saved.names()}


def delete_library(saved: Storage) -> None:
    for name in saved.names():
        saved.delete(name)
