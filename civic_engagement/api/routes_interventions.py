from fastapi import APIRouter, HTTPException

from civic_engagement.models.schema import Intervention, InterventionCreate, InterventionUpdate, SceneResponse
from civic_engagement.scene import MAX_T, MIN_T, current_scene
from civic_engagement.store.state import store

router = APIRouter()


def _validated_t(t: int) -> int:
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return t


@router.get("/interventions", response_model=list[Intervention])
def list_interventions() -> list[Intervention]:
    return store.list_interventions()


@router.post("/interventions", response_model=SceneResponse)
def create_intervention(data: InterventionCreate, t: int = 0) -> SceneResponse:
    validated_t = _validated_t(t)
    store.add_intervention(data, planted_year=validated_t)
    return current_scene(validated_t)


@router.patch("/interventions/{intervention_id}", response_model=SceneResponse)
def update_intervention(intervention_id: str, data: InterventionUpdate, t: int = 0) -> SceneResponse:
    if not store.update_intervention(intervention_id, data.params):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(_validated_t(t))


@router.delete("/interventions/{intervention_id}", response_model=SceneResponse)
def delete_intervention(intervention_id: str, t: int = 0) -> SceneResponse:
    if not store.delete_intervention(intervention_id):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(_validated_t(t))
