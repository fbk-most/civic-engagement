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
from civic_twin.domains.urban.clearing import CLEARING_CARDS, analyse, apply_clearing
from civic_twin.domains.urban.encode import encode
from civic_twin.domains.urban.layout import Layout, TreeSlot, build_layout
from civic_twin.domains.urban.model import COVER_TYPES, INCLUSION_GROUPS, UrbanEvaluator, UrbanOutput, build_model
from civic_twin.domains.urban.parameters import HORIZON_YEARS
from civic_twin.domains.urban.trees import species_traits
from civic_twin.models.schema import (
    BaselineScene,
    CheckBlocking,
    CheckWarning,
    ClearingSummary,
    CoverPolygon,
    DiscreteElement,
    IndicatorSeries,
    Intervention,
    InterventionCheck,
    InterventionCreate,
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
    apply_clearing(layout)
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


def _assemble(evaluated: Evaluated, as_is: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
    layout = evaluated.layout
    elements: list[DiscreteElement] = []
    covers: list[CoverPolygon] = []
    for entry in layout.entries:
        if t < entry.start:
            continue
        if entry.end is not None and t >= entry.end:
            # Taken away by a clearing. What a card placed is simply gone; what
            # the baseline had is kept, flagged, so that the views of the
            # situation as it is can still draw it (the simulation hides it).
            kept = _cleared_baseline(layout, as_is, entry, t)
            if kept is not None:
                (covers if isinstance(kept, CoverPolygon) else elements).append(kept)
            continue
        if entry.cover is not None:
            covers.append(entry.cover)
        elif entry.element is not None:
            elements.append(entry.element)
        else:
            tree = _tree_element(layout.trees[entry.tree], evaluated.output, entry.tree, t)
            if tree is not None:
                elements.append(tree)
    return elements, covers


def _cleared_baseline(layout: Layout, as_is: Evaluated, entry, t: int) -> DiscreteElement | CoverPolygon | None:
    flag = {"cleared_by": entry.cleared_by}
    if entry.cover is not None:
        return entry.cover.model_copy(update=flag) if entry.cover.source == "baseline" else None
    if entry.element is not None:
        return entry.element.model_copy(update=flag) if entry.element.source == "baseline" else None
    if layout.trees[entry.tree].origin != "baseline":
        return None
    # A baseline tree is the same tree in the evaluation without interventions
    # (baseline trees come first in both layouts): it is drawn as it would
    # have been there, which the scenario's own evaluation no longer says.
    slot = as_is.layout.trees[entry.tree]
    assert slot.element_id == layout.trees[entry.tree].element_id
    tree = _tree_element(slot, as_is.output, entry.tree, t)
    return tree.model_copy(update=flag) if tree is not None else None


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

    elements, covers = _assemble(scenario, _as_is(), t)
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


def check_intervention(data: InterventionCreate, t: int, session_id: str = "default") -> InterventionCheck:
    """What placing this card at year `t` would do, without placing it.

    Only a card that clears its area has anything to say (see clearing.py);
    any other gets an empty answer. It is looked at against the scenario as
    it is now, earlier clearings included, and it is the same analysis the
    clearing is then applied from, so what is shown is what happens."""
    if data.card_type not in CLEARING_CARDS:
        return InterventionCheck()
    report = analyse(_scenario(store.list_interventions(session_id)).layout, data.geometry, t)
    replaced: dict[str, float] = {}
    for covered in report.covers:
        if covered.needs_warning:
            replaced[covered.cover_type] = replaced.get(covered.cover_type, 0.0) + covered.region.area
    return InterventionCheck(
        blocking=[CheckBlocking(id=b.id, type=b.type) for b in report.blocking],
        warnings=[
            CheckWarning(code="cover_replaced", cover_type=cover_type, area_m2=round(area, 1))
            for cover_type, area in sorted(replaced.items())
        ],
        clearing=ClearingSummary(
            elements_by_type=dict(sorted(report.elements_by_type.items())),
            cover_area_m2_by_type={k: round(v, 1) for k, v in sorted(report.cover_area_by_type.items())},
        ),
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
