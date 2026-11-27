from fastapi import APIRouter

from civic_engagement.domain import active_pack
from civic_engagement.models.schema import CardSpec, ViewSpec

router = APIRouter()


@router.get("/cards", response_model=list[CardSpec])
def get_cards() -> list[CardSpec]:
    return active_pack().cards


@router.get("/views", response_model=list[ViewSpec])
def get_views() -> list[ViewSpec]:
    """The pack's views (civic_engagement/views.py); which of them a team
    may show now is in GET /auth/me."""
    return active_pack().views
