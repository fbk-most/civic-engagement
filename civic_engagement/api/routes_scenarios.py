from fastapi import APIRouter, Depends, HTTPException

from civic_engagement.access import Access, access, editor
from civic_engagement.models.schema import ScenarioInfo, ScenarioSave, SceneResponse
from civic_engagement.scene import current_scene, validated_t
from civic_engagement.store.scenarios import (
    ScenarioError,
    delete_scenario,
    library,
    list_scenarios,
    read_scenario,
    save_scenario,
)
from civic_engagement.store.state import store

router = APIRouter()


@router.get("/scenarios", response_model=list[ScenarioInfo])
def get_scenarios(who: Access = Depends(access)) -> list[ScenarioInfo]:
    """The team's scenarios, and the site's presets (`preset`)."""
    return list_scenarios(*library(who.team))


@router.post("/scenarios", response_model=ScenarioInfo)
def post_scenario(data: ScenarioSave, who: Access = Depends(editor)) -> ScenarioInfo:
    """Saves the team's interventions as a scenario. 409 if one with the
    same id exists and `overwrite` isn't set."""
    try:
        return save_scenario(data.name, store.list_interventions(who.team), data.overwrite, *library(who.team))
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=f"Scenario {error} already exists") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/scenarios/{scenario}/load", response_model=SceneResponse)
def load_scenario(scenario: str, t: int = 0, who: Access = Depends(editor)) -> SceneResponse:
    """The team's scene becomes the scenario's interventions (the scene as it
    was is set aside); every window of the team follows within seconds."""
    year = validated_t(t)
    try:
        _, interventions = read_scenario(scenario, *library(who.team))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Scenario {scenario} not found") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    store.replace(interventions, who.team)
    return current_scene(year, who.team)


@router.delete("/scenarios/{scenario}", status_code=204)
def remove_scenario(scenario: str, who: Access = Depends(editor)) -> None:
    try:
        delete_scenario(scenario, *library(who.team))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Scenario {scenario} not found") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/session/clear", response_model=SceneResponse)
def clear_session(t: int = 0, who: Access = Depends(editor)) -> SceneResponse:
    """No interventions: a fresh start (the scene as it was is set aside)."""
    year = validated_t(t)
    store.replace([], who.team)
    return current_scene(year, who.team)
