"""The manager's API (`pin` only): teams, members and their PINs, a team's
scene and phase, its export, the store's state, the PINs' throttle. Basic
credentials (access.manager);
the CLI, civic_engagement/admin.py, calls it."""

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response

from civic_engagement import digitalhub
from civic_engagement.access import manager, manager_throttle, pin_throttle, team_store
from civic_engagement.config import SITE, STARTED, memory
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import (
    AdminMember,
    AdminTeam,
    MemberCreate,
    PhaseSet,
    PhaseSpec,
    TeamCreate,
    TeamRename,
    TeamScene,
    ThrottleReset,
    ViewSpec,
)
from civic_engagement.store.notes import notes
from civic_engagement.store.scenarios import ScenarioError, delete_library, library, read_scenario, scenario_documents
from civic_engagement.store.state import store
from civic_engagement.store.storage import restart_needed, state_storage
from civic_engagement.store.teams import Member, Team, TeamConflict, TeamError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", dependencies=[Depends(manager)])


def _member(member: Member, pin: str | None = None) -> AdminMember:
    return AdminMember(id=member.id, name=member.name, role=member.role, pin_version=member.pin_version, pin=pin)


def _team(team: Team) -> AdminTeam:
    return AdminTeam(
        id=team.id,
        name=team.name,
        created_at=team.created_at,
        members=[_member(m) for m in team.members],
        interventions=len(store.list_interventions(team.id)),
        phase=team.phase,
    )


def _known(team_id: str) -> Team:
    try:
        return team_store().team(team_id)
    except TeamError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


def _scenario(scenario: str, team_id: str | None):
    """One of the team's scenarios or a site preset; without a team, a preset."""
    saved, presets = library(team_id or "default")
    try:
        return (read_scenario(scenario, saved, presets) if team_id else read_scenario(scenario, presets, None))[1]
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"Scenario {scenario} not found") from error
    except ScenarioError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get("/teams", response_model=list[AdminTeam])
def get_teams() -> list[AdminTeam]:
    return [_team(team) for team in team_store().teams()]


@router.post("/teams", response_model=AdminTeam)
def post_team(data: TeamCreate) -> AdminTeam:
    """A new team, its scene empty or the scenario `from_scenario` (a preset,
    or one of `from_team`'s scenarios)."""
    if data.from_team is not None:
        _known(data.from_team)
    interventions = _scenario(data.from_scenario, data.from_team) if data.from_scenario else []
    try:
        team = team_store().create_team(data.name)
    except TeamConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except TeamError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    # Nothing left behind by an earlier team of that id.
    store.forget(team.id)
    notes.forget(team.id)
    delete_library(library(team.id)[0])
    if interventions:
        store.replace(interventions, team.id)
    return _team(team)


@router.patch("/teams/{team_id}", response_model=AdminTeam)
def patch_team(team_id: str, data: TeamRename) -> AdminTeam:
    _known(team_id)
    try:
        return _team(team_store().rename_team(team_id, data.name))
    except TeamConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except TeamError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.delete("/teams/{team_id}", status_code=204)
def delete_team(team_id: str) -> None:
    """The team, its members, its scene (with those set aside), its notes and its scenarios."""
    _known(team_id)
    team_store().delete_team(team_id)
    store.forget(team_id)
    notes.forget(team_id)
    delete_library(library(team_id)[0])


@router.post("/teams/{team_id}/members", response_model=AdminMember)
def post_member(team_id: str, data: MemberCreate) -> AdminMember:
    """A new member; their PIN is in the answer, and only there."""
    _known(team_id)
    try:
        member, pin = team_store().add_member(team_id, data.name, data.role)
    except TeamConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except TeamError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _member(member, pin)


@router.get("/teams/{team_id}/pins", response_model=list[AdminMember])
def get_pins(team_id: str, response: Response) -> list[AdminMember]:
    """The team's members with their PINs, for the facilitators: the PIN
    None for a member from before sealed PINs (regenerate it). Logged."""
    _known(team_id)
    response.headers["Cache-Control"] = "no-store"
    pins = team_store().pins(team_id)
    unreadable = sum(pin is None for _, pin in pins)
    log.warning("The manager read the PINs of team %r%s", team_id, f" ({unreadable} not readable)" if unreadable else "")
    return [_member(member, pin) for member, pin in pins]


