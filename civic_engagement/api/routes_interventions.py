from fastapi import APIRouter, HTTPException

from civic_engagement.config import SITE
from civic_engagement.domain import active_pack
from civic_engagement.geo_utils import within_boundary
from civic_engagement.models.schema import Intervention, InterventionCreate, InterventionUpdate, SceneResponse
from civic_engagement.scene import current_scene, validated_t
from civic_engagement.store.state import store

router = APIRouter()

# The 422 detail for a card outside the site (the frontend checks first).
OUTSIDE_BOUNDARY = "outside the site boundary"


@router.get("/interventions", response_model=list[Intervention])
def list_interventions() -> list[Intervention]:
    return store.list_interventions()


@router.post("/interventions", response_model=SceneResponse)
def create_intervention(data: InterventionCreate, t: int = 0) -> SceneResponse:
    year = validated_t(t)
    if data.card_type not in {card.card_type for card in active_pack().cards}:
        raise HTTPException(status_code=422, detail=f"Unknown card type {data.card_type!r}")
    # Cards are for the site: what's drawn past its boundary is context. A
    # provisional boundary (a placeholder circle, not drawn) doesn't bind.
    if SITE.boundary_status == "surveyed" and not within_boundary(data.geometry, SITE.site_boundary_geojson):
        raise HTTPException(status_code=422, detail=OUTSIDE_BOUNDARY)
    store.add_intervention(data, planted_year=year)
    return current_scene(year)


@router.patch("/interventions/{intervention_id}", response_model=SceneResponse)
def update_intervention(intervention_id: str, data: InterventionUpdate, t: int = 0) -> SceneResponse:
    if not store.update_intervention(intervention_id, data.params):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(validated_t(t))


@router.delete("/interventions/{intervention_id}", response_model=SceneResponse)
def delete_intervention(intervention_id: str, t: int = 0) -> SceneResponse:
    if not store.delete_intervention(intervention_id):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(validated_t(t))
