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
import os
import threading
from collections import OrderedDict
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
from civic_engagement.store.state import DEFAULT_TEAM, store

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


# The evaluations of the last intervention sets asked about, the least
# recently used dropped first: one per team at least, so that teams with
# different scenes don't re-evaluate each other's at every request. Moving
# the year slider doesn't change the interventions, so it never misses; an
# edit does, and re-evaluates.
EVALUATIONS = int(os.environ.get("CIVIC_ENGAGEMENT_EVALUATIONS", "8"))
_scenario_cache: OrderedDict[str, Any] = OrderedDict()
_cache_lock = threading.Lock()


def interventions_key(interventions: list[Intervention]) -> str:
    """Identifies a set of interventions, for caching what depends on it.
    Their authors don't change what they evaluate to."""
    return json.dumps(
        [i.model_dump(mode="json", exclude={"created_by", "updated_by"}) for i in interventions], sort_keys=True
    )


def evaluation(interventions: list[Intervention]) -> Any:
    """The pack's evaluation of the scenario with these interventions."""
    if not interventions:
        return _as_is()
    key = interventions_key(interventions)
    with _cache_lock:
        evaluated = _scenario_cache.get(key)
        if evaluated is not None:
            _scenario_cache.move_to_end(key)
            return evaluated
    # Outside the lock: two teams' evaluations run side by side (the same
    # one asked twice at once is evaluated twice, rarely).
    evaluated = _evaluate(interventions)
    with _cache_lock:
        _scenario_cache[key] = evaluated
        while len(_scenario_cache) > EVALUATIONS:
            _scenario_cache.popitem(last=False)
    return evaluated


def indicator_descriptors() -> IndicatorDescriptors:
    return active_pack().indicators


def current_scene(t: int = 0, team: str = DEFAULT_TEAM) -> SceneResponse:
    pack = active_pack()
    baseline = load_baseline()
    # Read before the interventions: a change landing in between makes the
    # window refresh once more, never miss it.
    revision = store.revision(team)
    interventions = store.list_interventions(team)
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


def deferred_indicators(t: int, team: str = DEFAULT_TEAM) -> DeferredIndicators:
    """The deferred indicators at year t, with and without the team's
    interventions."""
    pack = active_pack()
    return DeferredIndicators(
        t=t,
        scenario=pack.deferred_values(store.list_interventions(team), t),
        baseline=pack.deferred_values([], t),
    )


def indicator_series(team: str = DEFAULT_TEAM) -> IndicatorSeries:
    """Every indicator for every year of the horizon, with and without the
    team's interventions — the "Indicatori" tab's time series."""
    pack = active_pack()
    interventions = store.list_interventions(team)
    scenario = evaluation(interventions)
    years = list(range(MIN_T, MAX_T + 1))
    baseline_deferred = pack.deferred_series([], years)
    scenario_deferred = pack.deferred_series(interventions, years)
    return IndicatorSeries(
        years=years,
        baseline=[{**pack.indicator_values(_as_is(), t), **baseline_deferred[t]} for t in years],
        scenario=[{**pack.indicator_values(scenario, t), **scenario_deferred[t]} for t in years],
    )
