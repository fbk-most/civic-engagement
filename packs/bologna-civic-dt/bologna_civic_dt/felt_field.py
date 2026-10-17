"""The felt-temperature field as the app serves it: one scenario, one year,
one day (the model is thermal_field.py), cached, and the thermal indicators
read off it at the reference moment.

The core's scene module is imported where used, not here: it reads the
registered pack when imported, and this module is imported while the pack
is being built (see civic_engagement/domain.py).
"""

from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

import numpy as np

from bologna_civic_dt.field_grid import Anchor, Frame, rasterize
from bologna_civic_dt.indicators import thermal_values
from bologna_civic_dt.parameters import SITE_TIMEZONE, THERMAL_REFERENCE
from bologna_civic_dt.solar import Day
from bologna_civic_dt.thermal_field import FeltTemperatureField, FieldEvaluator, build_field_model
from bologna_civic_dt.types import ThermalFieldResponse
from civic_engagement.fields import ComputeCache, encode_bytes
from civic_engagement.models.schema import FieldGrid, IndicatorValues, Intervention


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
# date as the year slider moves, and the indicators' reference moment. Side
# by side, but not too many at once: each takes a few hundred MB while it
# runs, and its sun rays already spread over every core.
FIELD_CACHE_SIZE = 24
FIELDS_AT_ONCE = 2
_fields: ComputeCache[Field] = ComputeCache(FIELD_CACHE_SIZE, FIELDS_AT_ONCE)


def calendar_date(t: int, month: int, day: int) -> date:
    """The date `t` years from now — the 3D view's year is the current
    calendar year plus t (frontend/src/three/sun.ts)."""
    return date(datetime.now(ZoneInfo(SITE_TIMEZONE)).year + t, month, day)


def _field(interventions: list[Intervention], t: int, day: date) -> Field:
    from civic_engagement.scene import interventions_key

    return _fields.get((interventions_key(interventions), t, day), lambda: _compute_field(interventions, t, day))


def _compute_field(interventions: list[Intervention], t: int, day: date) -> Field:
    from bologna_civic_dt.pack import assemble_all
    from civic_engagement.scene import evaluation, load_baseline

    elements, covers = assemble_all(evaluation(interventions), t)
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


def thermal(interventions: list[Intervention], t: int) -> IndicatorValues:
    """The thermal indicators at year t: the field at the reference moment."""
    month, day, hour = THERMAL_REFERENCE
    field = _field(interventions, t, calendar_date(t, month, day))
    return thermal_values(field.mean_felt[hour], field.heat_stress_pct[hour], field.sunlit_pct[hour])


# The yearly series computes the thermal indicators every few years only
# (a field takes about half a second) and interpolates in between.
THERMAL_SERIES_STEP = 5


def thermal_series(interventions: list[Intervention], years: list[int]) -> list[IndicatorValues]:
    sampled = sorted({*years[::THERMAL_SERIES_STEP], years[-1]})
    values = {t: thermal(interventions, t) for t in sampled}
    return [
        {name: round(float(np.interp(t, sampled, [values[s][name] for s in sampled])), 1) for name in values[sampled[0]]}
        for t in years
    ]


SCALE_C = 0.5
OFFSET_C = -40.0
NODATA = 255


def thermal_field(t: int, month: int, day: int, as_is: bool = False, session_id: str = "default") -> ThermalFieldResponse:
    from civic_engagement.store.state import store

    interventions = [] if as_is else store.list_interventions(session_id)
    field = _field(interventions, t, calendar_date(t, month, day))
    return ThermalFieldResponse(
        t=t,
        date=calendar_date(t, month, day).isoformat(),
        scenario="as_is" if as_is else "current",
        grid=FieldGrid(
            anchor_lng=field.anchor.lng0, anchor_lat=field.anchor.lat0,
            x0=field.frame.x0, y0=field.frame.y0, nx=field.frame.nx, ny=field.frame.ny, cell_m=field.frame.cell,
        ),
        hours=field.felt.shape[0],
        data=encode_bytes(field.felt, SCALE_C, OFFSET_C, NODATA),
        scale=SCALE_C,
        offset=OFFSET_C,
        nodata=NODATA,
        air_temperature_c=[round(float(v), 1) for v in field.air_temperature],
        mean_felt_c=[round(float(v), 1) for v in field.mean_felt],
        heat_stress_pct=[round(float(v), 1) for v in field.heat_stress_pct],
        sunlit_pct=[round(float(v), 1) for v in field.sunlit_pct],
    )
