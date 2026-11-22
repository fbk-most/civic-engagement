"""In-memory intervention store, one session per team, each mirrored to a
JSON document after each change (in the state's storage, store/storage.py).
A session is the team's interventions and the values it chose for the
pack's uncontrollables (see domain.py), if the pack has any.

No database: memory is the working copy, the documents its safety net
across restarts and the artifact to hand back to the organisers after a
workshop. One process per site's state.

The documents (`session_name`), each `{"<team>": [interventions]}`, or
`{"<team>": {"interventions": [...], "uncontrollables": {...}}}` once the
team has chosen some uncontrollables (the first form reads as none chosen):
- with the open mechanism, its one team's, data/<site>/session.json, as
  ever;
- with teams (pin), data/<site>/sessions/<team>.json.

Requests run in threads: every change and its write happen under a lock.
"""

import json
import os
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import PurePosixPath

from civic_engagement.config import SITE, auth_mechanism
from civic_engagement.models.schema import Intervention, InterventionCreate, Uncontrollables
from civic_engagement.store.storage import Storage, state_storage

DEFAULT_TEAM = "default"


def session_name(team: str) -> str:
    """The team's session document — see config.SiteConfig.session_json_path."""
    if auth_mechanism() == "open":
        return SITE.session_json_path
    return f"{SITE.data_dir}/sessions/{team}.json"


