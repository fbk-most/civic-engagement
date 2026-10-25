"""Who a request is: its team, member and role (the core's README, "Teams").

`CIVIC_ENGAGEMENT_AUTH` (config.auth_mechanism) chooses how:
- `open`, the default: no login; one team, `default`, everyone an editor.
- `pin`: a member types their PIN (`POST /auth/pin`) and gets a token, sent
  back on every call (`Authorization: Bearer <token>`). The teams, their
  members and PINs are the manager's (`/admin/*`, Basic credentials).

The routes and the store only see the answer (`Access`), through the
dependencies here: `access` on every route (create_app adds it to every
router), `editor` on the ones that change a team's scene or scenarios,
`manager` on the admin routes.

A token is signed, not stored: the member, their PIN's version and when it
was issued, with an HMAC over them. It survives restarts; a regenerated or
revoked PIN (a new version) invalidates it.

The environment, with `pin`:
- `CIVIC_ENGAGEMENT_PIN_SECRET`: the HMACs' secret, the same across
  deployments (changing it invalidates every PIN and token);
- `CIVIC_ENGAGEMENT_MANAGER_USER`, `CIVIC_ENGAGEMENT_MANAGER_PASSWORD`;
- `CIVIC_ENGAGEMENT_TRUSTED_PROXY` (see `client_ip`).
"""

import base64
import hashlib
import hmac
import logging
import math
import os
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from functools import cache

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from civic_engagement.config import SITE, auth_mechanism
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import MemberInfo, Me, TeamInfo
from civic_engagement.pins import checked
from civic_engagement.store.state import DEFAULT_TEAM
from civic_engagement.store.storage import state_storage
from civic_engagement.store.teams import TeamStore

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Access:
    team: str
    team_name: str
    role: str
    member_id: str | None = None
    member_name: str | None = None

    @property
    def author(self) -> str | None:
        """The name on the cards this member places or changes."""
        return self.member_name

    def me(self) -> Me:
        member = MemberInfo(id=self.member_id, name=self.member_name or "", role=self.role) if self.member_id else None
        return Me(team=TeamInfo(id=self.team, name=self.team_name), member=member, role=self.role)


OPEN = Access(team=DEFAULT_TEAM, team_name="", role="editor")


def _secret() -> bytes:
    secret = os.environ.get("CIVIC_ENGAGEMENT_PIN_SECRET", "")
    if len(secret) < 16:
        raise RuntimeError("CIVIC_ENGAGEMENT_AUTH=pin needs CIVIC_ENGAGEMENT_PIN_SECRET: at least 16 characters, random")
    return secret.encode()


@cache
def team_store() -> TeamStore:
    """The site's teams (the `pin` mechanism only)."""
    return TeamStore(state_storage(), f"{SITE.data_dir}/teams.json", checked(active_pack().pin_format), _secret())


# Tokens.


