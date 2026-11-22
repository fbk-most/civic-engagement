from fastapi import APIRouter, Depends, HTTPException

from civic_engagement.access import Access, access, editor
from civic_engagement.config import SITE
from civic_engagement.domain import active_pack
from civic_engagement.geo_utils import footprints, within_boundary
from civic_engagement.models.schema import CardSpec, Intervention, InterventionCreate, InterventionUpdate, SceneResponse
from civic_engagement.scene import current_scene, load_baseline, validated_t
from civic_engagement.store.state import AlreadyPlaced, store

router = APIRouter()


def _refusal(status_code: int, message: str, message_en: str) -> HTTPException:
    """A refusal the team reads: its detail in both languages (the
    frontend shows the one of the interface)."""
    return HTTPException(status_code=status_code, detail={"message": message, "message_en": message_en})


# A card outside the site (the frontend checks first).
OUTSIDE_BOUNDARY = (
    "Le carte vanno posizionate dentro il confine del sito.",
    "Cards go within the site’s boundary.",
)


@router.get("/interventions", response_model=list[Intervention])
def list_interventions(who: Access = Depends(access)) -> list[Intervention]:
    return store.list_interventions(who.team)


def _card(card_type: str) -> CardSpec:
    card = next((card for card in active_pack().cards if card.card_type == card_type), None)
    if card is None:
        raise HTTPException(status_code=422, detail=f"Unknown card type {card_type!r}")
    return card


def _refused(data: InterventionCreate) -> None:
    refused = active_pack().refused_intervention(data)
    if refused:
        raise _refusal(422, *refused)


def _placed(data: InterventionCreate) -> InterventionCreate:
    """The card as it's kept: its geometry by its placement type (the
    buildings' footprints, or none), or a 409/422 saying why it can't be
    placed."""
    card = _card(data.card_type)
    if card.placement_type == "none":
        data = data.model_copy(update={"geometry": None, "element_ids": None})
    elif card.placement_type == "building":
        buildings = {e.id: e for e in load_baseline().elements if e.type == "building"}
        ids = list(dict.fromkeys(data.element_ids or []))
        if not ids or any(i not in buildings for i in ids):
            raise _refusal(
                422,
                f"«{card.label}» va posizionata su uno o più edifici del sito.",
                f"“{card.label_en}” goes on one or more of the site’s buildings.",
            )
        data = data.model_copy(update={"geometry": footprints([buildings[i].geometry for i in ids]), "element_ids": ids})
    elif data.geometry is None:
        raise HTTPException(status_code=422, detail=f"A {card.placement_type} card needs a geometry")
    else:
        data = data.model_copy(update={"element_ids": None})
    # Cards are for the site: what's drawn past its boundary is context. A
    # provisional boundary (a placeholder circle, not drawn) doesn't bind.
    if (
        data.geometry is not None
        and SITE.boundary_status == "surveyed"
        and not within_boundary(data.geometry, SITE.site_boundary_geojson)
    ):
        raise _refusal(422, *OUTSIDE_BOUNDARY)
    _refused(data)
    return data


@router.post("/interventions", response_model=SceneResponse)
def create_intervention(data: InterventionCreate, t: int = 0, who: Access = Depends(editor)) -> SceneResponse:
    year = validated_t(t)
    data = _placed(data)
    card = _card(data.card_type)
    try:
        store.add_intervention(data, year, who.team, who.author, single=card.single)
    except AlreadyPlaced as error:
        raise _refusal(
            409,
            f"Lo scenario ha già «{card.label}»: modifica quella.",
            f"The scenario already has “{card.label_en}”: edit that one.",
        ) from error
    return current_scene(year, who.team)


@router.patch("/interventions/{intervention_id}", response_model=SceneResponse)
def update_intervention(
    intervention_id: str, data: InterventionUpdate, t: int = 0, who: Access = Depends(editor)
) -> SceneResponse:
    year = validated_t(t)
    placed = next((i for i in store.list_interventions(who.team) if i.id == intervention_id), None)
    if placed is None:
        raise HTTPException(status_code=404, detail="Intervention not found")
    # The pack's rules hold for the new parameters too.
    _refused(InterventionCreate(**{**placed.model_dump(include=set(InterventionCreate.model_fields)), "params": data.params}))
    if not store.update_intervention(intervention_id, data.params, team=who.team, author=who.author):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(year, who.team)


@router.delete("/interventions/{intervention_id}", response_model=SceneResponse)
def delete_intervention(intervention_id: str, t: int = 0, who: Access = Depends(editor)) -> SceneResponse:
    if not store.delete_intervention(intervention_id, team=who.team):
        raise HTTPException(status_code=404, detail="Intervention not found")
    return current_scene(validated_t(t), who.team)
