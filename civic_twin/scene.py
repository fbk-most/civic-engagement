"""Shared helper for building the resolved scene, used by both the scene and
intervention routes (interventions endpoints return the freshly resolved
scene directly, saving the frontend a second round trip).

Each scenario — the baseline plus one set of interventions — is evaluated
once by the urban model for the whole horizon (see domains/urban/model.py);
moving the year slider only reads another year of the same evaluation. The
"as is" scenario (no interventions) is evaluated once per site, and paired
with the current one here: the model itself knows nothing about baselines.
"""

import json
import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from civic_twin.config import SITE
from civic_twin.domains.urban.encode import encode
from civic_twin.domains.urban.layout import Layout, TreeSlot, build_layout
from civic_twin.domains.urban.model import COVER_TYPES, INCLUSION_GROUPS, UrbanEvaluator, UrbanOutput, build_model
from civic_twin.domains.urban.parameters import HORIZON_YEARS
from civic_twin.domains.urban.trees import species_traits
from civic_twin.models.schema import (
    BaselineScene,
    CoverPolygon,
    DiscreteElement,
    IndicatorSeries,
    Intervention,
    SceneResponse,
)
from civic_twin.store.state import store

# The scenario horizon: t is any integer year offset in this range, not just
# a handful of preset points.
MIN_T = 0
MAX_T = HORIZON_YEARS

ROAD_MARKING_TYPES = {"crossing", "lane_divider"}

ALIVE, STUMP = 1, 2


@lru_cache(maxsize=1)
def load_baseline() -> BaselineScene:
    with open(SITE.baseline_json_path) as f:
        return BaselineScene(**json.load(f))


@lru_cache(maxsize=1)
def _evaluator() -> UrbanEvaluator:
    return UrbanEvaluator(build_model())


@dataclass(frozen=True)
class Evaluated:
    layout: Layout
    output: UrbanOutput


def _evaluate(interventions: list[Intervention]) -> Evaluated:
    layout = build_layout(load_baseline(), interventions)
    return Evaluated(layout=layout, output=_evaluator().run(encode(layout)))


@lru_cache(maxsize=1)
def _as_is() -> Evaluated:
    return _evaluate([])


# One entry: the evaluation for the last intervention set asked about. Moving
# the year slider doesn't change the interventions, so it never misses; any
# edit does, and re-evaluates.
_scenario_cache: dict[str, Evaluated] = {}


def _scenario(interventions: list[Intervention]) -> Evaluated:
    if not interventions:
        return _as_is()
    key = json.dumps([i.model_dump(mode="json") for i in interventions], sort_keys=True)
    if key not in _scenario_cache:
        _scenario_cache.clear()
        _scenario_cache[key] = _evaluate(interventions)
    return _scenario_cache[key]


# --- assembly: the scene at year t -------------------------------------------------


def _tree_element(slot: TreeSlot, output: UrbanOutput, k: int, t: int) -> DiscreteElement | None:
    status = int(output.tree_status[k, t])
    if status not in (ALIVE, STUMP):
        return None
    diameter = float(output.tree_diameter[k, t])
    height = float(output.tree_height[k, t])
    traits = species_traits(slot.species)
    if slot.origin == "baseline":
        properties = {
            "species": slot.species, "age_class": slot.age_class,
            "canopy_diameter": diameter if status == ALIVE else 0.0,
            "height": round(height, 2),
            "cut_year": slot.cut_year, "status": "alive" if status == ALIVE else "stump",
            **traits,
        }
    else:
        properties = {
            "species": slot.species,
            "canopy_diameter": diameter,
            "height": round(height, 2),
            **traits,
        }
    return DiscreteElement(
        id=slot.element_id,
        type="tree",
        source=slot.source,
        intervention_id=slot.intervention_id,
        geometry=slot.geometry,
        properties=properties,
    )


def _assemble(evaluated: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
    elements: list[DiscreteElement] = []
    covers: list[CoverPolygon] = []
    for entry in evaluated.layout.entries:
        if t < entry.start:
            continue
        if entry.cover is not None:
            covers.append(entry.cover)
        elif entry.element is not None:
            elements.append(entry.element)
        else:
            tree = _tree_element(evaluated.layout.trees[entry.tree], evaluated.output, entry.tree, t)
            if tree is not None:
                elements.append(tree)
    return elements, covers


def _optional(value: float, digits: int) -> float | None:
    return None if math.isnan(value) else round(value, digits)


def _indicators(output: UrbanOutput, t: int) -> dict:
    """Indicators at year t, rounded for display."""
    ind = {name: values for name, values in output.indicators.items()}

    def at(name: str) -> float:
        return float(ind[name][t])

    inclusion = ind["inclusion"][:, t]
    space_use = ind["space_use_pct"][:, t]
    return {
        "space_use_pct": {
            cover_type: round(float(v), 1) for cover_type, v in zip(COVER_TYPES, space_use) if not np.isnan(v)
        },
        "co2": {"annual_rate_kg": round(at("co2_annual"), 1), "cumulative_kg": round(at("co2_cumulative"), 1)},
        "thermal_comfort": {
            "estimated_temperature_c": round(at("estimated_temperature"), 1),
            "cooling_delta_c": round(at("cooling_delta"), 2),
        },
        "accessibility": {
            "walkability_score": _optional(at("walkability"), 1),
            "fragile_path_pct": _optional(at("fragile_path_pct"), 1),
        },
        "social": {
            "safety_score": round(at("safety"), 1),
            "evening_winter_score": round(at("evening_winter"), 1),
            "age_inclusivity": {group: bool(v > 0.5) for group, v in zip(INCLUSION_GROUPS, inclusion)},
        },
        "cost_eur": round(at("cost"), 2),
    }


def current_scene(t: int = 0, session_id: str = "default") -> SceneResponse:
    baseline = load_baseline()
    interventions = store.list_interventions(session_id)
    scenario = _scenario(interventions)

    elements, covers = _assemble(scenario, t)
    if not SITE.show_road_markings:
        elements = [e for e in elements if e.type not in ROAD_MARKING_TYPES]

    return SceneResponse(
        site_id=SITE.site_id,
        site_boundary=baseline.site_boundary,
        boundary_status=SITE.boundary_status,
        elements=elements,
        covers=covers,
        t=t,
        indicators=_indicators(scenario.output, t),
        baseline_indicators=_indicators(_as_is().output, t),
        interventions=interventions,
    )


def indicator_series(session_id: str = "default") -> IndicatorSeries:
    """Every indicator for every year of the horizon, with and without the
    session's interventions — the "Indicatori" tab's time series."""
    scenario = _scenario(store.list_interventions(session_id))
    years = list(range(MIN_T, MAX_T + 1))
    return IndicatorSeries(
        years=years,
        baseline=[_indicators(_as_is().output, t) for t in years],
        scenario=[_indicators(scenario.output, t) for t in years],
    )
