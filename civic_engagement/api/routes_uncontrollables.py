from fastapi import APIRouter, Depends, HTTPException

from civic_engagement.access import Access, editor
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import SceneResponse, UncontrollableSpec, UncontrollablesUpdate
from civic_engagement.scene import current_scene, validated_t
from civic_engagement.store.state import store

router = APIRouter()


@router.get("/uncontrollables", response_model=list[UncontrollableSpec])
def get_uncontrollables() -> list[UncontrollableSpec]:
    """What a scenario assumes but nobody at the table decides; none for a
    pack that declares none."""
    return active_pack().uncontrollables


@router.put("/session/uncontrollables", response_model=SceneResponse)
def put_uncontrollables(data: UncontrollablesUpdate, t: int = 0, who: Access = Depends(editor)) -> SceneResponse:
    """The team's scenario under these values (those left out at their
    defaults), and "as is" under the same; every window of the team follows
    within seconds."""
    year = validated_t(t)
    pack = active_pack()
    refused = pack.refused(data.values)
    if refused:
        raise HTTPException(status_code=422, detail=refused)
    store.set_uncontrollables(pack.settled(data.values), who.team)
    return current_scene(year, who.team)
