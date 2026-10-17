"""Shared helper for building the resolved scene, used by both the scene and
intervention routes (interventions endpoints return the freshly resolved
scene directly, saving the frontend a second round trip).

Each scenario — the baseline plus one set of interventions — is evaluated
once by the urban model for the whole horizon (see bologna_civic_dt/model.py);
moving the year slider only reads another year of the same evaluation. The
"as is" scenario (no interventions) is evaluated once per site, and paired
with the current one here: the model itself knows nothing about baselines.
"""

import base64
import json
import math
import threading
from collections import OrderedDict
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

import numpy as np

from civic_engagement.config import SITE
from bologna_civic_dt.encode import encode
from bologna_civic_dt.field_grid import Anchor, Frame, rasterize
from bologna_civic_dt.layout import Layout, TreeSlot, build_layout
from bologna_civic_dt.model import (
    COVER_TYPES,
    INCLUSION_GROUPS,
    UrbanEvaluator,
    UrbanOutput,
    build_model,
)
from bologna_civic_dt.parameters import (
    HORIZON_YEARS,
    SITE_TIMEZONE,
    THERMAL_REFERENCE,
)
from bologna_civic_dt.solar import Day
from bologna_civic_dt.thermal_field import (
    FeltTemperatureField,
    FieldEvaluator,
    build_field_model,
)
from bologna_civic_dt.trees import species_traits
from civic_engagement.models.schema import (
    BaselineScene,
    CoverPolygon,
    DiscreteElement,
    FieldGrid,
    IndicatorSeries,
    Intervention,
    SceneResponse,
    ThermalFieldResponse,
    ThermalIndicators,
)
from civic_engagement.store.state import store

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


def _key(interventions: list[Intervention]) -> str:
    return json.dumps([i.model_dump(mode="json") for i in interventions], sort_keys=True)


def _scenario(interventions: list[Intervention]) -> Evaluated:
    if not interventions:
        return _as_is()
    key = _key(interventions)
    # Read once and kept in hand: requests run in threads, and another one
    # may replace the entry in between.
    evaluated = _scenario_cache.get(key)
    if evaluated is None:
        evaluated = _evaluate(interventions)
        _scenario_cache.clear()
        _scenario_cache[key] = evaluated
    return evaluated


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


# --- felt temperature: one scenario, one year, one day ------------------------------


@lru_cache(maxsize=1)
def _field_model() -> FeltTemperatureField:
    return build_field_model()


@dataclass(frozen=True)
class Field:
    anchor: Anchor
    frame: Frame
    felt: np.ndarray  # (hour, y, x), float32, NaN outside the open space
    air_temperature: np.ndarray  # (hour,)
    mean_felt: np.ndarray  # (hour,)
    heat_stress_pct: np.ndarray  # (hour,)
    sunlit_pct: np.ndarray  # (hour,)


# The fields asked about most recently (about 5 MB each): the sun control's
# date as the year slider moves, and the indicators' reference moment.
FIELD_CACHE_SIZE = 24
_field_cache: OrderedDict[tuple[str, int, date], Field] = OrderedDict()
# Guards the cache and the fields being computed, briefly: the computing
# itself runs outside it, so fields asked for together (with and without the
# interventions, the indicators') are computed side by side.
_field_lock = threading.Lock()
_fields_computing: dict[tuple[str, int, date], Future] = {}
# Side by side, but not too many at once: each takes a few hundred MB while
# it runs, and its sun rays already spread over every core.
FIELDS_AT_ONCE = 2
_field_slots = threading.Semaphore(FIELDS_AT_ONCE)


def calendar_date(t: int, month: int, day: int) -> date:
    """The date `t` years from now — the 3D view's year is the current
    calendar year plus t (frontend/src/three/sun.ts)."""
    return date(datetime.now(ZoneInfo(SITE_TIMEZONE)).year + t, month, day)


def _field(interventions: list[Intervention], t: int, day: date) -> Field:
    key = (_key(interventions), t, day)
    with _field_lock:
        if key in _field_cache:
            _field_cache.move_to_end(key)
            return _field_cache[key]
        # Already being computed for another request: wait for that one.
        pending = _fields_computing.get(key)
        if pending is None:
            pending = _fields_computing[key] = Future()
            mine = True
        else:
            mine = False
    if not mine:
        return pending.result()
    try:
        with _field_slots:
            field = _compute_field(interventions, t, day)
    except BaseException as error:
        with _field_lock:
            del _fields_computing[key]
        pending.set_exception(error)
        raise
    with _field_lock:
        _field_cache[key] = field
        if len(_field_cache) > FIELD_CACHE_SIZE:
            _field_cache.popitem(last=False)
        del _fields_computing[key]
    pending.set_result(field)
    return field


def _compute_field(interventions: list[Intervention], t: int, day: date) -> Field:
    elements, covers = _assemble(_scenario(interventions), t)
    rasters = rasterize(load_baseline().site_boundary, elements, covers)
    output = FieldEvaluator(_field_model()).run(rasters, Day(day, rasters.anchor.lat0, rasters.anchor.lng0, years_ahead=t))
    return Field(
        anchor=rasters.anchor,
        frame=rasters.field,
        felt=output.felt.astype(np.float32),
        air_temperature=output.air_temperature,
        mean_felt=output.mean_felt,
        heat_stress_pct=output.heat_stress_pct,
        sunlit_pct=output.sunlit_pct,
    )


