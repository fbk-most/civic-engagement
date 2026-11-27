"""The team's notes (store/notes.py): read by any member, changed by an
editor in a phase that allows it. Each answer is the team's notes, with
their revision. A change touches nothing in the scene: no evaluation."""

from fastapi import APIRouter, Depends, HTTPException

from civic_engagement.access import Access, access, allowed
from civic_engagement.api.routes_interventions import OUTSIDE_BOUNDARY
from civic_engagement.config import SITE
from civic_engagement.geo_utils import within_boundary
from civic_engagement.models.schema import NoteCreate, NoteList, NoteUpdate
from civic_engagement.phases import NOTES_EDIT
from civic_engagement.store.notes import notes

router = APIRouter()

editing = allowed(NOTES_EDIT)


def _team_notes(team: str) -> NoteList:
    # The revision read first, as the scene's (scene.current_scene).
    revision = notes.revision(team)
    return NoteList(notes=notes.list_notes(team), revision=revision)


def _check_within(geometry: dict | None) -> None:
    # As the cards (routes_interventions.py): within a surveyed boundary.
    if geometry is not None and SITE.boundary_status == "surveyed" and not within_boundary(geometry, SITE.site_boundary_geojson):
        raise HTTPException(status_code=422, detail=OUTSIDE_BOUNDARY)


@router.get("/notes", response_model=NoteList)
def list_notes(who: Access = Depends(access)) -> NoteList:
    return _team_notes(who.team)


@router.post("/notes", response_model=NoteList)
def create_note(data: NoteCreate, who: Access = Depends(editing)) -> NoteList:
    _check_within(data.geometry)
    notes.add_note(data, team=who.team, author=who.author)
    return _team_notes(who.team)


@router.patch("/notes/{note_id}", response_model=NoteList)
def update_note(note_id: str, data: NoteUpdate, who: Access = Depends(editing)) -> NoteList:
    """Changes the title, the text, or moves the note (a new point)."""
    _check_within(data.geometry)
    if notes.update_note(note_id, data, team=who.team, author=who.author) is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return _team_notes(who.team)


@router.delete("/notes/{note_id}", response_model=NoteList)
def delete_note(note_id: str, who: Access = Depends(editing)) -> NoteList:
    if not notes.delete_note(note_id, team=who.team):
        raise HTTPException(status_code=404, detail="Note not found")
    return _team_notes(who.team)
