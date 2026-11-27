"""The rehearsal page's API (`CIVIC_ENGAGEMENT_REHEARSAL=1`, with `pin`
only): for user tests before the container site exists, a page standing in
for it (the pack's rehearsal.html) lets a team's editor move their own
team's phase, which is otherwise the manager's alone. Off, these routes
don't exist; it must stay off for the real process."""

from dataclasses import replace

from fastapi import APIRouter, Depends, HTTPException

from civic_engagement.access import Access, access, team_store
from civic_engagement.api.routes_admin import known_phase
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import Me, PhaseSet, Rehearsal

router = APIRouter(prefix="/rehearsal")


@router.get("", response_model=Rehearsal)
def get_rehearsal(who: Access = Depends(access)) -> Rehearsal:
    """The pack's phases and views, and whether this member may move the phase."""
    pack = active_pack()
    return Rehearsal(phases=pack.phases, views=pack.views, can_set_phase=who.role == "editor")


@router.put("/phase", response_model=Me)
def put_phase(data: PhaseSet, who: Access = Depends(access)) -> Me:
    """The member's own team's phase, any (as the manager's PUT
    /admin/teams/{team}/phase): editors only. Its windows follow within
    seconds."""
    if who.role != "editor":
        raise HTTPException(status_code=403, detail="Only an editor can change the team's phase")
    team = team_store().set_phase(who.team, known_phase(data.phase))
    return replace(who, phase=team.phase).me()
