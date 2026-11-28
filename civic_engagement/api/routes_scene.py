from fastapi import APIRouter, Depends, Query

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
from civic_engagement.store.notes import notes
from civic_engagement.store.state import store
from civic_engagement.store.storage import restart_needed

router = APIRouter()

# `scenario=<id>` on the scene, the deferred indicators and the series (and
# the pack's routes that follow, like the urban /thermal-field): one of the
# team's saved scenarios or the site's presets instead of the current scene,
# for comparing two (see scene.scene_interventions).
Scenario = Query(None, description="A saved scenario or preset of the team instead of its current scene")


@router.get("/baseline", response_model=BaselineScene)
def get_baseline() -> BaselineScene:
    return load_baseline()


@router.get("/scene", response_model=SceneResponse)
def get_scene(t: int = 0, scenario: str | None = Scenario, who: Access = Depends(access)) -> SceneResponse:
    return current_scene(validated_t(t), who.team, scenario)


@router.get("/session/revision")
def get_session_revision(who: Access = Depends(access)) -> dict:
    """Cheap to ask: a window checks it when it comes back into focus and
    fetches the scene only if it differs from its scene's `revision`. With
    `restart_needed`, it says the app must be started again for changes to
    be saved (store/storage.py). With `phase`, the team's: a window asks
    again what it may do (GET /auth/me) when it changes. With `notes`, the
    revision of the team's notes (store/notes.py), apart from the scene's:
    a note changed makes the windows fetch the notes, not the scene."""
    return {
        "revision": store.revision(who.team),
        "notes": notes.revision(who.team),
        "restart_needed": restart_needed(),
        "phase": who.phase,
    }


@router.get("/indicators/descriptors", response_model=IndicatorDescriptors)
def get_indicator_descriptors() -> IndicatorDescriptors:
    return indicator_descriptors()


@router.get("/indicators/deferred", response_model=DeferredIndicators)
def get_deferred_indicators(
    t: int = 0, scenario: str | None = Scenario, who: Access = Depends(access)
) -> DeferredIndicators:
    """The indicators too slow for the scene (two fields, for the urban
    thermal ones), which the scene needn't wait for."""
    return deferred_indicators(validated_t(t), who.team, scenario)


@router.get("/indicators/series", response_model=IndicatorSeries)
def get_indicator_series(scenario: str | None = Scenario, who: Access = Depends(access)) -> IndicatorSeries:
    return indicator_series(who.team, scenario)
