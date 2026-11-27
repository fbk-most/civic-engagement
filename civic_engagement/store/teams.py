"""A site's teams and their members, with their PINs (the `pin` mechanism,
see access.py), in one document of the state's storage,
data/<site>/teams.json:

    {"teams": [{"id": "team-1", "name": "Team 1", "created_at": "...", "phase": "information",
                "members": [{"id": "m-…", "name": "Anna", "role": "editor",
                             "pin": "<hmac>", "distinct": "", "pin_version": 1,
                             "sealed": "<encrypted>"}]}]}

A PIN is kept as its HMAC (pins.py), to find its member; sealed, for the
manager to read it again (`pins`); and its distinct part in clear (the part
that differs between a site's PINs, if the format has one). Members from
before sealed PINs have none: their PINs can't be read, only regenerated.

A team's phase (phases.py) is one of the pack's; a team read without one,
or with one the pack no longer has, is in the pack's first. Without phases,
None.
"""

import json
import logging
import re
import threading
import unicodedata
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from civic_engagement.pins import PinFormat, pin_hash, seal, unseal
from civic_engagement.store.storage import Storage

log = logging.getLogger(__name__)


class TeamError(Exception):
    """A team or member that doesn't exist, or a change that can't be made."""


@dataclass
class Member:
    id: str
    name: str
    role: str
    pin: str
    distinct: str = ""
    pin_version: int = 1
    sealed: str = ""


@dataclass
class Team:
    id: str
    name: str
    created_at: str
    members: list[Member] = field(default_factory=list)
    phase: str | None = None


def _slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


