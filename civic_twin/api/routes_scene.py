from fastapi import APIRouter, HTTPException

from civic_twin.models.schema import (
    BaselineScene,
    IndicatorSeries,
    SceneResponse,
    ThermalFieldResponse,
    ThermalIndicators,
)
from civic_twin.scene import (
    MAX_T,
    MIN_T,
    calendar_date,
    current_scene,
    indicator_series,
    load_baseline,
    thermal_field,
    thermal_indicators,
)

from civic_twin.store.state import store

router = APIRouter()


@router.get("/baseline", response_model=BaselineScene)
def get_baseline() -> BaselineScene:
    return load_baseline()


@router.get("/scene", response_model=SceneResponse)
def get_scene(t: int = 0) -> SceneResponse:
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return current_scene(t)


@router.get("/session/revision")
def get_session_revision() -> dict[str, str]:
    """Cheap to ask: a window checks it when it comes back into focus and
    fetches the scene only if it differs from its scene's `revision`."""
    return {"revision": store.revision}


@router.get("/indicators/thermal", response_model=ThermalIndicators)
def get_thermal_indicators(t: int = 0) -> ThermalIndicators:
    """Apart from the scene: two fields, which the scene needn't wait for."""
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return thermal_indicators(t)


@router.get("/indicators/series", response_model=IndicatorSeries)
def get_indicator_series() -> IndicatorSeries:
    return indicator_series()


@router.get("/thermal-field", response_model=ThermalFieldResponse)
def get_thermal_field(t: int = 0, month: int = 6, day: int = 21, as_is: bool = False) -> ThermalFieldResponse:
    """Felt temperature across the site, hour by hour, on one day of year t
    — with the session's interventions, or without any (`as_is`)."""
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    try:
        calendar_date(t, month, day)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return thermal_field(t, month, day, as_is=as_is)