def _thermal(interventions: list[Intervention], t: int) -> dict:
    """The thermal indicators at year t: the field at the reference moment."""
    month, day, hour = THERMAL_REFERENCE
    field = _field(interventions, t, calendar_date(t, month, day))
    return {
        "felt_temperature_c": round(float(field.mean_felt[hour]), 1),
        "heat_stress_pct": round(float(field.heat_stress_pct[hour]), 1),
        "sunlit_pct": round(float(field.sunlit_pct[hour]), 1),
    }


# The yearly series computes the thermal indicators every few years only
# (a field takes about half a second) and interpolates in between.
THERMAL_SERIES_STEP = 5


def _thermal_series(interventions: list[Intervention], years: list[int]) -> list[dict]:
    sampled = sorted({*years[::THERMAL_SERIES_STEP], years[-1]})
    values = {t: _thermal(interventions, t) for t in sampled}
    return [
        {name: round(float(np.interp(t, sampled, [values[s][name] for s in sampled])), 1) for name in values[sampled[0]]}
        for t in years
    ]


SCALE_C = 0.5
OFFSET_C = -40.0
NODATA = 255


def thermal_field(t: int, month: int, day: int, as_is: bool = False, session_id: str = "default") -> ThermalFieldResponse:
    interventions = [] if as_is else store.list_interventions(session_id)
    field = _field(interventions, t, calendar_date(t, month, day))
    quantized = np.round((field.felt - OFFSET_C) / SCALE_C)
    data = np.where(np.isnan(field.felt), NODATA, np.clip(quantized, 0, NODATA - 1)).astype(np.uint8)
    return ThermalFieldResponse(
        t=t,
        date=calendar_date(t, month, day).isoformat(),
        scenario="as_is" if as_is else "current",
        grid=FieldGrid(
            anchor_lng=field.anchor.lng0, anchor_lat=field.anchor.lat0,
            x0=field.frame.x0, y0=field.frame.y0, nx=field.frame.nx, ny=field.frame.ny, cell_m=field.frame.cell,
        ),
        hours=field.felt.shape[0],
        data=base64.b64encode(data.tobytes()).decode("ascii"),
        scale=SCALE_C,
        offset=OFFSET_C,
        nodata=NODATA,
        air_temperature_c=[round(float(v), 1) for v in field.air_temperature],
        mean_felt_c=[round(float(v), 1) for v in field.mean_felt],
        heat_stress_pct=[round(float(v), 1) for v in field.heat_stress_pct],
        sunlit_pct=[round(float(v), 1) for v in field.sunlit_pct],
    )


def _optional(value: float, digits: int) -> float | None:
    return None if math.isnan(value) else round(value, digits)


def _indicators(output: UrbanOutput, t: int, thermal: dict | None) -> dict:
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
        "thermal_comfort": thermal,
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
        "maintenance": {
            "annual_eur": round(at("maintenance"), 2),
            "cumulative_eur": round(at("maintenance_cumulative"), 2),
        },
    }


def current_scene(t: int = 0, session_id: str = "default") -> SceneResponse:
    baseline = load_baseline()
    # Read before the interventions: a change landing in between makes the
    # window refresh once more, never miss it.
    revision = store.revision
    interventions = store.list_interventions(session_id)
    scenario = _scenario(interventions)

    elements, covers = _assemble(scenario, t)
    if not SITE.show_road_markings:
        elements = [e for e in elements if e.type not in ROAD_MARKING_TYPES]

    return SceneResponse(
        site_id=SITE.site_id,
        site_name=SITE.name,
        site_boundary=baseline.site_boundary,
        boundary_status=SITE.boundary_status,
        elements=elements,
        covers=covers,
        t=t,
        # The thermal indicators come apart (see `thermal_indicators`): two
        # fields, over a second, that the rest of the scene needn't wait for.
        indicators=_indicators(scenario.output, t, None),
        baseline_indicators=_indicators(_as_is().output, t, None),
        interventions=interventions,
        revision=revision,
    )


def thermal_indicators(t: int, session_id: str = "default") -> ThermalIndicators:
    """The thermal indicators at year t, with and without the session's
    interventions."""
    return ThermalIndicators(
        t=t,
        scenario=_thermal(store.list_interventions(session_id), t),
        baseline=_thermal([], t),
    )


def indicator_series(session_id: str = "default") -> IndicatorSeries:
    """Every indicator for every year of the horizon, with and without the
    session's interventions — the "Indicatori" tab's time series."""
    interventions = store.list_interventions(session_id)
    scenario = _scenario(interventions)
    years = list(range(MIN_T, MAX_T + 1))
    baseline_thermal = _thermal_series([], years)
    scenario_thermal = _thermal_series(interventions, years)
    return IndicatorSeries(
        years=years,
        baseline=[_indicators(_as_is().output, t, baseline_thermal[t]) for t in years],
        scenario=[_indicators(scenario.output, t, scenario_thermal[t]) for t in years],
    )
