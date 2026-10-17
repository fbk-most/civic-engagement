"""Named scenarios: a set of interventions saved under a name, to load back
into the session later (see `SessionStore.replace`).

One JSON file per scenario in data/<site>/scenarios/, named after the
scenario (`scenario_id`, a slug of its name):

    {"site_id": "...", "name": "...", "saved_at": "...", "interventions": [...]}

A file holding just the list of interventions (the old demo preset format)
is read too, with the file name as its name.
"""

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from civic_twin.config import SITE
from civic_twin.models.schema import Intervention, ScenarioInfo

SCENARIOS_DIR = Path(SITE.data_dir) / "scenarios"


class ScenarioError(Exception):
    """A scenario that can't be read, saved or found; the message says why."""


def scenario_id(name: str) -> str:
    """The file name for a scenario name: "Proposta scuola 2" → "proposta-scuola-2"."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


def _path(directory: Path, scenario: str) -> Path:
    # Only ids made by `scenario_id`: no way out of the directory.
    if not scenario or scenario != scenario_id(scenario):
        raise ScenarioError(f"Not a scenario id: {scenario!r}")
    return directory / f"{scenario}.json"


def _read(path: Path) -> tuple[ScenarioInfo, list[Intervention]]:
    payload = json.loads(path.read_text())
    if isinstance(payload, list):
        payload = {"name": path.stem, "interventions": payload}
    site_id = payload.get("site_id", SITE.site_id)
    if site_id != SITE.site_id:
        raise ScenarioError(f"Scenario {path.stem!r} is for site {site_id!r}, not {SITE.site_id!r}")
    interventions = [Intervention(**i) for i in payload["interventions"]]
    interventions = [i for i in interventions if not i.deleted]
    info = ScenarioInfo(
        id=path.stem,
        name=payload.get("name", path.stem),
        saved_at=payload.get("saved_at"),
        interventions=len(interventions),
    )
    return info, interventions


def list_scenarios(directory: Path = SCENARIOS_DIR) -> list[ScenarioInfo]:
    """Every readable scenario, most recently saved first (undated ones last)."""
    infos = []
    for path in directory.glob("*.json"):
        try:
            infos.append(_read(path)[0])
        except (ScenarioError, ValueError, KeyError, TypeError):
            continue  # not a scenario of this site: not offered
    return sorted(infos, key=lambda info: (info.saved_at or "", info.name), reverse=True)


def read_scenario(scenario: str, directory: Path = SCENARIOS_DIR) -> tuple[ScenarioInfo, list[Intervention]]:
    path = _path(directory, scenario)
    if not path.exists():
        raise FileNotFoundError(scenario)
    try:
        return _read(path)
    except (ValueError, KeyError, TypeError) as error:
        raise ScenarioError(f"Scenario {scenario!r} can't be read: {error}") from error


def save_scenario(
    name: str, interventions: list[Intervention], overwrite: bool = False, directory: Path = SCENARIOS_DIR
) -> ScenarioInfo:
    """Saves the interventions (the deleted ones left out) as `name`. An
    existing scenario of the same id is replaced only with `overwrite`."""
    name = name.strip()
    path = _path(directory, scenario_id(name)) if scenario_id(name) else None
    if path is None:
        raise ScenarioError("A scenario needs a name with at least a letter or a digit")
    if path.exists() and not overwrite:
        raise FileExistsError(path.stem)
    kept = [i for i in interventions if not i.deleted]
    saved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "site_id": SITE.site_id,
                "name": name,
                "saved_at": saved_at,
                "interventions": [i.model_dump() for i in kept],
            },
            indent=1,
        )
    )
    return ScenarioInfo(id=path.stem, name=name, saved_at=saved_at, interventions=len(kept))


def delete_scenario(scenario: str, directory: Path = SCENARIOS_DIR) -> None:
    path = _path(directory, scenario)
    if not path.exists():
        raise FileNotFoundError(scenario)
    path.unlink()
