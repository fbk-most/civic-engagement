from fastapi import APIRouter, HTTPException

from civic_twin.api.routes_cards import validate_params
from civic_twin.models.schema import (
    Intervention,
    InterventionCheck,
    InterventionCreate,
    InterventionUpdate,
    SceneResponse,
)
from civic_twin.scene import MAX_T, MIN_T, check_intervention, current_scene
from civic_twin.store.state import store

router = APIRouter()


def _validated_t(t: int) -> int:
    if not MIN_T <= t <= MAX_T:
        raise HTTPException(status_code=422, detail=f"t must be between {MIN_T} and {MAX_T}")
    return t


@router.get("/interventions", response_model=list[Intervention])
def list_interventions() -> list[Intervention]:
    return store.list_interventions()


@router.post("/interventions/check", response_model=InterventionCheck)
def check_new_intervention(data: InterventionCreate, t: int = 0) -> InterventionCheck:
    """What placing this card would do, without placing it: the errors that
    would refuse it, the warnings to confirm, and what it would clear."""
    validate_params(data.card_type, data.params)
    return check_intervention(data, _validated_t(t))


@router.post("/interventions", response_model=SceneResponse)
def create_intervention(data: InterventionCreate, t: int = 0) -> SceneResponse:
    validated_t = _validated_t(t)
    validate_params(data.card_type, data.params)
    check = check_intervention(data, validated_t)
    unconfirmed = [w for w in check.warnings if w.key not in data.acknowledged_warnings]
    if check.blocking or unconfirmed:
        # The request is well formed but conflicts with the scene as it is, or
        # raises a warning the user has not confirmed: 409, with the same answer
        # as the check's, so the client can show what is in the way or what to
        # confirm (see "Errors" in the README).
        raise HTTPException(status_code=409, detail=check.model_dump(mode="json"))
    store.add_intervention(data, planted_year=validated_t)
    return current_scene(validated_t)


@router.patch("/interventions/{intervention_id}", response_model=SceneResponse)
def update_intervention(intervention_id: str, data: InterventionUpdate, t: int = 0) -> SceneResponse:
    validated_t = _validated_t(t)
    intervention = store.get_intervention(intervention_id)
    if intervention is None:
        raise HTTPException(status_code=404, detail="Intervention not found")
    validate_params(intervention.card_type, data.params)
    # New parameters can change the ground it takes (a path's width, a pergola's size).
    check = check_intervention(
        InterventionCreate(
            card_type=intervention.card_type,
            geometry=intervention.geometry,
            params=data.params,
            replaces_element_id=intervention.replaces_element_id,
        ),
        intervention.planted_year,
        own_id=intervention.id,
    )
    if check.blocking:
        raise HTTPException(status_code=409, detail=check.model_dump(mode="json"))
    store.update_intervention(intervention_id, data.params)
    return current_scene(validated_t)


@router.delete("/interventions/{intervention_id}", response_model=SceneResponse)
def delete_intervention(intervention_id: str, t: int = 0) -> SceneResponse:
    if not store.delete_intervention(intervention_id):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(_validated_t(t))
