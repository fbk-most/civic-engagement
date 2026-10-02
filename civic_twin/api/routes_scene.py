from fastapi import APIRouter, HTTPException

from civic_twin.models.schema import BaselineScene, IndicatorSeries, SceneResponse
from civic_twin.scene import MAX_T, MIN_T, current_scene, indicator_series, load_baseline

router = APIRouter()


@router.get("/baseline", response_model=BaselineScene)
def get_baseline() -> BaselineScene:
    return load_baseline()


@router.get("/scene", response_model=SceneResponse)
def get_scene(t: int = 0) -> SceneResponse:
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return current_scene(t)


@router.get("/indicators/series", response_model=IndicatorSeries)
def get_indicator_series() -> IndicatorSeries:
    return indicator_series()
