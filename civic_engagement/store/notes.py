"""The teams' notes (the needs, in Bologna's words): a title and a text at
a point of the site. In memory, each team's mirrored to a JSON document
after each change, in the state's storage (store/storage.py):
data/<site>/notes/<team>.json, `{"<team>": [notes]}` — with the open
mechanism, its one team's, data/<site>/notes/default.json.

Apart from the session documents (store/state.py): their directory holds
the sessions set aside, found by their names' prefix. Not part of the
evaluation nor of the scenarios: a note changes nothing in the scene. Part
of the team: its export and its deletion (api/routes_admin.py), and its own
revision, which the windows ask for with the scene's (GET /session/revision).

Requests run in threads: every change and its write happen under a lock.
"""

import json
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone

from civic_engagement.config import SITE
from civic_engagement.models.schema import Note, NoteCreate, NoteUpdate
from civic_engagement.store.state import DEFAULT_TEAM
from civic_engagement.store.storage import Storage, state_storage


def notes_name(team: str) -> str:
    return f"{SITE.data_dir}/notes/{team}.json"


class NoteStore:
    def __init__(self, storage: Storage | None = None, name: Callable[[str], str] = notes_name) -> None:
        self._own_storage = storage
        self._name = name
        self._lock = threading.RLock()
        self._notes: dict[str, list[Note]] = {}
        # As the sessions' (SessionStore.revision): the boot part keeps a
        # restarted backend from repeating a revision a window has seen.
        self._boot = uuid.uuid4().hex[:8]
        self._changes: dict[str, int] = {}

    @property
    def _storage(self) -> Storage:
        return self._own_storage if self._own_storage is not None else state_storage()

    def revision(self, team: str = DEFAULT_TEAM) -> str:
        """Changes on every change to the team's notes."""
        with self._lock:
            return f"{self._boot}-{self._changes.get(team, 0)}"

    def list_notes(self, team: str = DEFAULT_TEAM) -> list[Note]:
        with self._lock:
            return [note.model_copy() for note in self._team(team)]

    def add_note(self, data: NoteCreate, team: str = DEFAULT_TEAM, author: str | None = None) -> Note:
        note = Note(
            id=f"note-{uuid.uuid4().hex[:12]}",
            title=data.title,
            text=data.text,
            geometry=data.geometry,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            created_by=author,
        )
        with self._lock:
            self._team(team).append(note)
            self._save(team)
        return note

    def update_note(self, note_id: str, data: NoteUpdate, team: str = DEFAULT_TEAM, author: str | None = None) -> Note | None:
        """Changes the fields given; None if the team has no such note."""
        changes = data.model_dump(exclude_none=True)
        with self._lock:
            for note in self._team(team):
                if note.id == note_id:
                    for key, value in changes.items():
                        setattr(note, key, value)
                    note.updated_by = author
                    self._save(team)
                    return note.model_copy()
        return None

    def delete_note(self, note_id: str, team: str = DEFAULT_TEAM) -> bool:
        with self._lock:
            notes = self._team(team)
            kept = [note for note in notes if note.id != note_id]
            if len(kept) == len(notes):
                return False
            self._notes[team] = kept
            self._save(team)
            return True

    def forget(self, team: str) -> None:
        """The team's notes deleted."""
        with self._lock:
            self._storage.delete(self._name(team))
            self._notes.pop(team, None)
            self._changes[team] = self._changes.get(team, 0) + 1

    def _team(self, team: str) -> list[Note]:
        with self._lock:
            if team not in self._notes:
                data = self._storage.read(self._name(team))
                notes = json.loads(data).get(team, []) if data is not None else []
                self._notes[team] = [Note(**note) for note in notes]
            return self._notes[team]

    def _save(self, team: str) -> None:
        self._changes[team] = self._changes.get(team, 0) + 1
        payload = {team: [note.model_dump() for note in self._notes[team]]}
        self._storage.write(self._name(team), json.dumps(payload, indent=2).encode())


notes = NoteStore()