class TeamStore:
    def __init__(
        self, storage: Storage, name: str, pin_format: PinFormat, secret: bytes, phases: list[str] | None = None
    ) -> None:
        """`phases`: the pack's phases' ids, in order (none: no phases)."""
        self._storage, self._name = storage, name
        self._format, self._secret = pin_format, secret
        self._phases = list(phases or [])
        self._lock = threading.RLock()
        self._teams: dict[str, Team] = {}
        data = storage.read(name)
        if data is not None:
            for team in json.loads(data)["teams"]:
                members = [Member(**m) for m in team.pop("members")]
                self._teams[team["id"]] = Team(**team, members=members)
        # Teams from before phases, or from a pack whose phases changed.
        for team in self._teams.values():
            if team.phase in self._phases:
                continue
            if team.phase is not None and self._phases:
                log.warning("Team %r in phase %r, which the pack doesn't have: in %r", team.id, team.phase, self._phases[0])
            team.phase = self._first_phase()

    # Reading.

    def teams(self) -> list[Team]:
        with self._lock:
            return list(self._teams.values())

    def team(self, team_id: str) -> Team:
        with self._lock:
            if team_id not in self._teams:
                raise TeamError(f"No team {team_id!r}")
            return self._teams[team_id]

    def member(self, member_id: str) -> tuple[Team, Member] | None:
        with self._lock:
            for team in self._teams.values():
                for member in team.members:
                    if member.id == member_id:
                        return team, member
        return None

    def by_pin(self, typed: str) -> tuple[Team, Member] | None:
        """The member whose PIN this is, typed in any way the format forgives."""
        normalised = self._format.normalise(typed)
        if not normalised:
            return None
        hashed = pin_hash(self._secret, normalised)
        with self._lock:
            for team in self._teams.values():
                for member in team.members:
                    if member.pin == hashed:
                        return team, member
        return None

    def pins(self, team_id: str) -> list[tuple[Member, str | None]]:
        """The team's members and their PINs, as handed out; None for a PIN
        that can't be read (see the module), or isn't the member's any more."""
        with self._lock:
            return [(m, self._pin_of(m)) for m in self.team(team_id).members]

    # Changing: each change written before it returns.

    def create_team(self, name: str) -> Team:
        name = name.strip()
        if not _slug(name):
            raise TeamError("A team needs a name with at least a letter or a digit")
        with self._lock:
            team_id, n = _slug(name), 1
            while team_id in self._teams:
                n += 1
                team_id = f"{_slug(name)}-{n}"
            team = Team(team_id, name, datetime.now(timezone.utc).isoformat(timespec="seconds"), phase=self._first_phase())
            self._teams[team_id] = team
            self._save()
            return team

    def rename_team(self, team_id: str, name: str) -> Team:
        name = name.strip()
        if not name:
            raise TeamError("A team needs a name")
        with self._lock:
            team = self.team(team_id)
            team.name = name
            self._save()
            return team

    def set_phase(self, team_id: str, phase: str) -> Team:
        """Any phase after any other: going back is allowed."""
        if phase not in self._phases:
            raise TeamError(f"No phase {phase!r}: " + (", ".join(self._phases) or "there are no phases"))
        with self._lock:
            team = self.team(team_id)
            team.phase = phase
            self._save()
            return team

    def delete_team(self, team_id: str) -> None:
        with self._lock:
            self.team(team_id)
            del self._teams[team_id]
            self._save()

    def add_member(self, team_id: str, name: str, role: str) -> tuple[Member, str]:
        """The new member, and its PIN in clear."""
        name = name.strip()
        if role == "editor" and not name:
            raise TeamError("An editor needs a name: it's shown on the cards they place")
        with self._lock:
            team = self.team(team_id)
            pin, hashed, distinct = self._new_pin()
            member_id = f"m-{uuid.uuid4().hex[:10]}"
            member = Member(member_id, name or "Viewers", role, hashed, distinct, sealed=seal(self._secret, member_id, pin))
            team.members.append(member)
            self._save()
            return member, pin

    def remove_member(self, team_id: str, member_id: str) -> None:
        with self._lock:
            team = self.team(team_id)
            kept = [m for m in team.members if m.id != member_id]
            if len(kept) == len(team.members):
                raise TeamError(f"No member {member_id!r} in team {team_id!r}")
            team.members = kept
            self._save()

    def regenerate_pin(self, team_id: str, member_id: str) -> tuple[Member, str]:
        """A new PIN for the member; the old one, and whoever logged in with it, is out."""
        with self._lock:
            member = self._member_of(team_id, member_id)
            member.pin, member.distinct = "", ""  # its own distinct part free again
            pin, member.pin, member.distinct = self._new_pin()
            member.sealed = seal(self._secret, member.id, pin)
            member.pin_version += 1
            self._save()
            return member, pin

    def _pin_of(self, member: Member) -> str | None:
        pin = unseal(self._secret, member.id, member.sealed)
        if pin is None or pin_hash(self._secret, self._format.normalise(pin)) != member.pin:
            if member.sealed:  # not one from before sealed PINs
                log.warning("Member %r's sealed PIN doesn't open, or isn't theirs: another secret?", member.id)
            return None
        return pin

    def _first_phase(self) -> str | None:
        return self._phases[0] if self._phases else None

    def _member_of(self, team_id: str, member_id: str) -> Member:
        for member in self.team(team_id).members:
            if member.id == member_id:
                return member
        raise TeamError(f"No member {member_id!r} in team {team_id!r}")

    def _new_pin(self) -> tuple[str, str, str]:
        members = [m for team in self._teams.values() for m in team.members]
        taken = {m.distinct for m in members if m.distinct}
        hashes = {m.pin for m in members}
        # The format avoids the distinct parts in use; the whole PIN is
        # checked here (for digits, the only check).
        for _ in range(1000):
            try:
                pin = self._format.generate(taken)
            except ValueError as error:
                raise TeamError(f"No PIN left to give: {error}") from error
            normalised = self._format.normalise(pin)
            hashed = pin_hash(self._secret, normalised)
            distinct = self._format.distinct(normalised)
            if hashed not in hashes and not (distinct and distinct in taken):
                return pin, hashed, distinct
        raise TeamError("No PIN left to give: the format is too small for the site's members")

    def _save(self) -> None:
        payload = {"teams": [asdict(team) for team in self._teams.values()]}
        self._storage.write(self._name, json.dumps(payload, indent=1).encode())
