from fastapi import APIRouter, HTTPException

from civic_engagement.domain import active_pack
from civic_engagement.models.schema import BuildingChoices, CardSpec

router = APIRouter()


@router.get("/cards", response_model=list[CardSpec])
def get_cards() -> list[CardSpec]:
    return active_pack().cards


@router.get("/cards/{card_type}/buildings", response_model=BuildingChoices)
def get_building_choices(card_type: str) -> BuildingChoices:
    """The buildings a card on buildings can take, and what each is."""
    card = next((c for c in active_pack().cards if c.card_type == card_type), None)
    if card is None:
        raise HTTPException(status_code=404, detail=f"Unknown card type {card_type!r}")
    if card.placement_type != "building":
        raise HTTPException(status_code=422, detail=f"{card_type!r} isn't placed on buildings")
    return BuildingChoices(buildings=active_pack().building_choices(card_type))