class SessionStore:
    def __init__(self, storage: Storage | None = None, name: str | Callable[[str], str] = session_name) -> None:
        self._own_storage = storage
        self._name = (lambda team: name) if isinstance(name, str) else name
        self._lock = threading.RLock()
        self._sessions: dict[str, list[Intervention]] = {}
        self._uncontrollables: dict[str, Uncontrollables] = {}
        # Bumped on every change to a team's session, so its windows can ask
        # "anything new?" without fetching the scene (see `revision`).
        self._boot = uuid.uuid4().hex[:8]
        self._changes: dict[str, int] = {}
        # CIVIC_ENGAGEMENT_SCENARIO=<id>: start the open mechanism's team
        # from that saved scenario (see store/scenarios.py) instead of the
        # last session — at every start, a --reload restart included; the
        # session it replaces is set aside.
        startup = os.environ.get("CIVIC_ENGAGEMENT_SCENARIO")
        if startup and auth_mechanism() == "open":
            from civic_engagement.store.scenarios import read_scenario

            info, interventions = read_scenario(startup)
            self.replace(interventions, uncontrollables=info.uncontrollables)

    @property
    def _storage(self) -> Storage:
        return self._own_storage if self._own_storage is not None else state_storage()

    def revision(self, team: str = DEFAULT_TEAM) -> str:
        """Changes on every change to the team's session. The boot part keeps
        a restarted backend (say with another session file loaded) from
        repeating a revision a window has already seen."""
        with self._lock:
            return f"{self._boot}-{self._changes.get(team, 0)}"

    def load(self, team: str) -> None:
        """Reads the team's session, if not already in memory."""
        self._session(team)

    def list_interventions(self, team: str = DEFAULT_TEAM) -> list[Intervention]:
        with self._lock:
            return [i for i in self._session(team) if not i.deleted]

    def uncontrollables(self, team: str = DEFAULT_TEAM) -> Uncontrollables:
        """The values the team chose (the domain pack fills in the rest:
        `DomainPack.settled`)."""
        with self._lock:
            self._session(team)
            return dict(self._uncontrollables.get(team, {}))

    def set_uncontrollables(self, values: Uncontrollables, team: str = DEFAULT_TEAM) -> None:
        with self._lock:
            self._session(team)
            self._uncontrollables[team] = dict(values)
            self._save(team)

    def add_intervention(
        self, data: InterventionCreate, planted_year: int = 0, team: str = DEFAULT_TEAM, author: str | None = None
    ) -> Intervention:
        intervention = Intervention(
            id=f"int-{uuid.uuid4().hex[:12]}",
            card_type=data.card_type,
            geometry=data.geometry,
            params=data.params,
            created_at=datetime.now(timezone.utc).isoformat(),
            replaces_element_id=data.replaces_element_id,
            planted_year=planted_year,
            created_by=author,
        )
        with self._lock:
            self._session(team).append(intervention)
            self._save(team)
        return intervention

    def update_intervention(
        self, intervention_id: str, params: dict, team: str = DEFAULT_TEAM, author: str | None = None
    ) -> bool:
        """Replaces params only — geometry (placement) is immutable once placed."""
        with self._lock:
            for intervention in self._session(team):
                if intervention.id == intervention_id and not intervention.deleted:
                    intervention.params = params
                    intervention.updated_by = author
                    self._save(team)
                    return True
        return False

    def delete_intervention(self, intervention_id: str, team: str = DEFAULT_TEAM) -> bool:
        with self._lock:
            for intervention in self._session(team):
                if intervention.id == intervention_id:
                    intervention.deleted = True
                    self._save(team)
                    return True
        return False

    def replace(
        self, interventions: list[Intervention], team: str = DEFAULT_TEAM, uncontrollables: Uncontrollables | None = None
    ) -> None:
        """The team's session becomes these interventions (a scenario loaded,
        or none to start afresh), and these uncontrollables (a scenario's;
        None keeps the team's). The session document as it was is set aside
        next to it, timestamped, unless it held no interventions."""
        with self._lock:
            if self.list_interventions(team):
                previous = self._storage.read(self._name(team))
                if previous is not None:
                    self._storage.write(self._set_aside_name(team, f"{datetime.now():%Y%m%d-%H%M%S}"), previous)
            self._sessions[team] = [i.model_copy(deep=True) for i in interventions]
            if uncontrollables is not None:
                self._uncontrollables[team] = dict(uncontrollables)
            self._save(team)

    def set_aside(self, team: str) -> dict[str, bytes]:
        """The team's sessions set aside, by name."""
        path = PurePosixPath(self._name(team))
        prefix = f"{path.stem}."
        return {
            name: self._storage.read(f"{path.parent}/{name}") or b""
            for name in self._storage.names(str(path.parent))
            if name.startswith(prefix) and name != path.name
        }

    def forget(self, team: str) -> None:
        """The team's session, and those set aside, deleted."""
        with self._lock:
            path = PurePosixPath(self._name(team))
            for name in self.set_aside(team):
                self._storage.delete(f"{path.parent}/{name}")
            self._storage.delete(path.as_posix())
            self._sessions.pop(team, None)
            self._uncontrollables.pop(team, None)
            self._changes[team] = self._changes.get(team, 0) + 1

    def _set_aside_name(self, team: str, stamp: str) -> str:
        path = PurePosixPath(self._name(team))
        return path.with_name(f"{path.stem}.{stamp}.json").as_posix()

    def _session(self, team: str) -> list[Intervention]:
        with self._lock:
            if team not in self._sessions:
                data = self._storage.read(self._name(team))
                session = json.loads(data).get(team, []) if data is not None else []
                if isinstance(session, list):
                    session = {"interventions": session}
                self._sessions[team] = [Intervention(**i) for i in session.get("interventions", [])]
                self._uncontrollables[team] = dict(session.get("uncontrollables", {}))
            return self._sessions[team]

    def _save(self, team: str) -> None:
        self._changes[team] = self._changes.get(team, 0) + 1
        interventions = [i.model_dump() for i in self._sessions[team]]
        uncontrollables = self._uncontrollables.get(team)
        # The first form while there's nothing else: what an older core
        # reads, and a pack without uncontrollables always writes.
        session = {"interventions": interventions, "uncontrollables": uncontrollables} if uncontrollables else interventions
        payload = {team: session}
        self._storage.write(self._name(team), json.dumps(payload, indent=2).encode())


store = SessionStore()