def _signature(payload: str) -> str:
    digest = hmac.new(_secret(), b"token\0" + payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def make_token(member_id: str, pin_version: int) -> str:
    payload = f"{member_id}.{pin_version}.{int(time.time())}"
    return f"{payload}.{_signature(payload)}"


def read_token(token: str) -> tuple[str, int] | None:
    """The member and PIN version a token was issued for, if it's genuine."""
    payload, _, signature = token.rpartition(".")
    if not payload or not hmac.compare_digest(signature.encode(), _signature(payload).encode()):
        return None
    member_id, version, _issued = payload.split(".")
    return member_id, int(version)


# Guessing PINs.


class Throttle:
    """Failed attempts (a PIN, the manager's password), per client IP and
    across the site. From an IP, after `free` failures within `window`
    seconds, each further failure — whenever it comes — makes the next
    attempt wait, doubling up to `longest` seconds; `memory` seconds without
    failures start it over
    (a success doesn't: one PIN known mustn't help guess the others). Across
    the site, beyond `ceiling` failures within `window`, every attempt
    waits — against guessing spread over many IPs. No lockout per team or
    PIN: that would let anyone shut a team out."""

    def __init__(
        self, free: int = 5, window: float = 60, longest: float = 300, memory: float = 3600, ceiling: int = 60,
        clock=time.monotonic,
    ):
        self.free, self.window, self.longest, self.memory = free, window, longest, memory
        self.ceiling, self._clock = ceiling, clock
        self._lock = threading.Lock()
        # ip → [failures within the window, level, blocked until, last failure]
        self._ips: dict[str, list] = {}
        self._site: deque[float] = deque()
        self._warned = -math.inf

    def wait(self, ip: str | None) -> float:
        """Seconds before an attempt from `ip` is allowed; 0 if it is."""
        now = self._clock()
        with self._lock:
            self._expire(now)
            waits = [0.0]
            if len(self._site) >= self.ceiling:
                waits.append(self._site[0] + self.window - now)
            if ip in self._ips:
                waits.append(self._ips[ip][2] - now)
            return max(waits)

    def failed(self, ip: str | None) -> None:
        now = self._clock()
        with self._lock:
            self._expire(now)
            self._site.append(now)
            if len(self._site) >= self.ceiling and now - self._warned > self.window:
                log.warning("%d failed attempts in %g s across the site: every attempt waits", len(self._site), self.window)
                self._warned = now
            if ip is None:
                return
            state = self._ips.setdefault(ip, [deque(), 0, now, now])
            state[0].append(now)
            state[3] = now
            # Once held up, every failure until the memory fades.
            if state[1] > 0 or len(state[0]) >= self.free:
                state[1] += 1
                state[2] = now + min(self.longest, 2 ** (state[1] - 1))

    def status(self) -> dict:
        now = self._clock()
        with self._lock:
            self._expire(now)
            return {
                "failures_last_window": len(self._site),
                "window_s": self.window,
                "ceiling": self.ceiling,
                "waiting_ips": sum(1 for _, _, until, _ in self._ips.values() if until > now),
            }

    def _expire(self, now: float) -> None:
        while self._site and self._site[0] <= now - self.window:
            self._site.popleft()
        for ip, (failures, _, until, last) in list(self._ips.items()):
            while failures and failures[0] <= now - self.window:
                failures.popleft()
            if last <= now - self.memory and until <= now:
                del self._ips[ip]


throttle = Throttle()


def client_ip(request: Request) -> str | None:
    """The client's IP, for the throttling. Behind a proxy (a gateway) the
    connection's address is the proxy's, and the client's is in
    `X-Forwarded-For` — trusted only if the proxy sets it:
    `CIVIC_ENGAGEMENT_TRUSTED_PROXY` = how many proxies append to it (1 for
    one gateway), or 0 for none (the connection's address is the client's).
    Unset: no IP — only the site-wide ceiling applies."""
    proxies = os.environ.get("CIVIC_ENGAGEMENT_TRUSTED_PROXY", "")
    if not proxies:
        return None
    if int(proxies) == 0:
        return request.client.host if request.client else None
    forwarded = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",") if part.strip()]
    return forwarded[-int(proxies)] if len(forwarded) >= int(proxies) else None


def throttled(request: Request) -> str | None:
    """The client's IP, or a 429 if it must wait."""
    ip = client_ip(request)
    wait = throttle.wait(ip)
    if wait > 0:
        raise HTTPException(status_code=429, detail="Too many attempts: wait", headers={"Retry-After": str(math.ceil(wait))})
    return ip


# The dependencies.


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def access(request: Request) -> Access:
    """The request's team, member and role; 401 without a valid token (pin)."""
    if auth_mechanism() == "open":
        return OPEN
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorised("A PIN is needed")
    issued = read_token(token)
    found = team_store().member(issued[0]) if issued else None
    if found is None or found[1].pin_version != issued[1]:
        raise _unauthorised("Not a valid token: the PIN was changed, or the member removed")
    team, member = found
    return Access(team=team.id, team_name=team.name, role=member.role, member_id=member.id, member_name=member.name)


def editor(who: Access = Depends(access)) -> Access:
    """`access`, for the routes that change a team's scene or scenarios; 403 for a viewer."""
    if who.role != "editor":
        raise HTTPException(status_code=403, detail="Viewers can't change the scene")
    return who


_basic = HTTPBasic(auto_error=False)


def manager(request: Request, credentials: HTTPBasicCredentials | None = Depends(_basic)) -> None:
    """The manager's Basic credentials (`CIVIC_ENGAGEMENT_MANAGER_USER`, `_PASSWORD`)."""
    ip = throttled(request)
    user = os.environ.get("CIVIC_ENGAGEMENT_MANAGER_USER", "")
    password = os.environ.get("CIVIC_ENGAGEMENT_MANAGER_PASSWORD", "")
    given = credentials or HTTPBasicCredentials(username="", password="")
    valid = secrets.compare_digest(given.username.encode(), user.encode()) & secrets.compare_digest(
        given.password.encode(), password.encode()
    )
    if not (user and password and valid):
        if credentials is not None:
            throttle.failed(ip)
        raise HTTPException(status_code=401, detail="The manager's credentials", headers={"WWW-Authenticate": "Basic"})


def check_configuration() -> None:
    """At startup, with `pin`: what's missing makes the app refuse to start,
    not fail on the first login."""
    if auth_mechanism() != "pin":
        return
    if not (os.environ.get("CIVIC_ENGAGEMENT_MANAGER_USER") and os.environ.get("CIVIC_ENGAGEMENT_MANAGER_PASSWORD")):
        raise RuntimeError("CIVIC_ENGAGEMENT_AUTH=pin needs CIVIC_ENGAGEMENT_MANAGER_USER and CIVIC_ENGAGEMENT_MANAGER_PASSWORD")
    team_store()
