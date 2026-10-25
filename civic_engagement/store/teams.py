"""A site's teams and their members, with their PINs (the `pin` mechanism,
see access.py), in one document of the state's storage,
data/<site>/teams.json:

    {"teams": [{"id": "team-1", "name": "Team 1", "created_at": "...",
                "members": [{"id": "m-…", "name": "Anna", "role": "editor",
                             "pin": "<hmac>", "distinct": "", "pin_version": 1}]}]}

A PIN is kept as its HMAC (pins.py), and its distinct part in clear (the
part that differs between a site's PINs, if the format has one). It is
shown once, in the answer of the call that made it.
"""

import json
import re
import threading
import unicodedata
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from civic_engagement.pins import PinFormat, pin_hash
from civic_engagement.store.storage import Storage


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


@dataclass
class Team:
    id: str
    name: str
    created_at: str
    members: list[Member] = field(default_factory=list)


def _slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


class TeamStore:
    def __init__(self, storage: Storage, name: str, pin_format: PinFormat, secret: bytes) -> None:
        self._storage, self._name = storage, name
        self._format, self._secret = pin_format, secret
        self._lock = threading.RLock()
        self._teams: dict[str, Team] = {}
        data = storage.read(name)
        if data is not None:
            for team in json.loads(data)["teams"]:
                members = [Member(**m) for m in team.pop("members")]
                self._teams[team["id"]] = Team(**team, members=members)

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
            team = Team(team_id, name, datetime.now(timezone.utc).isoformat(timespec="seconds"))
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
            member = Member(f"m-{uuid.uuid4().hex[:10]}", name or "Viewers", role, hashed, distinct)
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
            member.pin_version += 1
            self._save()
            return member, pin

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
