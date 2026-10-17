"""In-memory intervention store, mirrored to a JSON file after each mutation.

No database: this is a single-facilitator, single-session PoC (see
project plan). The JSON mirror exists purely as a crash-safety net and as
the artifact to hand back to organizers after a workshop, not as the
runtime source of truth.
"""

import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from civic_twin.config import SITE
from civic_twin.models.schema import Intervention, InterventionCreate

# One session file per site — see config.SiteConfig.session_json_path.
SESSION_JSON_PATH = Path(SITE.session_json_path)
DEFAULT_SESSION_ID = "default"


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, list[Intervention]] = {}
        # Bumped on every change, so a window can ask "anything new?" without
        # fetching the scene (see `revision`).
        self._boot = uuid.uuid4().hex[:8]
        self._changes = 0
        self._load()
        # CIVIC_TWIN_SCENARIO=<id>: start from that saved scenario (see
        # store/scenarios.py) instead of the last session — at every start,
        # a --reload restart included; the session it replaces is set aside.
        startup = os.environ.get("CIVIC_TWIN_SCENARIO")
        if startup:
            from civic_twin.store.scenarios import read_scenario

            self.replace(read_scenario(startup)[1])

    @property
    def revision(self) -> str:
        """Changes on every change to the session. The boot part keeps a
        restarted backend (say with another session file loaded) from
        repeating a revision a window has already seen."""
        return f"{self._boot}-{self._changes}"

    def list_interventions(self, session_id: str = DEFAULT_SESSION_ID) -> list[Intervention]:
        return [i for i in self._sessions.get(session_id, []) if not i.deleted]

    def add_intervention(
        self, data: InterventionCreate, planted_year: int = 0, session_id: str = DEFAULT_SESSION_ID
    ) -> Intervention:
        intervention = Intervention(
            id=f"int-{uuid.uuid4().hex[:12]}",
            card_type=data.card_type,
            geometry=data.geometry,
            params=data.params,
            created_at=datetime.now(timezone.utc).isoformat(),
            replaces_element_id=data.replaces_element_id,
            planted_year=planted_year,
        )
        self._sessions.setdefault(session_id, []).append(intervention)
        self._save()
        return intervention

    def update_intervention(
        self, intervention_id: str, params: dict, session_id: str = DEFAULT_SESSION_ID
    ) -> bool:
        """Replaces params only — geometry (placement) is immutable once placed."""
        for intervention in self._sessions.get(session_id, []):
            if intervention.id == intervention_id and not intervention.deleted:
                intervention.params = params
                self._save()
                return True
        return False

    def delete_intervention(self, intervention_id: str, session_id: str = DEFAULT_SESSION_ID) -> bool:
        for intervention in self._sessions.get(session_id, []):
            if intervention.id == intervention_id:
                intervention.deleted = True
                self._save()
                return True
        return False

    def reset(self, session_id: str = DEFAULT_SESSION_ID) -> None:
        self._sessions[session_id] = []
        self._save()

    def replace(self, interventions: list[Intervention], session_id: str = DEFAULT_SESSION_ID) -> None:
        """The session becomes these interventions (a scenario loaded, or
        none to start afresh). The session file as it was is set aside next
        to it, timestamped, unless it held nothing."""
        if self.list_interventions(session_id) and SESSION_JSON_PATH.exists():
            kept = SESSION_JSON_PATH.with_name(f"session.{datetime.now():%Y%m%d-%H%M%S}.json")
            shutil.copy(SESSION_JSON_PATH, kept)
        self._sessions[session_id] = [i.model_copy(deep=True) for i in interventions]
        self._save()

    def _save(self) -> None:
        self._changes += 1
        SESSION_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            session_id: [i.model_dump() for i in interventions]
            for session_id, interventions in self._sessions.items()
        }
        SESSION_JSON_PATH.write_text(json.dumps(payload, indent=2))

    def _load(self) -> None:
        if not SESSION_JSON_PATH.exists():
            return
        payload = json.loads(SESSION_JSON_PATH.read_text())
        self._sessions = {
            session_id: [Intervention(**i) for i in interventions]
            for session_id, interventions in payload.items()
        }


store = SessionStore()
