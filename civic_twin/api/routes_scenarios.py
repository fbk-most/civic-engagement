from fastapi import APIRouter, HTTPException

from civic_twin.models.schema import ScenarioInfo, ScenarioSave, SceneResponse
from civic_twin.scene import MAX_T, MIN_T, current_scene
from civic_twin.store.scenarios import ScenarioError, delete_scenario, list_scenarios, read_scenario, save_scenario
from civic_twin.store.state import store

router = APIRouter()


def _validated_t(t: int) -> int:
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return t


@router.get("/scenarios", response_model=list[ScenarioInfo])
def get_scenarios() -> list[ScenarioInfo]:
    return list_scenarios()


@router.post("/scenarios", response_model=ScenarioInfo)
def post_scenario(data: ScenarioSave) -> ScenarioInfo:
    """Saves the session's interventions as a scenario. 409 if one with the
    same id exists and `overwrite` isn't set."""
    try:
        return save_scenario(data.name, store.list_interventions(), overwrite=data.overwrite)
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=f"Scenario {error} already exists") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/scenarios/{scenario}/load", response_model=SceneResponse)
def load_scenario(scenario: str, t: int = 0) -> SceneResponse:
    """The session becomes the scenario's interventions (the session as it
    was is set aside on disk); every open window follows within seconds."""
    validated_t = _validated_t(t)
    try:
        _, interventions = read_scenario(scenario)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Scenario {scenario} not found") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    store.replace(interventions)
    return current_scene(validated_t)


@router.delete("/scenarios/{scenario}", status_code=204)
def remove_scenario(scenario: str) -> None:
    try:
        delete_scenario(scenario)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Scenario {scenario} not found") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/session/clear", response_model=SceneResponse)
def clear_session(t: int = 0) -> SceneResponse:
    """No interventions: a fresh start (the session as it was is set aside)."""
    validated_t = _validated_t(t)
    store.replace([])
    return current_scene(validated_t)