@router.delete("/teams/{team_id}/members/{member_id}", status_code=204)
def delete_member(team_id: str, member_id: str) -> None:
    _known(team_id)
    try:
        team_store().remove_member(team_id, member_id)
    except TeamError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/teams/{team_id}/members/{member_id}/pin", response_model=AdminMember)
def post_pin(team_id: str, member_id: str) -> AdminMember:
    """A new PIN for the member: the old one, and whoever logged in with it, is out."""
    _known(team_id)
    try:
        member, pin = team_store().regenerate_pin(team_id, member_id)
    except TeamError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _member(member, pin)


@router.post("/teams/{team_id}/scene", response_model=AdminTeam)
def post_scene(team_id: str, data: TeamScene) -> AdminTeam:
    """The team's scene becomes a scenario (a preset, or one of `team`'s,
    the team's own by default), or empty; the scene as it was is set aside."""
    team = _known(team_id)
    if data.team is not None:
        _known(data.team)
    interventions = _scenario(data.scenario, data.team or team_id) if data.scenario else []
    store.replace(interventions, team_id)
    return _team(team)


def known_phase(phase: str) -> str:
    """One of the pack's phases, or 422."""
    known = [p.id for p in active_pack().phases]
    if not known:
        raise HTTPException(status_code=422, detail="The pack has no phases")
    if phase not in known:
        raise HTTPException(status_code=422, detail=f"No phase {phase!r}: one of {', '.join(known)}")
    return phase


@router.get("/phases", response_model=list[PhaseSpec])
def get_phases() -> list[PhaseSpec]:
    """The pack's phases, in their usual order, with their views."""
    return active_pack().phases


@router.get("/views", response_model=list[ViewSpec])
def get_views() -> list[ViewSpec]:
    """The pack's views, with their labels: a team's screens show one of
    its phase's (`#view=<id>` in their URL)."""
    return active_pack().views


@router.put("/teams/{team_id}/phase", response_model=AdminTeam)
def put_team_phase(team_id: str, data: PhaseSet) -> AdminTeam:
    """The team's phase: any, after any (going back too). Its members'
    windows follow within seconds."""
    _known(team_id)
    return _team(team_store().set_phase(team_id, known_phase(data.phase)))


@router.put("/phase", response_model=list[AdminTeam])
def put_phase(data: PhaseSet) -> list[AdminTeam]:
    """Every team in the same phase."""
    phase = known_phase(data.phase)
    return [_team(team_store().set_phase(team.id, phase)) for team in team_store().teams()]


@router.get("/teams/{team_id}/export")
def get_export(team_id: str) -> dict:
    """The team (without its PINs), its scene, the scenes set aside, its
    notes and its scenarios: the file to hand back to the organisers."""
    team = _known(team_id)
    documents = lambda named: {name: json.loads(data) for name, data in named.items()}  # noqa: E731
    return {
        "site_id": SITE.site_id,
        "team": _team(team).model_dump(),
        "interventions": [i.model_dump() for i in store.list_interventions(team_id)],
        "set_aside": documents(store.set_aside(team_id)),
        "notes": [note.model_dump() for note in notes.list_notes(team_id)],
        "scenarios": documents(scenario_documents(library(team_id)[0])),
    }


@router.get("/status")
def get_status() -> dict:
    teams = team_store().teams()
    storage = state_storage()
    return {
        "site_id": SITE.site_id,
        "started": datetime.fromtimestamp(STARTED, UTC).isoformat(timespec="seconds"),
        "teams": len(teams),
        "members": sum(len(team.members) for team in teams),
        "restart_needed": restart_needed(),
        "storage": {
            "location": storage.location,
            "behind": storage.behind,
            "last_write": storage.last_write,
            "last_error": storage.last_error,
            "credentials": digitalhub.status(),
        },
        "throttle": {"pins": pin_throttle.status(), "manager": manager_throttle.status()},
        "memory": memory(),
    }


@router.post("/throttle/reset")
def post_throttle_reset(data: ThrottleReset) -> dict:
    """Forgets wrong PINs — an IP's, or everyone's — so that those held up
    can try again at once (e.g. a venue whose participants share an IP)."""
    pin_throttle.reset(data.ip)
    return pin_throttle.status()
