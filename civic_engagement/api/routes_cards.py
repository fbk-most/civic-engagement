from fastapi import APIRouter

from civic_engagement.domain import active_pack
from civic_engagement.models.schema import CardSpec

router = APIRouter()


@router.get("/cards", response_model=list[CardSpec])
def get_cards() -> list[CardSpec]:
    return active_pack().cards
