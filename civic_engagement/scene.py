"""Shared helper for building the resolved scene, used by both the scene and
intervention routes (interventions endpoints return the freshly resolved
scene directly, saving the frontend a second round trip).

Each scenario — the baseline plus one set of interventions — is evaluated
once by the domain pack for the whole horizon (see domain.py); moving the
year slider only reads another year of the same evaluation. The "as is"
scenario (no interventions) is evaluated once per site, and paired with the
current one here: the pack knows nothing about baselines.

Reads the registered pack when imported (see domain.py).
"""

import json
from functools import lru_cache
from typing import Any

from fastapi import HTTPException

from civic_engagement.config import SITE
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import (
    BaselineScene,
    DeferredIndicators,
    IndicatorDescriptors,
    IndicatorSeries,
    Intervention,
    SceneResponse,
)
from civic_engagement.store.state import store

# The scenario horizon: t is any integer year offset in this range, not just
# a handful of preset points.
MIN_T = 0
MAX_T = active_pack().horizon_years


def validated_t(t: int) -> int:
    """`t`, or a 422 if it's outside the horizon."""
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return t


@lru_cache(maxsize=1)
def load_baseline() -> BaselineScene:
    with open(SITE.baseline_json_path) as f:
        baseline = BaselineScene(**json.load(f))
    pack = active_pack()
    unknown = {e.type for e in baseline.elements} - pack.element_types
    unknown |= {c.cover_type for c in baseline.covers} - pack.cover_types
    if unknown:
        raise ValueError(f"{SITE.baseline_json_path}: types the {pack.id!r} pack doesn't know: {sorted(unknown)}")
    return baseline


def _evaluate(interventions: list[Intervention]) -> Any:
    return active_pack().evaluate(load_baseline(), interventions)


@lru_cache(maxsize=1)
def _as_is() -> Any:
    return _evaluate([])


# One entry: the evaluation for the last intervention set asked about. Moving
# the year slider doesn't change the interventions, so it never misses; any
# edit does, and re-evaluates.
_scenario_cache: dict[str, Any] = {}


def interventions_key(interventions: list[Intervention]) -> str:
    """Identifies a set of interventions, for caching what depends on it."""
    return json.dumps([i.model_dump(mode="json") for i in interventions], sort_keys=True)


def evaluation(interventions: list[Intervention]) -> Any:
    """The pack's evaluation of the scenario with these interventions."""
    if not interventions:
        return _as_is()
    key = interventions_key(interventions)
    # Read once and kept in hand: requests run in threads, and another one
    # may replace the entry in between.
    evaluated = _scenario_cache.get(key)
    if evaluated is None:
        evaluated = _evaluate(interventions)
        _scenario_cache.clear()
        _scenario_cache[key] = evaluated
    return evaluated


def indicator_descriptors() -> IndicatorDescriptors:
    return active_pack().indicators


def current_scene(t: int = 0, session_id: str = "default") -> SceneResponse:
    pack = active_pack()
    baseline = load_baseline()
    # Read before the interventions: a change landing in between makes the
    # window refresh once more, never miss it.
    revision = store.revision
    interventions = store.list_interventions(session_id)
    scenario = evaluation(interventions)
    elements, covers = pack.assemble(scenario, t)

    return SceneResponse(
        site_id=SITE.site_id,
        site_name=SITE.name,
        site_boundary=baseline.site_boundary,
        boundary_status=SITE.boundary_status,
        elements=elements,
        covers=covers,
        t=t,
        # The deferred indicators come apart (see `deferred_indicators`):
        # the rest of the scene needn't wait for them.
        indicators=pack.indicator_values(scenario, t),
        baseline_indicators=pack.indicator_values(_as_is(), t),
        interventions=interventions,
        revision=revision,
    )


def deferred_indicators(t: int, session_id: str = "default") -> DeferredIndicators:
    """The deferred indicators at year t, with and without the session's
    interventions."""
    pack = active_pack()
    return DeferredIndicators(
        t=t,
        scenario=pack.deferred_values(store.list_interventions(session_id), t),
        baseline=pack.deferred_values([], t),
    )


def indicator_series(session_id: str = "default") -> IndicatorSeries:
    """Every indicator for every year of the horizon, with and without the
    session's interventions — the "Indicatori" tab's time series."""
    pack = active_pack()
    interventions = store.list_interventions(session_id)
    scenario = evaluation(interventions)
    years = list(range(MIN_T, MAX_T + 1))
    baseline_deferred = pack.deferred_series([], years)
    scenario_deferred = pack.deferred_series(interventions, years)
    return IndicatorSeries(
        years=years,
        baseline=[{**pack.indicator_values(_as_is(), t), **baseline_deferred[t]} for t in years],
        scenario=[{**pack.indicator_values(scenario, t), **scenario_deferred[t]} for t in years],
    )
