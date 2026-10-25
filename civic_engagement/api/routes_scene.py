from fastapi import APIRouter, Depends

from civic_engagement.access import Access, access
from civic_engagement.models.schema import (
    BaselineScene,
    DeferredIndicators,
    IndicatorDescriptors,
    IndicatorSeries,
    SceneResponse,
)
from civic_engagement.scene import (
    current_scene,
    deferred_indicators,
    indicator_descriptors,
    indicator_series,
    load_baseline,
    validated_t,
)
from civic_engagement.store.state import store

router = APIRouter()


@router.get("/baseline", response_model=BaselineScene)
def get_baseline() -> BaselineScene:
    return load_baseline()


@router.get("/scene", response_model=SceneResponse)
def get_scene(t: int = 0, who: Access = Depends(access)) -> SceneResponse:
    return current_scene(validated_t(t), who.team)


@router.get("/session/revision")
def get_session_revision(who: Access = Depends(access)) -> dict[str, str]:
    """Cheap to ask: a window checks it when it comes back into focus and
    fetches the scene only if it differs from its scene's `revision`."""
    return {"revision": store.revision(who.team)}


@router.get("/indicators/descriptors", response_model=IndicatorDescriptors)
def get_indicator_descriptors() -> IndicatorDescriptors:
    return indicator_descriptors()


@router.get("/indicators/deferred", response_model=DeferredIndicators)
def get_deferred_indicators(t: int = 0, who: Access = Depends(access)) -> DeferredIndicators:
    """The indicators too slow for the scene (two fields, for the urban
    thermal ones), which the scene needn't wait for."""
    return deferred_indicators(validated_t(t), who.team)


@router.get("/indicators/series", response_model=IndicatorSeries)
def get_indicator_series(who: Access = Depends(access)) -> IndicatorSeries:
    return indicator_series(who.team)
