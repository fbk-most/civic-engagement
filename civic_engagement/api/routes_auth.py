"""Logging in (see access.py): open to everyone, as is /health."""

from fastapi import APIRouter, Depends, HTTPException, Request

from civic_engagement.access import Access, access, make_token, team_store, throttle, throttled
from civic_engagement.config import auth_mechanism
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import AuthInfo, LoginResponse, Me, PinLogin

router = APIRouter()


@router.get("/auth/info", response_model=AuthInfo)
def get_auth_info() -> AuthInfo:
    """The mechanism, and for `pin` the login field's hint."""
    if auth_mechanism() == "open":
        return AuthInfo(mechanism="open")
    return AuthInfo(mechanism="pin", example=active_pack().pin_format.example)


@router.post("/auth/pin", response_model=LoginResponse)
def post_pin(data: PinLogin, request: Request) -> LoginResponse:
    """A PIN for a token. 401 for a PIN that isn't one, 429 (with
    Retry-After) after too many."""
    if auth_mechanism() != "pin":
        raise HTTPException(status_code=404, detail="No PINs here: CIVIC_ENGAGEMENT_AUTH isn't pin")
    ip = throttled(request)
    found = team_store().by_pin(data.pin)
    if found is None:
        throttle.failed(ip)
        raise HTTPException(status_code=401, detail="Not a PIN")
    team, member = found
    who = Access(team=team.id, team_name=team.name, role=member.role, member_id=member.id, member_name=member.name)
    return LoginResponse(**who.me().model_dump(), token=make_token(member.id, member.pin_version))


@router.get("/auth/me", response_model=Me)
def get_me(who: Access = Depends(access)) -> Me:
    return who.me()
